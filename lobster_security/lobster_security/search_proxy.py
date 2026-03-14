"""Controlled search proxy with sanitized fetching."""

from __future__ import annotations

import json
import re
import urllib.request
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Dict, List, Tuple
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from .audit import AuditLogger, summarize_output
from .errors import PolicyError
from .network_guard import NetworkGuard


TRACKING_PARAMS = {"utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"}
PROMPT_INJECTION_RE = re.compile(
    r"(ignore previous instructions|reveal secrets|run this command|download and execute)",
    re.IGNORECASE,
)


class SanitizingHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.title = ""
        self.text_parts: List[str] = []
        self.code_parts: List[str] = []
        self._capture = "text"
        self._skip_depth = 0

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in {"script", "iframe", "style", "form"}:
            self._skip_depth += 1
            return
        if tag in {"pre", "code"}:
            self._capture = "code"

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in {"script", "iframe", "style", "form"} and self._skip_depth:
            self._skip_depth -= 1
            return
        if tag in {"pre", "code"}:
            self._capture = "text"

    def handle_data(self, data):
        if self._skip_depth:
            return
        text = " ".join(data.split())
        if not text:
            return
        if not self.title:
            self.title = text[:200]
        if self._capture == "code":
            self.code_parts.append(text)
        else:
            self.text_parts.append(text)


class SearchProxyService:
    def __init__(self, proxy_config: Dict, network_config: Dict, audit_logger: AuditLogger) -> None:
        self.proxy_config = proxy_config
        self.network_guard = NetworkGuard({**network_config, "enabled": True})
        self.audit_logger = audit_logger

    def search(self, query: str) -> List[Dict[str, str]]:
        backend = self.proxy_config.get("search_backend", {})
        mode = backend.get("mode", "disabled")
        if mode == "disabled":
            raise PolicyError("search backend disabled by policy")
        if mode == "mock":
            results = []
            for item in backend.get("mock_results", []):
                haystack = f"{item.get('title', '')} {item.get('snippet', '')}".lower()
                if query.lower() in haystack:
                    results.append(
                        {
                            "title": str(item.get("title", "")),
                            "snippet": str(item.get("snippet", "")),
                            "url": str(item.get("url", "")),
                        }
                    )
            self.audit_logger.write_audit_log({"event": "search", "query": query, "result_count": len(results)})
            return results
        if mode != "remote_json":
            raise PolicyError(f"unsupported search backend mode: {mode}")

        backend_url = str(backend.get("backend_url", ""))
        decision = self.network_guard.guard_http_request({"url": backend_url, "method": "POST"})
        if not decision.allowed:
            raise PolicyError(decision.reason)
        req = urllib.request.Request(
            backend_url,
            method="POST",
            data=json.dumps({"query": query}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=int(self.proxy_config.get("timeout_seconds", 10))) as response:
            payload = json.loads(response.read().decode("utf-8"))
        results = []
        for item in payload:
            raw_url = str(item.get("url", ""))
            if not raw_url:
                continue
            candidate_url = self._strip_tracking(raw_url)
            if not self._is_fetchable_result_url(candidate_url):
                continue
            results.append(
                {
                    "title": str(item.get("title", "")),
                    "snippet": str(item.get("snippet", "")),
                    "url": candidate_url,
                }
            )
        self.audit_logger.write_audit_log({"event": "search", "query": query, "result_count": len(results), "backend": backend_url})
        return results

    def fetch(self, url: str) -> Dict[str, str]:
        cleaned_url = self._strip_tracking(url)
        decision = self.network_guard.guard_http_request({"url": cleaned_url, "method": "GET"})
        if not decision.allowed:
            raise PolicyError(decision.reason)
        allowed_fetch = set(str(host).lower() for host in self.proxy_config.get("allowed_fetch_domains", []))
        if allowed_fetch and decision.normalized_host not in allowed_fetch and not any(
            decision.normalized_host.endswith("." + host) for host in allowed_fetch
        ):
            raise PolicyError("fetch target is not in proxy fetch allowlist")
        req = urllib.request.Request(cleaned_url, method="GET", headers={"User-Agent": "lobster-security-proxy/0.1"})
        with urllib.request.urlopen(req, timeout=int(self.proxy_config.get("timeout_seconds", 10))) as response:
            headers = {k: v for k, v in response.headers.items()}
            self.network_guard.assert_content_policy(urlparse(cleaned_url), headers)
            body = response.read(int(self.proxy_config.get("max_fetch_chars", 25000)) * 4).decode("utf-8", errors="ignore")
        parser = SanitizingHTMLParser()
        parser.feed(body)
        title = parser.title or cleaned_url
        text = "\n".join(parser.text_parts + [f"```{code}```" for code in parser.code_parts])
        patterns = self.proxy_config.get("prompt_injection_patterns", [])
        if patterns:
            text = re.compile("|".join(re.escape(pat) for pat in patterns), re.IGNORECASE).sub(
                "[FILTERED_PROMPT_INJECTION]",
                text,
            )
        else:
            text = PROMPT_INJECTION_RE.sub("[FILTERED_PROMPT_INJECTION]", text)
        max_chars = int(self.proxy_config.get("max_fetch_chars", 25000))
        sanitized = text[:max_chars]
        result = {"title": title[:200], "url": cleaned_url, "text": sanitized}
        self.audit_logger.write_audit_log({"event": "fetch", "url": cleaned_url, "summary": summarize_output(sanitized, 300)})
        return result

    def _strip_tracking(self, url: str) -> str:
        if not self.proxy_config.get("remove_tracking_params", True):
            return url
        parsed = urlparse(url)
        query = [(k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True) if k.lower() not in TRACKING_PARAMS]
        return urlunparse(parsed._replace(query=urlencode(query)))

    def _is_fetchable_result_url(self, url: str) -> bool:
        decision = self.network_guard.guard_http_request({"url": url, "method": "GET"})
        if not decision.allowed:
            return False
        allowed_fetch = set(str(host).lower() for host in self.proxy_config.get("allowed_fetch_domains", []))
        if not allowed_fetch:
            return True
        return decision.normalized_host in allowed_fetch or any(
            decision.normalized_host.endswith("." + host) for host in allowed_fetch
        )


class SearchProxyRequestHandler(BaseHTTPRequestHandler):
    service: SearchProxyService = None  # type: ignore[assignment]

    def do_POST(self):
        try:
            payload = self._read_json()
            if self.path == "/search":
                result = self.service.search(str(payload.get("query", "")))
                self._write_json(200, result)
                return
            if self.path == "/fetch":
                result = self.service.fetch(str(payload.get("url", "")))
                self._write_json(200, result)
                return
            self._write_json(404, {"error": "not_found"})
        except PolicyError as exc:
            self._write_json(403, {"error": str(exc)})
        except Exception as exc:
            self._write_json(500, {"error": str(exc)})

    def log_message(self, *_args):
        return

    def _read_json(self) -> Dict:
        content_length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(content_length)
        return json.loads(raw.decode("utf-8") or "{}")

    def _write_json(self, status: int, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def run_search_proxy(proxy_config: Dict, network_config: Dict, audit_root: str) -> None:
    audit_logger = AuditLogger(audit_root)
    SearchProxyRequestHandler.service = SearchProxyService(proxy_config, network_config, audit_logger)
    host = str(proxy_config.get("bind_host", "127.0.0.1"))
    port = int(proxy_config.get("port", 8787))
    server = ThreadingHTTPServer((host, port), SearchProxyRequestHandler)
    server.serve_forever()

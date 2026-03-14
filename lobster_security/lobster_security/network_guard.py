"""Strict outbound network validation."""

from __future__ import annotations

import ipaddress
import mimetypes
import socket
from dataclasses import dataclass
from fnmatch import fnmatch
from typing import Dict, Iterable, Optional
from urllib.parse import ParseResult, urlparse

from .errors import PolicyError
from .models import NetworkDecision


BINARY_EXTENSIONS = {
    ".dmg",
    ".pkg",
    ".zip",
    ".tar",
    ".gz",
    ".tgz",
    ".exe",
    ".bin",
    ".app",
    ".msi",
    ".iso",
}


def _normalize_hostname(hostname: str) -> str:
    return hostname.strip().rstrip(".").lower().encode("idna").decode("ascii")


def _is_ip_literal(hostname: str) -> bool:
    try:
        ipaddress.ip_address(hostname)
        return True
    except ValueError:
        return False


def _is_private_or_loopback(hostname: str, resolve_dns: bool) -> bool:
    try:
        candidate = ipaddress.ip_address(hostname)
        return candidate.is_private or candidate.is_loopback or candidate.is_link_local
    except ValueError:
        pass
    if not resolve_dns:
        return False
    try:
        for family, _, _, _, sockaddr in socket.getaddrinfo(hostname, None):
            host = sockaddr[0]
            ip = ipaddress.ip_address(host)
            if ip.is_private or ip.is_loopback or ip.is_link_local:
                return True
    except socket.gaierror:
        return False
    return False


def _match_domain(hostname: str, patterns: Iterable[str]) -> Optional[str]:
    for pattern in patterns:
        normalized_pattern = pattern.lower()
        if normalized_pattern == "*":
            return pattern
        if normalized_pattern.startswith("*."):
            suffix = normalized_pattern[2:]
            if hostname == suffix or hostname.endswith("." + suffix):
                return pattern
        if fnmatch(hostname, normalized_pattern):
            return pattern
        if hostname == normalized_pattern:
            return pattern
        if hostname.endswith("." + normalized_pattern):
            return pattern
    return None


class NetworkGuard:
    def __init__(self, config: Dict) -> None:
        self.config = config

    def validate_domain(self, hostname: str) -> NetworkDecision:
        normalized_host = _normalize_hostname(hostname)
        if not normalized_host:
            return NetworkDecision(False, "", normalized_host, "empty hostname")
        if self.config.get("block_ip_literals", True) and _is_ip_literal(normalized_host):
            return NetworkDecision(False, "", normalized_host, "IP literals are blocked", "ip_literal")
        if self.config.get("block_localhost", True) and normalized_host in {"localhost", "localhost.localdomain"}:
            return NetworkDecision(False, "", normalized_host, "localhost is blocked", "localhost")
        if self.config.get("block_private_networks", True) and _is_private_or_loopback(normalized_host, self.config.get("resolve_dns", True)):
            return NetworkDecision(False, "", normalized_host, "private or loopback network is blocked", "private_network")

        blocked_match = _match_domain(normalized_host, self.config.get("blocked_domains", []))
        allowed_match = _match_domain(normalized_host, self.config.get("allowed_domains", []))
        mode = self.config.get("mode", "allowlist")

        if blocked_match and not allowed_match:
            return NetworkDecision(False, "", normalized_host, "blocked by explicit domain rule", blocked_match)
        if mode == "allowlist" and not allowed_match:
            return NetworkDecision(False, "", normalized_host, "hostname not present in allowlist", "allowlist")
        return NetworkDecision(True, "", normalized_host, "hostname allowed", allowed_match or "allowlist")

    def validate_url(self, url: str) -> NetworkDecision:
        parsed = urlparse(url)
        if parsed.scheme.lower() not in set(self.config.get("allowed_protocols", ["https"])):
            return NetworkDecision(False, url, "", f"protocol {parsed.scheme} is not allowed", "protocol")
        if not parsed.hostname:
            return NetworkDecision(False, url, "", "URL must include a hostname", "hostname")
        host_decision = self.validate_domain(parsed.hostname)
        return NetworkDecision(host_decision.allowed, url, host_decision.normalized_host, host_decision.reason, host_decision.matched_rule)

    def guard_http_request(self, request: Dict) -> NetworkDecision:
        if not self.config.get("enabled", False):
            return NetworkDecision(False, request.get("url", ""), "", "network access disabled by default", "disabled")
        url = request.get("url", "")
        decision = self.validate_url(url)
        if not decision.allowed:
            return decision
        if self.config.get("allow_binary_downloads", False) is False:
            path = urlparse(url).path.lower()
            if any(path.endswith(ext) for ext in BINARY_EXTENSIONS):
                return NetworkDecision(False, url, decision.normalized_host, "binary download blocked by extension", "binary_extension")
        return decision

    def assert_content_policy(self, parsed: ParseResult, headers: Dict[str, str]) -> None:
        if not self.config.get("allow_binary_downloads", False):
            content_type = headers.get("Content-Type", "").split(";")[0].strip().lower()
            guessed_type = mimetypes.guess_type(parsed.path)[0]
            effective_type = content_type or guessed_type or ""
            if effective_type and not (
                effective_type.startswith("text/")
                or effective_type in {"application/json", "application/xml", "application/xhtml+xml"}
            ):
                raise PolicyError(f"blocked binary content type: {effective_type}")
        max_content_length = int(self.config.get("max_content_length", 1048576))
        content_length = headers.get("Content-Length")
        if content_length and int(content_length) > max_content_length:
            raise PolicyError(f"content-length {content_length} exceeds limit {max_content_length}")


def validate_domain(hostname: str) -> NetworkDecision:
    return NetworkGuard({"mode": "allowlist", "allowed_domains": [], "blocked_domains": ["*"]}).validate_domain(hostname)


def validate_url(url: str) -> NetworkDecision:
    return NetworkGuard({"enabled": False, "allowed_protocols": ["https"], "blocked_domains": ["*"]}).validate_url(url)


def guard_http_request(request: Dict) -> NetworkDecision:
    return NetworkGuard({"enabled": False, "allowed_protocols": ["https"], "blocked_domains": ["*"]}).guard_http_request(request)

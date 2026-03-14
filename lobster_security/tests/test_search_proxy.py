import tempfile
import unittest
from unittest.mock import patch

from lobster_security.audit import AuditLogger
from lobster_security.search_proxy import SearchProxyService
from lobster_security.yamlish import load_yaml_subset


class YamlishAndProxyTests(unittest.TestCase):
    def test_yaml_subset_parses_list_of_dicts(self):
        payload = load_yaml_subset(
            """
proxy:
  search_backend:
    mode: mock
    mock_results:
      - title: Lark
        snippet: Secure workspace
        url: https://example.com/lark
"""
        )
        item = payload["proxy"]["search_backend"]["mock_results"][0]
        self.assertEqual(item["title"], "Lark")
        self.assertEqual(item["url"], "https://example.com/lark")

    def test_mock_search_backend(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = SearchProxyService(
                {
                    "timeout_seconds": 5,
                    "max_fetch_chars": 2000,
                    "remove_tracking_params": True,
                    "search_backend": {
                        "mode": "mock",
                        "mock_results": [
                            {"title": "Lark Guide", "snippet": "Secure setup", "url": "https://example.com/lark"}
                        ],
                    },
                },
                {
                    "enabled": True,
                    "mode": "allowlist",
                    "allowed_domains": ["example.com"],
                    "blocked_domains": ["*"],
                    "allowed_protocols": ["https"],
                    "block_ip_literals": True,
                    "block_localhost": True,
                    "block_private_networks": True,
                    "resolve_dns": False,
                    "allow_binary_downloads": False,
                    "max_content_length": 1024,
                },
                AuditLogger(tmp),
            )
            results = service.search("lark")
            self.assertEqual(len(results), 1)

    def test_remote_search_filters_disallowed_result_urls(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = SearchProxyService(
                {
                    "timeout_seconds": 5,
                    "max_fetch_chars": 2000,
                    "remove_tracking_params": True,
                    "allowed_fetch_domains": ["example.com"],
                    "search_backend": {
                        "mode": "remote_json",
                        "backend_url": "https://search.example.com/query",
                    },
                },
                {
                    "enabled": True,
                    "mode": "allowlist",
                    "allowed_domains": ["search.example.com", "example.com"],
                    "blocked_domains": ["*"],
                    "allowed_protocols": ["https"],
                    "block_ip_literals": True,
                    "block_localhost": True,
                    "block_private_networks": True,
                    "resolve_dns": False,
                    "allow_binary_downloads": False,
                    "max_content_length": 1024,
                },
                AuditLogger(tmp),
            )

            class FakeResponse:
                def __enter__(self):
                    return self

                def __exit__(self, exc_type, exc, tb):
                    return False

                def read(self):
                    return (
                        b'[{"title":"Allowed","snippet":"ok","url":"https://example.com/page?utm_source=x"},'
                        b'{"title":"Blocked host","snippet":"no","url":"https://evil.example.net/page"},'
                        b'{"title":"Blocked protocol","snippet":"no","url":"http://example.com/insecure"}]'
                    )

            with patch("urllib.request.urlopen", return_value=FakeResponse()):
                results = service.search("allowed")

            self.assertEqual(
                results,
                [{"title": "Allowed", "snippet": "ok", "url": "https://example.com/page"}],
            )

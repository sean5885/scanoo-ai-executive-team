import unittest

from lobster_security.network_guard import NetworkGuard


class NetworkGuardTests(unittest.TestCase):
    def setUp(self):
        self.guard = NetworkGuard(
            {
                "enabled": True,
                "mode": "allowlist",
                "allowed_domains": ["open.larksuite.com", "larksuite.com"],
                "blocked_domains": ["*"],
                "allowed_protocols": ["https"],
                "block_ip_literals": True,
                "block_localhost": True,
                "block_private_networks": True,
                "resolve_dns": False,
                "allow_binary_downloads": False,
                "max_content_length": 1024,
            }
        )

    def test_allows_allowed_domain(self):
        decision = self.guard.validate_url("https://open.larksuite.com/open-apis")
        self.assertTrue(decision.allowed)

    def test_blocks_localhost(self):
        decision = self.guard.validate_url("https://localhost:8000/")
        self.assertFalse(decision.allowed)

    def test_blocks_binary_extension(self):
        decision = self.guard.guard_http_request({"url": "https://open.larksuite.com/file.zip"})
        self.assertFalse(decision.allowed)

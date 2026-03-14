import json
import tempfile
import unittest
from pathlib import Path

from lobster_security.wrapper import SecureAgentWrapper


class WrapperTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.workspace = root / "lobster-workspace"
        self.workspace.mkdir()
        self.tmp_root = root / "tmp"
        self.tmp_root.mkdir()
        self.config_dir = root / "config"
        self.config_dir.mkdir()
        (self.config_dir / "policy.yaml").write_text(
            f"""
policy:
  workspace_root: {self.workspace}
  temp_root: {self.tmp_root}
  allow_commands:
    - python3
  allow_subcommands:
    python3:
      - -m unittest
approval:
  mode: strict
  interactive: false
""".strip(),
            encoding="utf-8",
        )
        (self.config_dir / "network_policy.yaml").write_text(
            f"""
network:
  enabled: false
  mode: allowlist
  allowed_domains:
    - example.com
  blocked_domains:
    - "*"
  allowed_protocols:
    - https
  block_ip_literals: true
  block_localhost: true
  block_private_networks: true
  resolve_dns: false
  allow_binary_downloads: false
  max_content_length: 1024
proxy:
  bind_host: 127.0.0.1
  port: 8787
  timeout_seconds: 5
  max_fetch_chars: 5000
  remove_tracking_params: true
  allowed_fetch_domains:
    - example.com
  search_backend:
    mode: mock
    mock_results:
      - title: Lark
        snippet: Lark knowledge
        url: https://example.com/lark
audit:
  root: {self.workspace}/.lobster-security/audit
snapshot:
  root: {self.workspace}/.lobster-security/snapshots
""".strip(),
            encoding="utf-8",
        )
        self.wrapper = SecureAgentWrapper(str(self.config_dir))

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_start_and_finish_task(self):
        task = self.wrapper.start_task("secure-task")
        result = self.wrapper.execute_action(task.task_id, {"type": "write_file", "path": "notes.txt", "content": "ok"})
        self.assertTrue(result["written"])
        diff = self.wrapper.finish_task(task.task_id, success=True)
        self.assertIn("notes.txt", diff["added"])

    def test_network_blocked(self):
        task = self.wrapper.start_task("network")
        with self.assertRaises(Exception):
            self.wrapper.execute_action(task.task_id, {"type": "http_request", "url": "https://example.com"})

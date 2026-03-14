import json
import tempfile
import unittest
from pathlib import Path

from lobster_security.audit import AuditLogger, redact_secrets


class AuditTests(unittest.TestCase):
    def test_redact_secrets(self):
        text = "Bearer abc123 password=hunter2 sk-123456789012345"
        redacted = redact_secrets(text)
        self.assertIn("[REDACTED_TOKEN]", redacted)
        self.assertIn("[REDACTED_PASSWORD]", redacted)
        self.assertIn("[REDACTED_API_KEY]", redacted)

    def test_write_audit_log(self):
        with tempfile.TemporaryDirectory() as tmp:
            logger = AuditLogger(tmp)
            path = Path(tmp) / "tasks" / "x.jsonl"
            logger.write_audit_log({"event": "test", "stdout": "Bearer abc123"}, path)
            payload = json.loads(path.read_text(encoding="utf-8").strip())
            self.assertEqual(payload["event"], "test")
            self.assertIn("[REDACTED_TOKEN]", payload["stdout"])

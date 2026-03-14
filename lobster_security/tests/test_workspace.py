import os
import tempfile
import unittest
from pathlib import Path

from lobster_security.workspace import WorkspaceSandbox


class WorkspaceSandboxTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        base = Path(self.temp_dir.name)
        self.workspace = base / "workspace"
        self.tmp_root = base / "tmp"
        self.workspace.mkdir()
        self.tmp_root.mkdir()
        self.sandbox = WorkspaceSandbox(str(self.workspace), str(self.tmp_root))

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_allows_workspace_read(self):
        target = self.workspace / "notes.txt"
        target.write_text("ok", encoding="utf-8")
        decision = self.sandbox.validate_read_path(str(target))
        self.assertTrue(decision.allowed)

    def test_denies_sensitive_name(self):
        decision = self.sandbox.validate_write_path(str(self.workspace / ".env"))
        self.assertFalse(decision.allowed)

    def test_denies_path_escape(self):
        outside = Path(self.temp_dir.name) / "other" / "secrets.txt"
        outside.parent.mkdir()
        outside.write_text("x", encoding="utf-8")
        escape = self.workspace / ".." / "other" / "secrets.txt"
        decision = self.sandbox.validate_read_path(str(escape))
        self.assertFalse(decision.allowed)

    def test_denies_symlink_escape(self):
        outside = Path(self.temp_dir.name) / "outside.txt"
        outside.write_text("bad", encoding="utf-8")
        link = self.workspace / "link.txt"
        link.symlink_to(outside)
        decision = self.sandbox.validate_read_path(str(link))
        self.assertFalse(decision.allowed)

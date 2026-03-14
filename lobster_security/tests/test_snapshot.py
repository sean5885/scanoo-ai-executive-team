import tempfile
import unittest
from pathlib import Path

from lobster_security.snapshot import SnapshotManager


class SnapshotTests(unittest.TestCase):
    def test_snapshot_diff_and_rollback(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "workspace"
            snapshots = root / "snapshots"
            workspace.mkdir()
            (workspace / "a.txt").write_text("one", encoding="utf-8")
            manager = SnapshotManager(str(snapshots), str(workspace))
            manager.create_snapshot("task1")
            (workspace / "a.txt").write_text("two", encoding="utf-8")
            (workspace / "b.txt").write_text("new", encoding="utf-8")
            diff = manager.diff_snapshot("task1")
            self.assertIn("a.txt", diff["changed"])
            self.assertIn("b.txt", diff["added"])
            manager.rollback_snapshot("task1")
            self.assertEqual((workspace / "a.txt").read_text(encoding="utf-8"), "one")
            self.assertFalse((workspace / "b.txt").exists())

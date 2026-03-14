import tempfile
import unittest
from pathlib import Path

from lobster_security.command_policy import CommandPolicyEngine
from lobster_security.workspace import WorkspaceSandbox


class CommandPolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        base = Path(self.temp_dir.name)
        workspace = base / "workspace"
        tmp_root = base / "tmp"
        workspace.mkdir()
        tmp_root.mkdir()
        self.engine = CommandPolicyEngine(
            {
                "allow_commands": ["ls", "cat", "python3", "npm"],
                "allow_subcommands": {"python3": ["-m unittest"], "npm": ["run test"]},
                "max_bulk_file_writes_without_approval": 10,
            },
            WorkspaceSandbox(str(workspace), str(tmp_root)),
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_denies_sudo(self):
        decision = self.engine.classify_command("sudo ls")
        self.assertEqual(decision.classification, "deny")

    def test_requires_approval_for_install(self):
        decision = self.engine.classify_command("pip install requests")
        self.assertEqual(decision.classification, "approval_required")

    def test_allows_unit_tests(self):
        decision = self.engine.classify_command("python3 -m unittest")
        self.assertEqual(decision.classification, "allow")

    def test_denies_shell_control_operators(self):
        decision = self.engine.classify_command("ls && pwd")
        self.assertEqual(decision.classification, "deny")
        self.assertIn("shell control operators", decision.reason)

    def test_denies_malformed_shell_syntax(self):
        decision = self.engine.classify_command("cat 'unterminated")
        self.assertEqual(decision.classification, "deny")
        self.assertIn("malformed shell syntax", decision.reason)

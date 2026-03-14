"""Command classification and policy decisions."""

from __future__ import annotations

import re
import shlex
from pathlib import Path
from typing import Dict, List, Optional

from .models import CommandDecision
from .workspace import WorkspaceSandbox


DENY_REGEXES = [
    (re.compile(r"\bsudo\b"), "privilege escalation is denied"),
    (re.compile(r"\brm\s+-rf\b"), "recursive force delete is denied"),
    (re.compile(r"\bcurl\b.*\|\s*(sh|bash|zsh)\b"), "pipe-to-shell download is denied"),
    (re.compile(r"\bwget\b.*\|\s*(sh|bash|zsh)\b"), "pipe-to-shell download is denied"),
    (re.compile(r"\bosascript\b"), "AppleScript automation is denied"),
    (re.compile(r"\blaunchctl\b"), "launchctl changes are denied"),
]
APPROVAL_REGEXES = [
    (re.compile(r"\b(pip3?|npm|pnpm|yarn|brew)\b.*\b(install|add|update|upgrade)\b"), "package install requires approval"),
    (re.compile(r"\b(open|xdg-open|start)\b"), "opening a browser or external application requires approval"),
    (re.compile(r"\b(curl|wget)\b"), "network download requires approval"),
    (re.compile(r"\b(bash|sh|zsh)\b.*\.sh\b"), "shell script execution requires approval"),
]
class CommandPolicyEngine:
    def __init__(self, config: Dict, sandbox: WorkspaceSandbox) -> None:
        self.config = config
        self.sandbox = sandbox
        self.allow_commands = set(config.get("allow_commands", []))
        self.allow_subcommands = config.get("allow_subcommands", {})
        self.approval_commands = config.get("approval_commands", [])
        self.deny_commands = config.get("deny_commands", [])
        self.deny_substrings = config.get("deny_substrings", [])
        self.bulk_threshold = int(config.get("max_bulk_file_writes_without_approval", 10))

    def classify_command(self, command: str, context: Optional[Dict] = None) -> CommandDecision:
        context = context or {}
        stripped = command.strip()
        lower = stripped.lower()

        for pattern in self.deny_commands:
            if pattern.lower() in lower:
                return CommandDecision("deny", False, False, f"matched deny rule: {pattern}", [pattern], "critical")

        for regex, reason in DENY_REGEXES:
            if regex.search(stripped):
                return CommandDecision("deny", False, False, reason, [regex.pattern], "critical")

        for denied in self.deny_substrings:
            if denied.lower() in lower:
                return CommandDecision("deny", False, False, f"references denied target: {denied}", [denied], "critical")

        if any(op in stripped for op in ["&&", "||", ";", "$(", "`"]):
            return CommandDecision("deny", False, False, "shell control operators are denied", ["shell_metachar"], "critical")

        try:
            tokens = shlex.split(stripped)
        except ValueError as exc:
            return CommandDecision("deny", False, False, f"malformed shell syntax: {exc}", ["malformed_shell"], "high")
        if not tokens:
            return CommandDecision("deny", False, False, "empty command", ["empty"], "low")

        executable = tokens[0]
        executable_name = Path(executable).name
        target_paths = self._extract_candidate_paths(tokens[1:])
        target_domains = self._extract_candidate_domains(tokens[1:])

        for regex, reason in APPROVAL_REGEXES:
            if regex.search(stripped):
                return CommandDecision("approval_required", False, True, reason, [regex.pattern], "high", target_paths, target_domains)

        if executable_name in {"mv", "rename"}:
            return CommandDecision("approval_required", False, True, "move or rename requires approval", [executable_name], "medium", target_paths, target_domains)
        if executable_name in {"rm", "trash", "unlink"}:
            return CommandDecision("approval_required", False, True, "delete requires approval", [executable_name], "high", target_paths, target_domains)
        if executable_name in {"curl", "wget"}:
            return CommandDecision("approval_required", False, True, "network access requires approval", [executable_name], "high", target_paths, target_domains)

        modified_file_count = int(context.get("modified_file_count", 0))
        if modified_file_count > self.bulk_threshold:
            return CommandDecision("approval_required", False, True, "bulk modifications exceed threshold", ["bulk_threshold"], "high", target_paths, target_domains)

        if any(self._path_outside_workspace(p) for p in target_paths):
            return CommandDecision("approval_required", False, True, "command targets paths outside the workspace", ["outside_workspace"], "high", target_paths, target_domains)

        if executable_name in self.allow_commands:
            if executable_name in {"npm", "pnpm", "yarn"}:
                if self._is_allowed_subcommand(executable_name, tokens[1:]):
                    return CommandDecision("allow", True, False, "build/test/lint within workspace allowed", [executable_name], "low", target_paths, target_domains)
                return CommandDecision("approval_required", False, True, "package manager subcommand not explicitly allowed", [executable_name], "medium", target_paths, target_domains)
            if executable_name in {"python", "python3"} and tokens[1:3] == ["-m", "unittest"]:
                return CommandDecision("allow", True, False, "unit tests allowed", ["python-unittest"], "low", target_paths, target_domains)
            if executable_name in {"ls", "cat", "rg", "grep", "sed", "awk", "pytest", "make"}:
                return CommandDecision("allow", True, False, "command allowed by safe list", [executable_name], "low", target_paths, target_domains)

        if executable_name in {"cat", "grep", "rg"} and all(not self._path_outside_workspace(p) for p in target_paths):
            return CommandDecision("allow", True, False, "read-only workspace command allowed", [executable_name], "low", target_paths, target_domains)

        return CommandDecision("approval_required", False, True, "unknown command defaults to approval", ["default_deny"], "medium", target_paths, target_domains)

    def evaluate_command(self, command: str, context: Optional[Dict] = None) -> CommandDecision:
        return self.classify_command(command, context=context)

    def explain_decision(self, result: CommandDecision) -> str:
        parts = [
            f"classification={result.classification}",
            f"reason={result.reason}",
        ]
        if result.matched_rules:
            parts.append(f"matched={','.join(result.matched_rules)}")
        if result.target_paths:
            parts.append(f"paths={','.join(result.target_paths)}")
        if result.target_domains:
            parts.append(f"domains={','.join(result.target_domains)}")
        return " | ".join(parts)

    def _is_allowed_subcommand(self, executable: str, args: List[str]) -> bool:
        joined = " ".join(args[:3]).strip()
        for candidate in self.allow_subcommands.get(executable, []):
            if joined == candidate or " ".join(args[: len(candidate.split())]) == candidate:
                return True
        return False

    def _extract_candidate_paths(self, tokens: List[str]) -> List[str]:
        paths = []
        for token in tokens:
            if token.startswith("-"):
                continue
            if token.startswith(("http://", "https://")):
                continue
            if "/" in token or token.startswith(".") or token.startswith("~"):
                paths.append(token)
        return paths

    def _extract_candidate_domains(self, tokens: List[str]) -> List[str]:
        domains = []
        for token in tokens:
            if token.startswith(("http://", "https://")):
                host = token.split("/", 3)[2]
                domains.append(host)
        return domains

    def _path_outside_workspace(self, path: str) -> bool:
        decision = self.sandbox.validate_write_path(path)
        if decision.allowed:
            return False
        read_decision = self.sandbox.validate_read_path(path)
        return not read_decision.allowed


def classify_command(command: str, context: Optional[Dict] = None) -> CommandDecision:
    sandbox = WorkspaceSandbox("~/lobster-workspace", "/tmp/lobster-agent")
    engine = CommandPolicyEngine({}, sandbox)
    return engine.classify_command(command, context=context)


def evaluate_command(command: str, context: Optional[Dict] = None) -> CommandDecision:
    return classify_command(command, context=context)


def explain_decision(result: CommandDecision) -> str:
    sandbox = WorkspaceSandbox("~/lobster-workspace", "/tmp/lobster-agent")
    engine = CommandPolicyEngine({}, sandbox)
    return engine.explain_decision(result)

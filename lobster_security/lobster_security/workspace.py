"""Workspace sandbox and path validation."""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Iterable, List

from .errors import PolicyError
from .models import PathDecision


SENSITIVE_NAME_PATTERN = re.compile(r"(^|[._-])(env|key|token|credential|secret|cookie)([._-]|$)", re.IGNORECASE)
SHELL_RC_NAMES = {".zshrc", ".bashrc", ".profile", ".bash_profile", ".zprofile"}


class WorkspaceSandbox:
    def __init__(self, workspace_root: str, temp_root: str) -> None:
        self.workspace_root = Path(workspace_root).expanduser().resolve()
        self.temp_root = Path(temp_root).expanduser().resolve()
        self.allowed_roots = [self.workspace_root, self.temp_root]
        self.denied_roots = [
            Path("~/.ssh").expanduser(),
            Path("~/.aws").expanduser(),
            Path("~/.config").expanduser(),
            Path("~/.gnupg").expanduser(),
            Path("~/Documents").expanduser(),
            Path("~/Desktop").expanduser(),
            Path("~/Downloads").expanduser(),
            Path("~/Library/Keychains").expanduser(),
            Path("~/Library/Application Support/Google/Chrome").expanduser(),
            Path("~/Library/Application Support/Chromium").expanduser(),
            Path("~/Library/Application Support/Firefox").expanduser(),
            Path("/etc").resolve(),
            Path("/System").resolve() if Path("/System").exists() else Path("/nonexistent"),
            Path("/Library/Preferences").resolve() if Path("/Library/Preferences").exists() else Path("/nonexistent"),
        ]

    def _canonical(self, path: str, for_write: bool = False) -> Path:
        expanded = Path(os.path.expanduser(os.path.expandvars(path)))
        candidate = expanded if expanded.is_absolute() else (self.workspace_root / expanded)
        if for_write:
            parent = candidate.parent if candidate.suffix or candidate.name else candidate
            resolved_parent = parent.resolve(strict=False)
            return (resolved_parent / candidate.name).resolve(strict=False)
        return candidate.resolve(strict=False)

    def _is_within(self, candidate: Path, roots: Iterable[Path]) -> bool:
        candidate_norm = str(candidate).lower()
        for root in roots:
            try:
                root_norm = str(root.resolve(strict=False)).lower()
            except Exception:
                root_norm = str(root).lower()
            if candidate_norm == root_norm or candidate_norm.startswith(root_norm + os.sep):
                return True
        return False

    def _contains_sensitive_name(self, path: Path) -> bool:
        if path.name in SHELL_RC_NAMES:
            return True
        if path.name.lower() == ".env" or ".env." in path.name.lower():
            return True
        return any(SENSITIVE_NAME_PATTERN.search(part) for part in path.parts)

    def _validate(self, path: str, path_kind: str, for_write: bool) -> PathDecision:
        normalized = self._canonical(path, for_write=for_write)
        if self._is_within(normalized, self.denied_roots):
            return PathDecision(False, str(normalized), "path falls under a denied root", path_kind)
        if self._contains_sensitive_name(normalized):
            return PathDecision(False, str(normalized), "path name looks sensitive", path_kind)
        if not self._is_within(normalized, self.allowed_roots):
            return PathDecision(False, str(normalized), "path escapes the controlled workspace", path_kind)
        try:
            if normalized.is_symlink():
                target = normalized.resolve(strict=False)
                if not self._is_within(target, self.allowed_roots):
                    return PathDecision(False, str(target), "symlink escapes the controlled workspace", path_kind)
        except OSError:
            return PathDecision(False, str(normalized), "failed to inspect symlink target", path_kind)
        return PathDecision(True, str(normalized), "path allowed", path_kind)

    def validate_read_path(self, path: str) -> PathDecision:
        return self._validate(path, "read", for_write=False)

    def validate_write_path(self, path: str) -> PathDecision:
        return self._validate(path, "write", for_write=True)

    def require_read_path(self, path: str) -> str:
        decision = self.validate_read_path(path)
        if not decision.allowed:
            raise PolicyError(decision.reason)
        return decision.normalized_path

    def require_write_path(self, path: str) -> str:
        decision = self.validate_write_path(path)
        if not decision.allowed:
            raise PolicyError(decision.reason)
        return decision.normalized_path


_DEFAULT_SANDBOX = WorkspaceSandbox("~/lobster-workspace", "/tmp/lobster-agent")


def validate_read_path(path: str) -> PathDecision:
    return _DEFAULT_SANDBOX.validate_read_path(path)


def validate_write_path(path: str) -> PathDecision:
    return _DEFAULT_SANDBOX.validate_write_path(path)

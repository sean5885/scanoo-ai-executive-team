"""Audit logging with secret redaction."""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict


PRIVATE_KEY_RE = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.DOTALL)
BEARER_RE = re.compile(r"Bearer\s+[A-Za-z0-9._\-]+", re.IGNORECASE)
COOKIE_RE = re.compile(r"(cookie\s*[:=]\s*)([^;\n]+)", re.IGNORECASE)
PASSWORD_RE = re.compile(r"((?:password|passwd|pwd)\s*[:=]\s*)([^\s,\n]+)", re.IGNORECASE)
TOKEN_RE = re.compile(r"((?:api[_-]?key|token|session[_-]?token|secret)\s*[:=]\s*)([A-Za-z0-9._\-]{6,})", re.IGNORECASE)
GENERIC_KEY_RE = re.compile(r"\b(sk-[A-Za-z0-9]{10,}|ctx7sk-[A-Za-z0-9\-]{10,})\b")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def redact_secrets(text: str) -> str:
    redacted = PRIVATE_KEY_RE.sub("[REDACTED_PRIVATE_KEY]", text)
    redacted = BEARER_RE.sub("Bearer [REDACTED_TOKEN]", redacted)
    redacted = COOKIE_RE.sub(r"\1[REDACTED_COOKIE]", redacted)
    redacted = PASSWORD_RE.sub(r"\1[REDACTED_PASSWORD]", redacted)
    redacted = TOKEN_RE.sub(r"\1[REDACTED_SECRET]", redacted)
    redacted = GENERIC_KEY_RE.sub("[REDACTED_API_KEY]", redacted)
    return redacted


def summarize_output(text: str, limit: int = 500) -> str:
    clean = redact_secrets(text or "")
    if len(clean) <= limit:
        return clean
    return clean[:limit] + "... [truncated]"


class AuditLogger:
    def __init__(self, root: str) -> None:
        self.root = Path(os.path.expanduser(root)).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "tasks").mkdir(parents=True, exist_ok=True)
        (self.root / "task_meta").mkdir(parents=True, exist_ok=True)

    def task_log_path(self, task_id: str) -> Path:
        return self.root / "tasks" / f"{task_id}.jsonl"

    def write_audit_log(self, event: Dict[str, Any], log_path: Path | None = None) -> None:
        target = log_path or self.root / "audit.jsonl"
        target.parent.mkdir(parents=True, exist_ok=True)
        sanitized = self._sanitize(event)
        with target.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(sanitized, ensure_ascii=True) + "\n")

    def _sanitize(self, event: Dict[str, Any]) -> Dict[str, Any]:
        def walk(value):
            if isinstance(value, dict):
                return {k: walk(v) for k, v in value.items()}
            if isinstance(value, list):
                return [walk(v) for v in value]
            if isinstance(value, str):
                return redact_secrets(value)
            return value

        payload = walk(dict(event))
        payload.setdefault("timestamp", utc_now())
        return payload


def write_audit_log(event: Dict[str, Any], root: str = "~/lobster-workspace/.lobster-security/audit") -> None:
    AuditLogger(root).write_audit_log(event)

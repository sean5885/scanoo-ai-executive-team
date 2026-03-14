"""Security wrapper around local agent actions."""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import uuid
from dataclasses import asdict
from pathlib import Path
from typing import Any, Dict, Optional
from urllib import request as urllib_request
from urllib.parse import urlparse

from .approval import ApprovalHandler, build_approval_request
from .audit import AuditLogger, summarize_output, utc_now
from .command_policy import CommandPolicyEngine
from .config_loader import load_wrapper_config
from .errors import ApprovalPending, PolicyError
from .models import ApprovalOutcome, SnapshotMetadata, WrapperTask
from .network_guard import NetworkGuard
from .snapshot import SnapshotManager
from .workspace import WorkspaceSandbox


class SecureAgentWrapper:
    def __init__(self, config_dir: str, approval_callback=None) -> None:
        self.config = load_wrapper_config(config_dir, approval_callback=approval_callback)
        self.sandbox = WorkspaceSandbox(self.config.workspace_root, self.config.temp_root)
        self.command_engine = CommandPolicyEngine(self.config.policy, self.sandbox)
        self.network_guard = NetworkGuard(self.config.network)
        self.approvals = ApprovalHandler(self.config.approval, callback=self.config.approval_callback)
        self.audit = AuditLogger(self.config.audit["root"])
        self.snapshots = SnapshotManager(self.config.snapshot["root"], self.config.workspace_root)
        self.active_tasks: Dict[str, WrapperTask] = {}

    def start_task(self, name: str) -> WrapperTask:
        task_id = uuid.uuid4().hex
        snapshot = self.snapshots.create_snapshot(task_id)
        task = WrapperTask(
            task_id=task_id,
            name=name,
            started_at=utc_now(),
            snapshot=snapshot,
            task_log_path=str(self.audit.task_log_path(task_id)),
        )
        self.active_tasks[task_id] = task
        self._save_task(task)
        self.audit.write_audit_log({"event": "task_start", "task_id": task_id, "task_name": name}, self.audit.task_log_path(task_id))
        return task

    def finish_task(self, task_id: str, success: bool) -> Dict[str, Any]:
        task = self._get_task(task_id)
        diff = self.snapshots.diff_snapshot(task_id)
        event = {
            "event": "task_end",
            "task_id": task_id,
            "success": success,
            "changed_files": diff["changed"],
            "added_files": diff["added"],
            "deleted_files": diff["deleted"],
        }
        self.audit.write_audit_log(event, self.audit.task_log_path(task_id))
        return diff

    def execute_action(self, task_id: str, action: Dict[str, Any]) -> Dict[str, Any]:
        self._get_task(task_id)
        action_type = action.get("type")
        if action_type == "read_file":
            return self._read_file(task_id, action)
        if action_type == "write_file":
            return self._write_file(task_id, action)
        if action_type == "command":
            return self._run_command(task_id, action)
        if action_type == "http_request":
            return self._http_request(task_id, action)
        if action_type == "search":
            return self._search_proxy_action(task_id, action, "/search")
        if action_type == "fetch":
            return self._search_proxy_action(task_id, action, "/fetch")
        raise PolicyError(f"unsupported action type: {action_type}")

    def rollback_task(self, task_id: str, dry_run: bool = False) -> Dict[str, Any]:
        diff = self.snapshots.rollback_snapshot(task_id, dry_run=dry_run)
        self.audit.write_audit_log(
            {"event": "rollback", "task_id": task_id, "dry_run": dry_run, "diff": diff},
            self.audit.task_log_path(task_id),
        )
        return diff

    def _read_file(self, task_id: str, action: Dict[str, Any]) -> Dict[str, Any]:
        normalized = self.sandbox.require_read_path(str(action["path"]))
        content = Path(normalized).read_text(encoding="utf-8")
        result = {"path": normalized, "content": content}
        self.audit.write_audit_log(
            {"event": "read_file", "task_id": task_id, "path": normalized, "classification": "allow"},
            self.audit.task_log_path(task_id),
        )
        return result

    def _write_file(self, task_id: str, action: Dict[str, Any]) -> Dict[str, Any]:
        normalized = self.sandbox.require_write_path(str(action["path"]))
        Path(normalized).parent.mkdir(parents=True, exist_ok=True)
        Path(normalized).write_text(str(action.get("content", "")), encoding="utf-8")
        self.audit.write_audit_log(
            {"event": "write_file", "task_id": task_id, "path": normalized, "classification": "allow"},
            self.audit.task_log_path(task_id),
        )
        return {"path": normalized, "written": True}

    def _run_command(self, task_id: str, action: Dict[str, Any]) -> Dict[str, Any]:
        command = str(action["command"])
        cwd = str(action.get("cwd", self.config.workspace_root))
        normalized_cwd = self.sandbox.require_read_path(cwd)
        decision = self.command_engine.evaluate_command(command, {"cwd": normalized_cwd, "modified_file_count": action.get("modified_file_count", 0)})
        approval_result = self._maybe_approve(
            action_type="command",
            exact_command=command,
            decision=decision,
        )
        if decision.classification == "deny":
            self._log_command(task_id, command, decision, approval_result, exit_code=None, stdout="", stderr=decision.reason)
            raise PolicyError(decision.reason)

        before_manifest = self.snapshots._scan_workspace(copy_files_to=None)  # pylint: disable=protected-access
        completed = subprocess.run(
            shlex.split(command),
            cwd=normalized_cwd,
            shell=False,
            capture_output=True,
            text=True,
        )
        after_manifest = self.snapshots._scan_workspace(copy_files_to=None)  # pylint: disable=protected-access
        modified_files = self._diff_manifests(before_manifest, after_manifest)
        self._log_command(
            task_id,
            command,
            decision,
            approval_result,
            exit_code=completed.returncode,
            stdout=completed.stdout,
            stderr=completed.stderr,
            modified_files=modified_files,
        )
        return {
            "command": command,
            "exit_code": completed.returncode,
            "stdout": completed.stdout,
            "stderr": completed.stderr,
            "modified_files": modified_files,
        }

    def _http_request(self, task_id: str, action: Dict[str, Any]) -> Dict[str, Any]:
        req = {
            "url": str(action["url"]),
            "method": str(action.get("method", "GET")).upper(),
        }
        decision = self.network_guard.guard_http_request(req)
        if not decision.allowed:
            self.audit.write_audit_log(
                {"event": "http_request", "task_id": task_id, "url": req["url"], "classification": "deny", "reason": decision.reason},
                self.audit.task_log_path(task_id),
            )
            raise PolicyError(decision.reason)
        approval_result = self.approvals.request_approval(
            build_approval_request(
                action_type="http_request",
                exact_command=f"{req['method']} {req['url']}",
                target_paths=[],
                target_domains=[decision.normalized_host] if decision.normalized_host else [],
                estimated_risk="high",
                reason="outbound network call requires approval",
                recommendation="reject",
            )
        )
        if approval_result.status != "approved":
            raise PolicyError(approval_result.reason)

        request_obj = urllib_request.Request(req["url"], method=req["method"])
        with urllib_request.urlopen(request_obj, timeout=10) as response:
            headers = {k: v for k, v in response.headers.items()}
            self.network_guard.assert_content_policy(urlparse(req["url"]), headers)
            body = response.read().decode("utf-8", errors="ignore")
        self.audit.write_audit_log(
            {
                "event": "http_request",
                "task_id": task_id,
                "url": req["url"],
                "classification": "allow",
                "approval_result": approval_result.status if approval_result else "not_required",
                "network_targets": [decision.normalized_host],
                "stdout_summary": summarize_output(body, 300),
            },
            self.audit.task_log_path(task_id),
        )
        return {"url": req["url"], "status": 200, "body": body}

    def _search_proxy_action(self, task_id: str, action: Dict[str, Any], endpoint: str) -> Dict[str, Any]:
        proxy_url = f"http://{self.config.proxy.get('bind_host', '127.0.0.1')}:{self.config.proxy.get('port', 8787)}{endpoint}"
        req = urllib_request.Request(
            proxy_url,
            method="POST",
            data=json.dumps({k: v for k, v in action.items() if k != "type"}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        with urllib_request.urlopen(req, timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8"))
        self.audit.write_audit_log(
            {"event": "proxy_request", "task_id": task_id, "endpoint": endpoint, "classification": "allow"},
            self.audit.task_log_path(task_id),
        )
        return payload

    def _maybe_approve(self, action_type: str, exact_command: str, decision=None) -> Optional[ApprovalOutcome]:
        if decision is None:
            return None
        if getattr(decision, "classification", "") != "approval_required" and not getattr(decision, "requires_approval", False):
            return None
        request = build_approval_request(
            action_type=action_type,
            exact_command=exact_command,
            target_paths=getattr(decision, "target_paths", []),
            target_domains=getattr(decision, "target_domains", []),
            estimated_risk=getattr(decision, "risk", "medium"),
            reason=getattr(decision, "reason", "approval required"),
            recommendation="reject" if getattr(decision, "risk", "medium") in {"high", "critical"} else "approve",
        )
        outcome = self.approvals.request_approval(request)
        if outcome.status != "approved":
            raise PolicyError(outcome.reason)
        return outcome

    def _save_task(self, task: WrapperTask) -> None:
        target = Path(self.config.audit["root"]).expanduser().resolve() / "task_meta" / f"{task.task_id}.json"
        target.write_text(json.dumps(asdict(task), ensure_ascii=True, indent=2), encoding="utf-8")

    def _get_task(self, task_id: str) -> WrapperTask:
        if task_id in self.active_tasks:
            return self.active_tasks[task_id]
        target = Path(self.config.audit["root"]).expanduser().resolve() / "task_meta" / f"{task_id}.json"
        payload = json.loads(target.read_text(encoding="utf-8"))
        snapshot = payload["snapshot"]
        task = WrapperTask(
            task_id=payload["task_id"],
            name=payload["name"],
            started_at=payload["started_at"],
            snapshot=SnapshotMetadata(**snapshot),
            task_log_path=payload["task_log_path"],
        )
        self.active_tasks[task_id] = task
        return task

    @staticmethod
    def _diff_manifests(before_manifest, after_manifest):
        before = {entry["path"]: entry["sha256"] for entry in before_manifest}
        after = {entry["path"]: entry["sha256"] for entry in after_manifest}
        touched = []
        for path, digest in after.items():
            if path not in before or before[path] != digest:
                touched.append(path)
        for path in before:
            if path not in after:
                touched.append(path)
        return sorted(set(touched))

    def _log_command(
        self,
        task_id: str,
        command: str,
        decision,
        approval_result,
        exit_code,
        stdout: str,
        stderr: str,
        modified_files=None,
    ) -> None:
        self.audit.write_audit_log(
            {
                "event": "command",
                "task_id": task_id,
                "command": command,
                "classification": getattr(decision, "classification", "unknown"),
                "approval_result": approval_result.status if approval_result else "not_required",
                "exit_code": exit_code,
                "modified_files": modified_files or [],
                "network_targets": getattr(decision, "target_domains", []),
                "stdout_summary": summarize_output(stdout),
                "stderr_summary": summarize_output(stderr),
            },
            self.audit.task_log_path(task_id),
        )

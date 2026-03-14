"""CLI for the Lobster security wrapper."""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict
from pathlib import Path

from .config_loader import load_wrapper_config
from .errors import ApprovalPending, ConfigError, PolicyError, SecurityError
from .search_proxy import run_search_proxy
from .wrapper import SecureAgentWrapper


def _emit(payload, exit_code: int) -> int:
    print(json.dumps(payload, ensure_ascii=True, indent=2))
    return exit_code


def _build_approval_callback():
    store_path = os.environ.get("LOBSTER_APPROVAL_STORE", "").strip()
    if not store_path:
        return None

    target = Path(store_path).expanduser()

    def callback(request):
        try:
            payload = json.loads(target.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except json.JSONDecodeError:
            return None
        decision = payload.get(request.request_id, {}).get("status")
        if decision == "approved":
            return True
        if decision == "rejected":
            return False
        return None

    return callback


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="lobster-security")
    parser.add_argument("--config-dir", default="./config")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("serve-proxy")

    start_task = sub.add_parser("start-task")
    start_task.add_argument("--name", required=True)

    run_action = sub.add_parser("run-action")
    run_action.add_argument("--task-id", required=True)
    run_action.add_argument("--action-json", required=True)

    finish = sub.add_parser("finish-task")
    finish.add_argument("--task-id", required=True)
    finish.add_argument("--success", action="store_true")

    rollback = sub.add_parser("rollback")
    rollback.add_argument("--task-id", required=True)
    rollback.add_argument("--dry-run", action="store_true")

    args = parser.parse_args(argv)

    if args.command == "serve-proxy":
        try:
            config = load_wrapper_config(args.config_dir)
            run_search_proxy(config.proxy, config.network, config.audit["root"])
            return 0
        except ConfigError as exc:
            return _emit({"ok": False, "error": "config_error", "message": str(exc)}, 5)

    try:
        wrapper = SecureAgentWrapper(args.config_dir, approval_callback=_build_approval_callback())

        if args.command == "start-task":
            task = wrapper.start_task(args.name)
            return _emit({"ok": True, "result": asdict(task)}, 0)
        if args.command == "run-action":
            payload = json.loads(args.action_json)
            result = wrapper.execute_action(args.task_id, payload)
            return _emit({"ok": True, "result": result}, 0)
        if args.command == "finish-task":
            diff = wrapper.finish_task(args.task_id, success=bool(args.success))
            return _emit({"ok": True, "result": diff}, 0)
        if args.command == "rollback":
            result = wrapper.rollback_task(args.task_id, dry_run=bool(args.dry_run))
            return _emit({"ok": True, "result": result}, 0)
        return _emit({"ok": False, "error": "unknown_command"}, 1)
    except ApprovalPending as exc:
        return _emit(
            {
                "ok": False,
                "error": "approval_required",
                "approval_request": asdict(exc.request_payload),
            },
            3,
        )
    except PolicyError as exc:
        return _emit({"ok": False, "error": "policy_error", "message": str(exc)}, 4)
    except ConfigError as exc:
        return _emit({"ok": False, "error": "config_error", "message": str(exc)}, 5)
    except SecurityError as exc:
        return _emit({"ok": False, "error": "security_error", "message": str(exc)}, 6)
    except Exception as exc:  # pragma: no cover - last-resort CLI guard
        return _emit({"ok": False, "error": "internal_error", "message": str(exc)}, 1)


if __name__ == "__main__":
    sys.exit(main())

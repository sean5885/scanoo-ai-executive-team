"""Human approval layer."""

from __future__ import annotations

import hashlib
import json
from typing import Callable, Dict, Optional

from .errors import ApprovalPending, PolicyError
from .models import ApprovalOutcome, ApprovalRequest


class ApprovalHandler:
    def __init__(self, config: Dict, callback: Optional[Callable[[ApprovalRequest], Optional[bool]]] = None) -> None:
        self.mode = str(config.get("mode", "strict"))
        self.interactive = bool(config.get("interactive", False))
        self.callback = callback

    def request_approval(self, request: ApprovalRequest, failure_triggered: bool = False) -> ApprovalOutcome:
        if self.mode == "never":
            return ApprovalOutcome("rejected", "approval mode set to never", request)
        if self.mode == "on-failure" and not failure_triggered:
            return ApprovalOutcome("approved", "on-failure mode deferred approval", request)
        if self.callback is not None:
            callback_result = self.callback(request)
            if callback_result is not None:
                approved = bool(callback_result)
                return ApprovalOutcome("approved" if approved else "rejected", "callback decision", request)
        if self.interactive:
            prompt = (
                f"Approval required\n"
                f"request_id={request.request_id}\n"
                f"action_type={request.action_type}\n"
                f"exact_command={request.exact_command}\n"
                f"target_paths={request.target_paths}\n"
                f"target_domains={request.target_domains}\n"
                f"estimated_risk={request.estimated_risk}\n"
                f"reason={request.reason}\n"
                f"recommendation={request.recommendation}\n"
                "Approve? [y/N]: "
            )
            answer = input(prompt).strip().lower()
            approved = answer in {"y", "yes"}
            return ApprovalOutcome("approved" if approved else "rejected", "interactive decision", request)
        if self.mode in {"strict", "on-request"}:
            raise ApprovalPending(request)
        return ApprovalOutcome("rejected", "unsupported approval mode", request)


def build_approval_request(
    action_type: str,
    exact_command: str,
    target_paths,
    target_domains,
    estimated_risk: str,
    reason: str,
    recommendation: str,
) -> ApprovalRequest:
    request_id = hashlib.sha256(
        json.dumps(
            {
                "action_type": action_type,
                "exact_command": exact_command,
                "target_paths": list(target_paths or []),
                "target_domains": list(target_domains or []),
                "estimated_risk": estimated_risk,
                "reason": reason,
                "recommendation": recommendation,
            },
            sort_keys=True,
            ensure_ascii=True,
        ).encode("utf-8")
    ).hexdigest()[:24]
    return ApprovalRequest(
        request_id=request_id,
        action_type=action_type,
        exact_command=exact_command,
        target_paths=list(target_paths or []),
        target_domains=list(target_domains or []),
        estimated_risk=estimated_risk,
        reason=reason,
        recommendation=recommendation,
    )

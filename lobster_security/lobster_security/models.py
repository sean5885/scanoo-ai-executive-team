"""Dataclasses shared across the security wrapper."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional


@dataclass
class PathDecision:
    allowed: bool
    normalized_path: str
    reason: str
    path_kind: str


@dataclass
class CommandDecision:
    classification: str
    allowed: bool
    requires_approval: bool
    reason: str
    matched_rules: List[str] = field(default_factory=list)
    risk: str = "low"
    target_paths: List[str] = field(default_factory=list)
    target_domains: List[str] = field(default_factory=list)


@dataclass
class NetworkDecision:
    allowed: bool
    url: str
    normalized_host: str
    reason: str
    matched_rule: str = ""


@dataclass
class ApprovalRequest:
    request_id: str
    action_type: str
    exact_command: str
    target_paths: List[str]
    target_domains: List[str]
    estimated_risk: str
    reason: str
    recommendation: str


@dataclass
class ApprovalOutcome:
    status: str
    reason: str
    request: ApprovalRequest


@dataclass
class SnapshotMetadata:
    task_id: str
    workspace_root: str
    snapshot_root: str
    created_at: str
    manifest_path: str
    files_root: str


@dataclass
class WrapperTask:
    task_id: str
    name: str
    started_at: str
    snapshot: SnapshotMetadata
    task_log_path: str


@dataclass
class WrapperConfig:
    workspace_root: str
    temp_root: str
    policy: Dict[str, Any]
    network: Dict[str, Any]
    proxy: Dict[str, Any]
    audit: Dict[str, Any]
    snapshot: Dict[str, Any]
    approval: Dict[str, Any]
    approval_callback: Optional[Callable[[ApprovalRequest], bool]] = None

"""Config loading with secure defaults."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict

from .errors import ConfigError
from .models import WrapperConfig
from .yamlish import load_yaml_subset


def _read_yaml(path: Path) -> Dict[str, Any]:
    if not path.exists():
        raise ConfigError(f"Config file not found: {path}")
    try:
        return load_yaml_subset(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ConfigError(f"Failed to parse {path}: {exc}") from exc


def _expand(path_value: str) -> str:
    return str(Path(os.path.expandvars(os.path.expanduser(path_value))).resolve())


def load_wrapper_config(config_dir: str, approval_callback=None) -> WrapperConfig:
    base = Path(config_dir).expanduser().resolve()
    policy_doc = _read_yaml(base / "policy.yaml")
    network_doc = _read_yaml(base / "network_policy.yaml")

    policy_cfg = dict(policy_doc.get("policy", {}))
    approval_cfg = dict(policy_doc.get("approval", {}))
    network_cfg = dict(network_doc.get("network", {}))
    proxy_cfg = dict(network_doc.get("proxy", {}))
    audit_cfg = dict(network_doc.get("audit", {}))
    snapshot_cfg = dict(network_doc.get("snapshot", {}))

    workspace_root = _expand(
        os.environ.get("LOBSTER_WORKSPACE_ROOT", str(policy_cfg.get("workspace_root", "~/lobster-workspace")))
    )
    temp_root = _expand(
        os.environ.get("LOBSTER_TMP_ROOT", str(policy_cfg.get("temp_root", "/tmp/lobster-agent")))
    )

    audit_root = _expand(str(audit_cfg.get("root", f"{workspace_root}/.lobster-security/audit")))
    snapshot_root = _expand(str(snapshot_cfg.get("root", f"{workspace_root}/.lobster-security/snapshots")))

    policy_cfg["workspace_root"] = workspace_root
    policy_cfg["temp_root"] = temp_root
    audit_cfg["root"] = audit_root
    snapshot_cfg["root"] = snapshot_root
    approval_cfg["mode"] = os.environ.get("LOBSTER_APPROVAL_MODE", str(approval_cfg.get("mode", "strict")))

    return WrapperConfig(
        workspace_root=workspace_root,
        temp_root=temp_root,
        policy=policy_cfg,
        network=network_cfg,
        proxy=proxy_cfg,
        audit=audit_cfg,
        snapshot=snapshot_cfg,
        approval=approval_cfg,
        approval_callback=approval_callback,
    )

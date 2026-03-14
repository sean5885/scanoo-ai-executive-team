"""Workspace snapshot and rollback support."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from pathlib import Path
from typing import Dict, Iterable, List

from .audit import utc_now
from .models import SnapshotMetadata


class SnapshotManager:
    def __init__(self, snapshot_root: str, workspace_root: str) -> None:
        self.snapshot_root = Path(os.path.expanduser(snapshot_root)).resolve()
        self.workspace_root = Path(os.path.expanduser(workspace_root)).resolve()
        self.snapshot_root.mkdir(parents=True, exist_ok=True)

    def create_snapshot(self, task_id: str) -> SnapshotMetadata:
        root = self.snapshot_root / task_id
        files_root = root / "files"
        files_root.mkdir(parents=True, exist_ok=True)
        manifest = self._scan_workspace(copy_files_to=files_root)
        manifest_path = root / "manifest.json"
        metadata = SnapshotMetadata(
            task_id=task_id,
            workspace_root=str(self.workspace_root),
            snapshot_root=str(root),
            created_at=utc_now(),
            manifest_path=str(manifest_path),
            files_root=str(files_root),
        )
        manifest_path.write_text(json.dumps({"metadata": metadata.__dict__, "files": manifest}, indent=2), encoding="utf-8")
        return metadata

    def diff_snapshot(self, task_id: str) -> Dict[str, List[str]]:
        manifest = self._load_manifest(task_id)
        current = self._scan_workspace(copy_files_to=None)
        original_files = manifest["files"]
        before = {entry["path"]: entry for entry in original_files}
        after = {entry["path"]: entry for entry in current}

        added = sorted(path for path in after if path not in before)
        deleted = sorted(path for path in before if path not in after)
        changed = sorted(path for path in before if path in after and before[path]["sha256"] != after[path]["sha256"])
        return {"added": added, "deleted": deleted, "changed": changed}

    def rollback_snapshot(self, task_id: str, dry_run: bool = False) -> Dict[str, List[str]]:
        manifest = self._load_manifest(task_id)
        diff = self.diff_snapshot(task_id)
        if dry_run:
            return diff

        files_root = Path(manifest["metadata"]["files_root"])
        for path in diff["deleted"] + diff["changed"]:
            source = files_root / path
            target = self.workspace_root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        for path in diff["added"]:
            target = self.workspace_root / path
            if target.exists():
                target.unlink()
        return diff

    def _load_manifest(self, task_id: str) -> Dict:
        manifest_path = self.snapshot_root / task_id / "manifest.json"
        return json.loads(manifest_path.read_text(encoding="utf-8"))

    def _scan_workspace(self, copy_files_to: Path | None) -> List[Dict[str, str]]:
        manifest = []
        for path in sorted(self.workspace_root.rglob("*")):
            raw_path = str(path)
            if ".lobster-security/snapshots" in raw_path or ".lobster-security/audit" in raw_path:
                continue
            if path.is_dir() or path.is_symlink():
                continue
            relative = str(path.relative_to(self.workspace_root))
            sha256 = self._file_sha256(path)
            manifest.append({"path": relative, "sha256": sha256})
            if copy_files_to is not None:
                target = copy_files_to / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, target)
        return manifest

    @staticmethod
    def _file_sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(65536), b""):
                digest.update(chunk)
        return digest.hexdigest()


def create_snapshot(task_id: str, snapshot_root: str, workspace_root: str) -> SnapshotMetadata:
    return SnapshotManager(snapshot_root, workspace_root).create_snapshot(task_id)


def diff_snapshot(task_id: str, snapshot_root: str, workspace_root: str) -> Dict[str, List[str]]:
    return SnapshotManager(snapshot_root, workspace_root).diff_snapshot(task_id)


def rollback_snapshot(task_id: str, snapshot_root: str, workspace_root: str, dry_run: bool = False) -> Dict[str, List[str]]:
    return SnapshotManager(snapshot_root, workspace_root).rollback_snapshot(task_id, dry_run=dry_run)

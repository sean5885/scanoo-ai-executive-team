import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { cleanText } from "./message-intent-utils.mjs";

const MANIFEST_FILE = "manifest.json";
const SNAPSHOT_DIR = "snapshots";

export const DEFAULT_SYSTEM_SELF_CHECK_ARCHIVE_DIR = path.resolve(
  process.cwd(),
  process.env.SYSTEM_SELF_CHECK_ARCHIVE_DIR || ".tmp/system-self-check-history",
);

function compactTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1Z");
}

function buildRunId({
  timestamp = new Date().toISOString(),
} = {}) {
  return `self-check-${compactTimestamp(new Date(timestamp))}`;
}

async function readJson(filePath = "") {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, payload) {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function loadManifest(baseDir = DEFAULT_SYSTEM_SELF_CHECK_ARCHIVE_DIR) {
  const manifestPath = path.join(baseDir, MANIFEST_FILE);

  try {
    const loaded = await readJson(manifestPath);
    return {
      manifest_path: manifestPath,
      payload: {
        version: Number(loaded?.version || 1),
        updated_at: loaded?.updated_at || null,
        latest_run_id: cleanText(loaded?.latest_run_id) || null,
        snapshots: Array.isArray(loaded?.snapshots) ? loaded.snapshots : [],
      },
    };
  } catch {
    return {
      manifest_path: manifestPath,
      payload: {
        version: 1,
        updated_at: null,
        latest_run_id: null,
        snapshots: [],
      },
    };
  }
}

function buildPathLabel(filePath = "", cwd = process.cwd()) {
  const relative = path.relative(cwd, filePath);
  return relative || filePath;
}

function buildManifestEntry({
  runId = "",
  timestamp = null,
  report = {},
} = {}) {
  return {
    run_id: cleanText(runId) || null,
    timestamp,
    system_status: cleanText(report?.system_summary?.status) || "fail",
    routing_status: cleanText(report?.routing_summary?.status) || "fail",
    planner_status: cleanText(report?.planner_summary?.gate) || "fail",
  };
}

async function resolveSnapshotPayloadByPath(filePath = "", fallbackRunId = "") {
  const resolvedPath = path.resolve(process.cwd(), filePath);
  const payload = await readJson(resolvedPath);
  const runId = cleanText(payload?.run_id)
    || cleanText(fallbackRunId)
    || cleanText(path.basename(resolvedPath, path.extname(resolvedPath)));

  return {
    type: "snapshot",
    label: runId ? `snapshot:${runId}` : buildPathLabel(resolvedPath),
    ref: runId || resolvedPath,
    path: resolvedPath,
    report: payload,
    snapshot: payload,
  };
}

export async function archiveSystemSelfCheckSnapshot({
  baseDir = DEFAULT_SYSTEM_SELF_CHECK_ARCHIVE_DIR,
  report = {},
  timestamp = new Date().toISOString(),
} = {}) {
  const normalizedRunId = buildRunId({ timestamp });
  const snapshotDir = path.join(baseDir, SNAPSHOT_DIR);
  const snapshotPath = path.join(snapshotDir, `${normalizedRunId}.json`);
  const snapshotPayload = {
    run_id: normalizedRunId,
    timestamp,
    ...report,
  };

  await mkdir(snapshotDir, { recursive: true });
  await writeJson(snapshotPath, snapshotPayload);

  const { manifest_path, payload } = await loadManifest(baseDir);
  const nextEntry = buildManifestEntry({
    runId: normalizedRunId,
    timestamp,
    report,
  });
  const remainingEntries = (payload?.snapshots || []).filter((entry) => cleanText(entry?.run_id) !== normalizedRunId);
  const nextManifest = {
    version: Number(payload?.version || 1),
    updated_at: timestamp,
    latest_run_id: normalizedRunId,
    snapshots: [
      nextEntry,
      ...remainingEntries,
    ],
  };

  await writeJson(manifest_path, nextManifest);

  return {
    run_id: normalizedRunId,
    timestamp,
    snapshot_path: snapshotPath,
    manifest_path,
  };
}

export async function readSystemSelfCheckManifest(baseDir = DEFAULT_SYSTEM_SELF_CHECK_ARCHIVE_DIR) {
  const { manifest_path, payload } = await loadManifest(baseDir);
  return {
    manifest_path,
    ...payload,
  };
}

export async function resolveSystemSelfCheckSnapshot({
  reference = "",
  baseDir = DEFAULT_SYSTEM_SELF_CHECK_ARCHIVE_DIR,
} = {}) {
  const normalizedReference = cleanText(reference);
  if (!normalizedReference) {
    throw new Error("snapshot reference is required");
  }

  if (normalizedReference === "latest") {
    const manifest = await readSystemSelfCheckManifest(baseDir);
    if (!cleanText(manifest?.latest_run_id)) {
      throw new Error(`No system self-check snapshot found in ${manifest.manifest_path}`);
    }
    return resolveSystemSelfCheckSnapshot({
      reference: manifest.latest_run_id,
      baseDir,
    });
  }

  if (normalizedReference.includes(path.sep) || normalizedReference.endsWith(".json")) {
    return resolveSnapshotPayloadByPath(normalizedReference);
  }

  const manifest = await readSystemSelfCheckManifest(baseDir);
  const matched = (manifest?.snapshots || []).find((entry) => cleanText(entry?.run_id) === normalizedReference);
  if (!matched) {
    throw new Error(`System self-check snapshot not found for run_id: ${normalizedReference}`);
  }

  const snapshotPath = path.join(baseDir, SNAPSHOT_DIR, `${normalizedReference}.json`);
  return resolveSnapshotPayloadByPath(snapshotPath, normalizedReference);
}

export async function resolvePreviousSystemSelfCheckSnapshot({
  reference = "latest",
  baseDir = DEFAULT_SYSTEM_SELF_CHECK_ARCHIVE_DIR,
} = {}) {
  const manifest = await readSystemSelfCheckManifest(baseDir);
  const snapshots = Array.isArray(manifest?.snapshots) ? manifest.snapshots : [];
  if (snapshots.length < 2) {
    throw new Error(`Previous system self-check snapshot not found in ${manifest.manifest_path}`);
  }

  const normalizedReference = cleanText(reference) || "latest";
  const targetRunId = normalizedReference === "latest"
    ? cleanText(manifest?.latest_run_id)
    : normalizedReference;
  const currentIndex = snapshots.findIndex((entry) => cleanText(entry?.run_id) === targetRunId);

  if (currentIndex === -1) {
    throw new Error(`System self-check snapshot not found for run_id: ${targetRunId}`);
  }
  if (currentIndex + 1 >= snapshots.length) {
    throw new Error(`Previous system self-check snapshot not found for run_id: ${targetRunId}`);
  }

  const previousEntry = snapshots[currentIndex + 1];
  const snapshotPath = path.join(baseDir, SNAPSHOT_DIR, `${cleanText(previousEntry?.run_id)}.json`);
  return resolveSnapshotPayloadByPath(snapshotPath, cleanText(previousEntry?.run_id));
}

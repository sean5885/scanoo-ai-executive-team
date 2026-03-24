import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { cleanText } from "./message-intent-utils.mjs";

const MANIFEST_FILE = "manifest.json";
const SNAPSHOT_DIR = "snapshots";

export const DEFAULT_CONTROL_DIAGNOSTICS_ARCHIVE_DIR = path.resolve(
  process.cwd(),
  process.env.CONTROL_DIAGNOSTICS_ARCHIVE_DIR || ".tmp/control-diagnostics-history",
);

function compactTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1Z");
}

function normalizeCommandName(commandName = "control:diagnostics") {
  return (
    cleanText(commandName)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
    || "control-diagnostics"
  );
}

function buildRunId({
  commandName = "control:diagnostics",
  timestamp = new Date().toISOString(),
} = {}) {
  return `${normalizeCommandName(commandName)}-${compactTimestamp(new Date(timestamp))}`;
}

async function readJson(filePath = "") {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, payload) {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function loadManifest(baseDir = DEFAULT_CONTROL_DIAGNOSTICS_ARCHIVE_DIR) {
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

async function resolveSnapshotPayloadByPath(filePath = "", fallbackRunId = "") {
  const resolvedPath = path.resolve(process.cwd(), filePath);
  const payload = await readJson(resolvedPath);
  const runId = cleanText(payload?.run_id)
    || cleanText(fallbackRunId)
    || cleanText(path.basename(resolvedPath, path.extname(resolvedPath)));

  return {
    type: "snapshot",
    label: runId
      ? `snapshot:${runId}`
      : buildPathLabel(resolvedPath),
    ref: runId || resolvedPath,
    path: resolvedPath,
    report: payload,
    snapshot: payload,
  };
}

function buildManifestEntry({
  runId = "",
  timestamp = null,
  diagnosticsSummary = {},
} = {}) {
  return {
    run_id: cleanText(runId) || null,
    timestamp,
    overall_status: cleanText(diagnosticsSummary?.overall_status) || "fail",
    control_status: cleanText(diagnosticsSummary?.control_status) || "fail",
    routing_status: cleanText(diagnosticsSummary?.routing_status) || "fail",
    write_status: cleanText(diagnosticsSummary?.write_status) || "fail",
    control_issue_count: Number(diagnosticsSummary?.control_issue_count || 0),
    routing_issue_count: Number(diagnosticsSummary?.routing_issue_count || 0),
    write_issue_count: Number(diagnosticsSummary?.write_issue_count || 0),
  };
}

export async function archiveControlDiagnosticsSnapshot({
  baseDir = DEFAULT_CONTROL_DIAGNOSTICS_ARCHIVE_DIR,
  commandName = "control:diagnostics",
  report = {},
  timestamp = new Date().toISOString(),
} = {}) {
  const normalizedRunId = buildRunId({ commandName, timestamp });
  const snapshotDir = path.join(baseDir, SNAPSHOT_DIR);
  const snapshotPath = path.join(snapshotDir, `${normalizedRunId}.json`);
  const nextReport = {
    ...report,
    run_id: normalizedRunId,
    timestamp,
  };

  await mkdir(snapshotDir, { recursive: true });
  await writeJson(snapshotPath, nextReport);

  const { manifest_path, payload } = await loadManifest(baseDir);
  const nextEntry = buildManifestEntry({
    runId: normalizedRunId,
    timestamp,
    diagnosticsSummary: nextReport?.diagnostics_summary || {},
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
    report: nextReport,
  };
}

export async function readControlDiagnosticsManifest(baseDir = DEFAULT_CONTROL_DIAGNOSTICS_ARCHIVE_DIR) {
  const { manifest_path, payload } = await loadManifest(baseDir);
  return {
    manifest_path,
    ...payload,
  };
}

export async function resolveControlDiagnosticsSnapshot({
  reference = "",
  baseDir = DEFAULT_CONTROL_DIAGNOSTICS_ARCHIVE_DIR,
} = {}) {
  const normalizedReference = cleanText(reference);
  if (!normalizedReference) {
    throw new Error("snapshot reference is required");
  }

  if (normalizedReference === "latest") {
    const manifest = await readControlDiagnosticsManifest(baseDir);
    if (!cleanText(manifest?.latest_run_id)) {
      throw new Error(`No control diagnostics snapshot found in ${manifest.manifest_path}`);
    }
    return resolveControlDiagnosticsSnapshot({
      reference: manifest.latest_run_id,
      baseDir,
    });
  }

  if (normalizedReference.includes(path.sep) || normalizedReference.endsWith(".json")) {
    return resolveSnapshotPayloadByPath(normalizedReference);
  }

  const manifest = await readControlDiagnosticsManifest(baseDir);
  const matched = (manifest?.snapshots || []).find((entry) => cleanText(entry?.run_id) === normalizedReference);
  if (!matched) {
    throw new Error(`Control diagnostics snapshot not found for run_id: ${normalizedReference}`);
  }
  const snapshotPath = path.join(baseDir, SNAPSHOT_DIR, `${normalizedReference}.json`);
  return resolveSnapshotPayloadByPath(snapshotPath, normalizedReference);
}

export async function resolvePreviousControlDiagnosticsSnapshot({
  reference = "latest",
  baseDir = DEFAULT_CONTROL_DIAGNOSTICS_ARCHIVE_DIR,
} = {}) {
  const manifest = await readControlDiagnosticsManifest(baseDir);
  const snapshots = Array.isArray(manifest?.snapshots) ? manifest.snapshots : [];
  if (snapshots.length < 2) {
    throw new Error(`Previous control diagnostics snapshot not found in ${manifest.manifest_path}`);
  }

  const normalizedReference = cleanText(reference) || "latest";
  const targetRunId = normalizedReference === "latest"
    ? cleanText(manifest?.latest_run_id)
    : normalizedReference;
  const currentIndex = snapshots.findIndex((entry) => cleanText(entry?.run_id) === targetRunId);

  if (currentIndex === -1) {
    throw new Error(`Control diagnostics snapshot not found for run_id: ${targetRunId}`);
  }
  if (currentIndex + 1 >= snapshots.length) {
    throw new Error(`Previous control diagnostics snapshot not found for run_id: ${targetRunId}`);
  }

  const previousEntry = snapshots[currentIndex + 1];
  const snapshotPath = path.join(baseDir, SNAPSHOT_DIR, `${cleanText(previousEntry?.run_id)}.json`);
  return resolveSnapshotPayloadByPath(snapshotPath, cleanText(previousEntry?.run_id));
}

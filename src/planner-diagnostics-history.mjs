import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { cleanText } from "./message-intent-utils.mjs";

const MANIFEST_FILE = "manifest.json";
const SNAPSHOT_DIR = "snapshots";

export const DEFAULT_PLANNER_DIAGNOSTICS_ARCHIVE_DIR = path.resolve(
  process.cwd(),
  process.env.PLANNER_DIAGNOSTICS_ARCHIVE_DIR || ".tmp/planner-diagnostics-history",
);

function compactTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1Z");
}

function normalizeCommandName(commandName = "planner:diagnostics") {
  return (
    cleanText(commandName)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
    || "planner-diagnostics"
  );
}

function buildRunId({
  commandName = "planner:diagnostics",
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

async function loadManifest(baseDir = DEFAULT_PLANNER_DIAGNOSTICS_ARCHIVE_DIR) {
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

function buildManifestEntry({
  runId = "",
  timestamp = null,
  diagnosticsSummary = {},
} = {}) {
  return {
    run_id: cleanText(runId) || null,
    timestamp,
    gate: cleanText(diagnosticsSummary?.gate) || "fail",
    undefined_actions: Number(diagnosticsSummary?.undefined_actions || 0),
    undefined_presets: Number(diagnosticsSummary?.undefined_presets || 0),
    selector_contract_mismatches: Number(diagnosticsSummary?.selector_contract_mismatches || 0),
    deprecated_reachable_targets: Number(diagnosticsSummary?.deprecated_reachable_targets || 0),
  };
}

export async function archivePlannerDiagnosticsSnapshot({
  baseDir = DEFAULT_PLANNER_DIAGNOSTICS_ARCHIVE_DIR,
  commandName = "planner:diagnostics",
  report = {},
  timestamp = new Date().toISOString(),
} = {}) {
  const normalizedRunId = buildRunId({ commandName, timestamp });
  const snapshotDir = path.join(baseDir, SNAPSHOT_DIR);
  const snapshotPath = path.join(snapshotDir, `${normalizedRunId}.json`);
  const diagnosticsSummary = report?.diagnostics_summary || {};

  await mkdir(snapshotDir, { recursive: true });
  await writeJson(snapshotPath, report);

  const { manifest_path, payload } = await loadManifest(baseDir);
  const nextEntry = buildManifestEntry({
    runId: normalizedRunId,
    timestamp,
    diagnosticsSummary,
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

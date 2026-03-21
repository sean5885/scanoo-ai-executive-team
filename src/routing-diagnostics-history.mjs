import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { cleanText } from "./message-intent-utils.mjs";

const execFileAsync = promisify(execFile);

const MANIFEST_FILE = "manifest.json";
const SNAPSHOT_DIR = "snapshots";

export const DEFAULT_ROUTING_DIAGNOSTICS_ARCHIVE_DIR = path.resolve(
  process.cwd(),
  process.env.ROUTING_DIAGNOSTICS_ARCHIVE_DIR || ".tmp/routing-diagnostics-history",
);

function compactTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1Z");
}

function buildRunId({
  runId = "",
  scope = "routing-eval",
  stage = "run",
  timestamp = new Date().toISOString(),
} = {}) {
  const normalizedRunId = cleanText(runId);
  if (normalizedRunId) {
    return normalizedRunId;
  }

  const normalizedScope = cleanText(scope) || "routing-eval";
  const normalizedStage = cleanText(stage) || "run";
  return `${normalizedScope}-${normalizedStage}-${compactTimestamp(new Date(timestamp))}`;
}

function normalizeErrorMetric(metric = {}) {
  return {
    expected: Number(metric?.expected || 0),
    actual: Number(metric?.actual || 0),
    matched: Number(metric?.matched || 0),
    misses: Number(metric?.misses || 0),
  };
}

function buildTrendReportSummary(diagnosticsSummary = {}) {
  const trendReport = diagnosticsSummary?.trend_report || {};
  const decisionTrend = diagnosticsSummary?.decision_advice?.trend || {};
  const delta = trendReport?.delta || {};

  return {
    available: Boolean(trendReport?.available),
    status: cleanText(decisionTrend?.status) || (trendReport?.available ? "unknown" : "unavailable"),
    previous_label: cleanText(trendReport?.previous_label) || null,
    accuracy_ratio_delta: delta?.accuracy_ratio ? Number(delta.accuracy_ratio.delta || 0) : null,
    miss_count_delta: delta?.miss_count ? Number(delta.miss_count.delta || 0) : null,
    total_cases_delta: delta?.total_cases ? Number(delta.total_cases.delta || 0) : null,
  };
}

function buildSnapshotRecord({
  runId,
  timestamp,
  scope,
  stage,
  run,
  diagnosticsSummary,
  compareTarget = null,
  sessionId = null,
  artifacts = null,
  metadata = null,
  snapshotPath,
} = {}) {
  return {
    run_id: runId,
    timestamp,
    scope: cleanText(scope) || "routing-eval",
    stage: cleanText(stage) || "run",
    accuracy_ratio: Number(diagnosticsSummary?.accuracy_ratio || 0),
    error_breakdown: Object.fromEntries(
      Object.entries(diagnosticsSummary?.error_breakdown || {})
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([code, metric]) => [code, normalizeErrorMetric(metric)]),
    ),
    trend_report_summary: buildTrendReportSummary(diagnosticsSummary),
    compare_target: compareTarget && typeof compareTarget === "object"
      ? {
          type: cleanText(compareTarget?.type) || "custom",
          label: cleanText(compareTarget?.label) || null,
          ref: cleanText(compareTarget?.ref) || null,
        }
      : null,
    session_id: cleanText(sessionId) || null,
    artifacts: artifacts && typeof artifacts === "object" ? { ...artifacts } : null,
    metadata: metadata && typeof metadata === "object" ? { ...metadata } : null,
    snapshot_path: snapshotPath,
    diagnostics_summary: diagnosticsSummary,
    run,
  };
}

function buildManifestEntry(snapshot = {}) {
  return {
    run_id: cleanText(snapshot?.run_id) || null,
    timestamp: snapshot?.timestamp || null,
    accuracy_ratio: Number(snapshot?.accuracy_ratio || 0),
    error_breakdown: Object.fromEntries(
      Object.entries(snapshot?.error_breakdown || {})
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([code, metric]) => [code, normalizeErrorMetric(metric)]),
    ),
    trend_report_summary: snapshot?.trend_report_summary || buildTrendReportSummary({}),
    scope: cleanText(snapshot?.scope) || "routing-eval",
    stage: cleanText(snapshot?.stage) || "run",
    session_id: cleanText(snapshot?.session_id) || null,
    compare_target: snapshot?.compare_target || null,
    snapshot_path: snapshot?.snapshot_path || null,
  };
}

async function readJson(filePath = "") {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, payload) {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function loadManifest(baseDir = DEFAULT_ROUTING_DIAGNOSTICS_ARCHIVE_DIR) {
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

function extractRunPayload(payload = {}) {
  if (payload?.run?.summary) {
    return payload.run;
  }
  if (payload?.summary) {
    return payload;
  }
  throw new Error("compare input must contain either run.summary or summary");
}

async function resolveSnapshotPayloadByPath(filePath = "") {
  const resolvedPath = path.resolve(process.cwd(), filePath);
  const payload = await readJson(resolvedPath);
  const run = extractRunPayload(payload);

  return {
    type: "snapshot",
    label: cleanText(payload?.run_id)
      ? `snapshot:${cleanText(payload.run_id)}`
      : buildPathLabel(resolvedPath),
    ref: cleanText(payload?.run_id) || resolvedPath,
    path: resolvedPath,
    run,
    snapshot: payload?.run ? payload : null,
  };
}

export async function readRoutingDiagnosticsManifest(baseDir = DEFAULT_ROUTING_DIAGNOSTICS_ARCHIVE_DIR) {
  const { manifest_path, payload } = await loadManifest(baseDir);
  return {
    manifest_path,
    ...payload,
  };
}

export async function archiveRoutingDiagnosticsSnapshot({
  baseDir = DEFAULT_ROUTING_DIAGNOSTICS_ARCHIVE_DIR,
  runId = "",
  timestamp = new Date().toISOString(),
  scope = "routing-eval",
  stage = "run",
  run = {},
  diagnosticsSummary = {},
  compareTarget = null,
  sessionId = null,
  artifacts = null,
  metadata = null,
} = {}) {
  if (process.env.ROUTING_DIAGNOSTICS_ARCHIVE_DISABLED === "1") {
    return null;
  }

  const normalizedRunId = buildRunId({ runId, scope, stage, timestamp });
  const snapshotDir = path.join(baseDir, SNAPSHOT_DIR);
  const snapshotPath = path.join(snapshotDir, `${normalizedRunId}.json`);
  await mkdir(snapshotDir, { recursive: true });

  const snapshot = buildSnapshotRecord({
    runId: normalizedRunId,
    timestamp,
    scope,
    stage,
    run,
    diagnosticsSummary,
    compareTarget,
    sessionId,
    artifacts,
    metadata,
    snapshotPath,
  });

  await writeJson(snapshotPath, snapshot);

  const { manifest_path, payload } = await loadManifest(baseDir);
  const nextEntry = buildManifestEntry(snapshot);
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

export async function resolveRoutingDiagnosticsSnapshot({
  reference = "",
  baseDir = DEFAULT_ROUTING_DIAGNOSTICS_ARCHIVE_DIR,
} = {}) {
  const normalizedReference = cleanText(reference);
  if (!normalizedReference) {
    throw new Error("snapshot reference is required");
  }

  if (normalizedReference === "latest") {
    const manifest = await readRoutingDiagnosticsManifest(baseDir);
    if (!cleanText(manifest?.latest_run_id)) {
      throw new Error(`No routing diagnostics snapshot found in ${manifest.manifest_path}`);
    }
    return resolveRoutingDiagnosticsSnapshot({
      reference: manifest.latest_run_id,
      baseDir,
    });
  }

  if (normalizedReference.includes(path.sep) || normalizedReference.endsWith(".json")) {
    return resolveSnapshotPayloadByPath(normalizedReference);
  }

  const manifest = await readRoutingDiagnosticsManifest(baseDir);
  const matched = (manifest?.snapshots || []).find((entry) => cleanText(entry?.run_id) === normalizedReference);
  if (!matched?.snapshot_path) {
    throw new Error(`Routing diagnostics snapshot not found for run_id: ${normalizedReference}`);
  }

  return resolveSnapshotPayloadByPath(matched.snapshot_path);
}

export async function resolvePreviousRoutingDiagnosticsSnapshot({
  reference = "latest",
  baseDir = DEFAULT_ROUTING_DIAGNOSTICS_ARCHIVE_DIR,
} = {}) {
  const manifest = await readRoutingDiagnosticsManifest(baseDir);
  const snapshots = Array.isArray(manifest?.snapshots) ? manifest.snapshots : [];
  if (snapshots.length < 2) {
    throw new Error(`Previous routing diagnostics snapshot not found in ${manifest.manifest_path}`);
  }

  const normalizedReference = cleanText(reference) || "latest";
  const targetRunId = normalizedReference === "latest"
    ? cleanText(manifest?.latest_run_id)
    : normalizedReference;
  const currentIndex = snapshots.findIndex((entry) => cleanText(entry?.run_id) === targetRunId);

  if (currentIndex === -1) {
    throw new Error(`Routing diagnostics snapshot not found for run_id: ${targetRunId}`);
  }
  if (currentIndex + 1 >= snapshots.length) {
    throw new Error(`Previous routing diagnostics snapshot not found for run_id: ${targetRunId}`);
  }

  const previousEntry = snapshots[currentIndex + 1];
  if (!previousEntry?.snapshot_path) {
    throw new Error(`Snapshot path missing for previous routing diagnostics snapshot: ${cleanText(previousEntry?.run_id) || "unknown"}`);
  }

  return resolveSnapshotPayloadByPath(previousEntry.snapshot_path);
}

async function assertGitTagExists(tag = "") {
  const normalizedTag = cleanText(tag);
  if (!normalizedTag) {
    throw new Error("compare tag is required");
  }

  await execFileAsync("git", ["rev-parse", "--verify", `refs/tags/${normalizedTag}`], {
    cwd: process.cwd(),
  });
}

export async function resolveRoutingDiagnosticsTag({
  tag = "",
} = {}) {
  const normalizedTag = cleanText(tag);
  await assertGitTagExists(normalizedTag);

  const tempRoot = await mkdtemp(path.join(tmpdir(), "routing-eval-tag-"));
  const worktreeDir = path.join(tempRoot, "repo");
  const currentNodeModules = path.join(process.cwd(), "node_modules");
  const tagNodeModules = path.join(worktreeDir, "node_modules");

  try {
    await execFileAsync("git", ["worktree", "add", "--detach", worktreeDir, normalizedTag], {
      cwd: process.cwd(),
    });
    try {
      await symlink(currentNodeModules, tagNodeModules, "dir");
    } catch {}
    const { stdout } = await execFileAsync("node", ["scripts/routing-eval.mjs", "--json"], {
      cwd: worktreeDir,
      env: {
        ...process.env,
        ROUTING_DIAGNOSTICS_ARCHIVE_DISABLED: "1",
      },
      maxBuffer: 20 * 1024 * 1024,
    });
    const payload = JSON.parse(stdout);

    return {
      type: "tag",
      label: `tag:${normalizedTag}`,
      ref: normalizedTag,
      path: null,
      run: extractRunPayload(payload),
      snapshot: null,
    };
  } finally {
    try {
      await execFileAsync("git", ["worktree", "remove", "--force", worktreeDir], {
        cwd: process.cwd(),
      });
    } catch {}
    await rm(tempRoot, { recursive: true, force: true });
  }
}

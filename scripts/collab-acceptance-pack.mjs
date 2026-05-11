import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { buildMemoryInfluenceReport } from "../src/memory-influence-gate.mjs";
import { cleanText } from "../src/message-intent-utils.mjs";
import { runReleaseCheck } from "../src/release-check.mjs";
import {
  buildRealTrafficEvidenceReport,
  writeRealTrafficEvidenceReport,
} from "../src/real-traffic-evidence.mjs";

const OUTPUT_LATEST_PATH = ".data/evals/collab-acceptance/latest.json";
const OUTPUT_HISTORY_DIR = ".data/evals/collab-acceptance/history";
const OUTPUT_MANIFEST_PATH = `${OUTPUT_HISTORY_DIR}/manifest.json`;
const REPORT_VERSION = "collab_acceptance_pack_v1";
const ARTIFACT_COVERAGE_RATE_MIN = 0.9;

function getArgValue(flag = "") {
  const index = process.argv.indexOf(flag);
  if (index < 0) {
    return null;
  }
  return process.argv[index + 1] || null;
}

function toNumber(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function readJsonIfExists(filePath = "") {
  try {
    const raw = await readFile(path.resolve(filePath), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeJson(filePath = "", payload = {}) {
  const resolvedPath = path.resolve(filePath);
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return resolvedPath;
}

async function appendHistory(report = {}) {
  const runId = cleanText(report?.run_id) || `collab-acceptance-${Date.now()}`;
  const snapshotPath = path.resolve(OUTPUT_HISTORY_DIR, `${runId}.json`);
  await writeJson(snapshotPath, report);

  const manifest = await readJsonIfExists(OUTPUT_MANIFEST_PATH) || {
    version: "collab_acceptance_manifest_v1",
    latest_run_id: null,
    snapshots: [],
  };

  const entry = {
    run_id: runId,
    generated_at: report.generated_at || new Date().toISOString(),
    overall_status: cleanText(report?.overall_status) || "fail",
    release_overall_status: cleanText(report?.gates?.release_overall_status) || "fail",
    collab_gate_status: cleanText(report?.gates?.collab_gate_status) || "unknown",
    real_traffic_status: cleanText(report?.gates?.real_traffic_status) || "unknown",
    memory_influence_status: cleanText(report?.gates?.memory_influence_status) || "unknown",
  };

  manifest.latest_run_id = runId;
  manifest.snapshots = [
    entry,
    ...(Array.isArray(manifest.snapshots) ? manifest.snapshots : []).filter((item) => cleanText(item?.run_id) !== runId),
  ].slice(0, 200);
  await writeJson(OUTPUT_MANIFEST_PATH, manifest);

  return {
    run_id: runId,
    snapshot_path: snapshotPath,
    manifest_path: path.resolve(OUTPUT_MANIFEST_PATH),
  };
}

function renderSummary(report = {}) {
  return [
    "Collab Acceptance Pack",
    `overall_status: ${cleanText(report?.overall_status) || "fail"}`,
    `release_overall_status: ${cleanText(report?.gates?.release_overall_status) || "fail"}`,
    `collab_gate_status: ${cleanText(report?.gates?.collab_gate_status) || "unknown"}`,
    `artifact_coverage_rate: ${report?.gates?.artifact_coverage_rate ?? "null"}`,
    `real_traffic_status: ${cleanText(report?.gates?.real_traffic_status) || "unknown"}`,
    `memory_influence_status: ${cleanText(report?.gates?.memory_influence_status) || "unknown"}`,
    `blocking_reasons: ${Array.isArray(report?.blocking_reasons) && report.blocking_reasons.length > 0 ? report.blocking_reasons.join(",") : "none"}`,
  ].join("\n");
}

async function main() {
  const wantsJson = process.argv.includes("--json");
  const enableMemoryGate = process.argv.includes("--memory-influence-gate")
    || process.env.COLLAB_ACCEPTANCE_ENABLE_MEMORY_INFLUENCE_GATE !== "0";
  const requireMemoryGate = process.argv.includes("--require-memory-influence-gate")
    || process.env.COLLAB_ACCEPTANCE_REQUIRE_MEMORY_INFLUENCE_GATE !== "0";
  const memoryFixturePath = cleanText(process.env.RELEASE_CHECK_MEMORY_INFLUENCE_FIXTURE);
  const memoryCaseCount = Math.max(1, Math.floor(toNumber(getArgValue("--memory-gate-cases"), 4)));
  const memoryHitRateMin = toNumber(getArgValue("--memory-hit-rate-min"), 0.8);
  const actionChangedRateMin = toNumber(getArgValue("--action-changed-rate-min"), 0.5);

  let memoryFixture = null;
  if (memoryFixturePath) {
    memoryFixture = await readJsonIfExists(memoryFixturePath);
  }

  const memoryInfluenceCheck = !enableMemoryGate
    ? null
    : memoryFixture
      ? async () => memoryFixture
      : async () => buildMemoryInfluenceReport({
        caseCount: memoryCaseCount,
        memoryHitRateMin,
        actionChangedRateMin,
      });

  const originalWrite = process.stdout.write.bind(process.stdout);
  let releaseCheckResult = null;
  let realTrafficReport = null;
  process.stdout.write = (() => true);
  try {
    [releaseCheckResult, realTrafficReport] = await Promise.all([
      runReleaseCheck({
        ...(memoryInfluenceCheck ? { memoryInfluenceCheck } : {}),
        ...(enableMemoryGate && requireMemoryGate ? { memoryInfluenceGateRequired: true } : {}),
      }),
      buildRealTrafficEvidenceReport(),
    ]);
  } finally {
    process.stdout.write = originalWrite;
  }
  const realTrafficArchive = await writeRealTrafficEvidenceReport(realTrafficReport);

  const releaseReport = releaseCheckResult?.report || {};
  const memoryStatus = cleanText(
    releaseReport?.decision_os_readiness?.closed_loop_metrics?.memory_influence?.status,
  ) || "unknown";
  const collabGateStatus = cleanText(releaseReport?.collab_gate?.status) || "unknown";
  const artifactCoverageRate = Number(releaseReport?.collab_gate?.metrics?.artifact_coverage_rate);
  const normalizedArtifactCoverageRate = Number.isFinite(artifactCoverageRate)
    ? artifactCoverageRate
    : null;

  const blockingReasons = [];
  if (cleanText(releaseReport?.overall_status) !== "pass") {
    blockingReasons.push("release_check_fail");
  }
  if (collabGateStatus !== "pass") {
    blockingReasons.push("collab_gate_not_pass");
  }
  if (normalizedArtifactCoverageRate == null || normalizedArtifactCoverageRate < ARTIFACT_COVERAGE_RATE_MIN) {
    blockingReasons.push("artifact_coverage_rate_below_threshold");
  }
  if (cleanText(realTrafficReport?.overall_status) !== "pass") {
    blockingReasons.push("real_traffic_not_pass");
  }
  if (enableMemoryGate && requireMemoryGate && memoryStatus !== "pass") {
    blockingReasons.push("memory_influence_not_pass");
  }

  const report = {
    version: REPORT_VERSION,
    run_id: `collab-acceptance-${Date.now()}`,
    generated_at: new Date().toISOString(),
    overall_status: blockingReasons.length === 0 ? "pass" : "fail",
    blocking_reasons: blockingReasons,
    thresholds: {
      artifact_coverage_rate_min: ARTIFACT_COVERAGE_RATE_MIN,
      memory_hit_rate_min: memoryHitRateMin,
      action_changed_by_memory_rate_min: actionChangedRateMin,
    },
    gates: {
      release_overall_status: cleanText(releaseReport?.overall_status) || "fail",
      release_blocking_checks: Array.isArray(releaseReport?.blocking_checks) ? releaseReport.blocking_checks : [],
      capability_gate_status: cleanText(releaseReport?.capability_gate?.status) || "unknown",
      experience_gate_status: cleanText(releaseReport?.experience_gate?.status) || "unknown",
      collab_gate_status: collabGateStatus,
      artifact_coverage_rate: normalizedArtifactCoverageRate,
      real_traffic_status: cleanText(realTrafficReport?.overall_status) || "unknown",
      real_traffic_blocking_reasons: Array.isArray(realTrafficReport?.blocking_reasons)
        ? realTrafficReport.blocking_reasons
        : [],
      memory_influence_status: memoryStatus,
    },
    evidence: {
      release_check_run_id: cleanText(releaseCheckResult?.release_check_archive?.run_id) || null,
      release_check_snapshot_path: cleanText(releaseCheckResult?.release_check_archive?.snapshot_path) || null,
      real_traffic_run_id: cleanText(realTrafficArchive?.run_id) || null,
      real_traffic_output_path: cleanText(realTrafficArchive?.output_path) || null,
      real_traffic_snapshot_path: cleanText(realTrafficArchive?.snapshot_path) || null,
    },
  };

  const latestPath = await writeJson(OUTPUT_LATEST_PATH, report);
  const history = await appendHistory(report);
  const output = {
    ...report,
    output_path: latestPath,
    history,
  };

  if (wantsJson) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(renderSummary(output));
    console.log(`output: ${latestPath}`);
  }

  if (output.overall_status !== "pass") {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(`collab-acceptance-pack error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

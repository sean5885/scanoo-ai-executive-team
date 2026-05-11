import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { cleanText } from "./message-intent-utils.mjs";

const LIVE_EVAL_HISTORY_MANIFEST_PATH = ".data/evals/live/history/manifest.json";
const DEFAULT_OUTPUT_PATH = ".data/evals/live/real-traffic-evidence-latest.json";
const DEFAULT_HISTORY_DIR = ".data/evals/live/real-traffic-history";
const REPORT_VERSION = "real_traffic_evidence_v1";

const WINDOW_HOURS = Object.freeze([24, 72, 336]);
const WINDOW_MIN_RUNS = Object.freeze({
  24: 1,
  72: 2,
  336: 4,
});

const THRESHOLDS = Object.freeze({
  task_success_rate_min: 0.85,
  fake_completion_rate_max: 0.02,
  evidence_coverage_rate_min: 1,
  pdf_task_success_rate_min: 0.9,
});

function toFiniteNumber(value = null, fallback = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return numeric;
}

function safeRatio(numerator = 0, denominator = 0, digits = 4) {
  const n = Number(numerator);
  const d = Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) {
    return null;
  }
  return Number((n / d).toFixed(digits));
}

function normalizeRunTimestamp(run = {}) {
  const parsed = Date.parse(cleanText(run?.generated_at));
  return Number.isFinite(parsed) ? parsed : null;
}

async function readJsonFile(filePath = "") {
  const raw = await readFile(path.resolve(filePath), "utf8");
  return JSON.parse(raw);
}

function classifyRunAgainstThresholds(runReport = {}, thresholds = THRESHOLDS) {
  const metrics = runReport?.metrics && typeof runReport.metrics === "object"
    ? runReport.metrics
    : runReport;
  const taskSuccessRate = toFiniteNumber(metrics?.task_success_rate, null);
  const fakeCompletionRate = toFiniteNumber(metrics?.fake_completion_rate, null);
  const evidenceCoverageRate = toFiniteNumber(metrics?.evidence_coverage_rate, null);
  const pdfTaskSuccessRate = toFiniteNumber(metrics?.pdf_task_success_rate, null);

  const reasons = [];
  if (taskSuccessRate == null || taskSuccessRate < thresholds.task_success_rate_min) {
    reasons.push("task_success_rate_below_threshold");
  }
  if (fakeCompletionRate == null || fakeCompletionRate > thresholds.fake_completion_rate_max) {
    reasons.push("fake_completion_rate_above_threshold");
  }
  if (evidenceCoverageRate == null || evidenceCoverageRate < thresholds.evidence_coverage_rate_min) {
    reasons.push("evidence_coverage_rate_below_threshold");
  }
  if (pdfTaskSuccessRate == null || pdfTaskSuccessRate < thresholds.pdf_task_success_rate_min) {
    reasons.push("pdf_task_success_rate_below_threshold");
  }

  return {
    ok: reasons.length === 0,
    reasons,
    metrics: {
      task_success_rate: taskSuccessRate,
      fake_completion_rate: fakeCompletionRate,
      evidence_coverage_rate: evidenceCoverageRate,
      pdf_task_success_rate: pdfTaskSuccessRate,
    },
  };
}

function normalizeWindowEntry({ hours = 24, minRuns = 1, runs = [] } = {}) {
  const passRuns = runs.filter((item) => item.ok === true);
  const failedRuns = runs.filter((item) => item.ok !== true);
  const sampleReady = runs.length >= minRuns;
  return {
    window_hours: hours,
    min_required_runs: minRuns,
    observed_runs: runs.length,
    sample_ready: sampleReady,
    pass_runs: passRuns.length,
    fail_runs: failedRuns.length,
    pass_rate: safeRatio(passRuns.length, runs.length),
    status: !sampleReady
      ? "unknown"
      : failedRuns.length === 0
        ? "pass"
        : "fail",
    failed_runs: failedRuns.map((item) => ({
      run_id: item.run_id,
      generated_at: item.generated_at,
      reasons: item.reasons,
      metrics: item.metrics,
    })),
  };
}

export async function buildRealTrafficEvidenceReport({
  manifestPath = LIVE_EVAL_HISTORY_MANIFEST_PATH,
  windows = WINDOW_HOURS,
  minRuns = WINDOW_MIN_RUNS,
  thresholds = THRESHOLDS,
} = {}) {
  let manifest;
  try {
    manifest = await readJsonFile(manifestPath);
  } catch (error) {
    return {
      version: REPORT_VERSION,
      generated_at: new Date().toISOString(),
      overall_status: "unknown",
      blocking_reasons: ["history_manifest_unavailable"],
      summary: "real traffic evidence history is unavailable",
      thresholds,
      windows: [],
      source: {
        manifest_path: manifestPath,
        history_available: false,
      },
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const snapshots = Array.isArray(manifest?.snapshots) ? manifest.snapshots : [];
  const now = Date.now();

  const loadedRuns = await Promise.all(snapshots.map(async (entry) => {
    const runId = cleanText(entry?.run_id) || null;
    const generatedAt = cleanText(entry?.generated_at) || null;
    const timestampMs = normalizeRunTimestamp(entry);
    const reportPath = cleanText(entry?.path);

    if (!runId || !reportPath || timestampMs == null) {
      return null;
    }

    try {
      const report = await readJsonFile(reportPath);
      const classified = classifyRunAgainstThresholds(report, thresholds);
      return {
        run_id: runId,
        generated_at: generatedAt,
        timestamp_ms: timestampMs,
        ...classified,
      };
    } catch {
      return {
        run_id: runId,
        generated_at: generatedAt,
        timestamp_ms: timestampMs,
        ok: false,
        reasons: ["run_snapshot_unreadable"],
        metrics: {
          task_success_rate: null,
          fake_completion_rate: null,
          evidence_coverage_rate: null,
          pdf_task_success_rate: null,
        },
      };
    }
  }));

  const validRuns = loadedRuns
    .filter((item) => item && Number.isFinite(item.timestamp_ms))
    .sort((a, b) => b.timestamp_ms - a.timestamp_ms);

  const windowReports = windows.map((hours) => {
    const safeHours = Number(hours);
    const cutoff = now - (safeHours * 60 * 60 * 1000);
    const runs = validRuns.filter((item) => item.timestamp_ms >= cutoff);
    return normalizeWindowEntry({
      hours: safeHours,
      minRuns: Number(minRuns?.[safeHours] || 1),
      runs,
    });
  });

  const blockingReasons = [];
  for (const window of windowReports) {
    if (window.sample_ready !== true) {
      blockingReasons.push(`window_${window.window_hours}h_sample_insufficient`);
      continue;
    }
    if (window.status !== "pass") {
      blockingReasons.push(`window_${window.window_hours}h_gate_fail`);
    }
  }

  const overallStatus = blockingReasons.length === 0
    ? "pass"
    : windowReports.every((item) => item.sample_ready !== true)
      ? "unknown"
      : "fail";

  return {
    version: REPORT_VERSION,
    generated_at: new Date().toISOString(),
    overall_status: overallStatus,
    blocking_reasons: blockingReasons,
    summary: overallStatus === "pass"
      ? "real traffic evidence windows are healthy"
      : overallStatus === "unknown"
        ? "real traffic evidence windows are not sample-ready"
        : "real traffic evidence windows have threshold failures",
    thresholds,
    windows: windowReports,
    source: {
      manifest_path: manifestPath,
      history_available: true,
      total_history_runs: validRuns.length,
      latest_run_id: cleanText(manifest?.latest_run_id) || null,
    },
  };
}

export async function writeRealTrafficEvidenceReport(report = {}, {
  outputPath = DEFAULT_OUTPUT_PATH,
  historyDir = DEFAULT_HISTORY_DIR,
} = {}) {
  const resolvedOutputPath = path.resolve(outputPath);
  const resolvedHistoryDir = path.resolve(historyDir);
  await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
  await mkdir(resolvedHistoryDir, { recursive: true });

  const runId = `real-traffic-evidence-${Date.now()}`;
  const snapshotPath = path.join(resolvedHistoryDir, `${runId}.json`);
  await writeFile(snapshotPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(resolvedOutputPath, `${JSON.stringify({ ...report, run_id: runId }, null, 2)}\n`, "utf8");

  return {
    run_id: runId,
    output_path: resolvedOutputPath,
    snapshot_path: snapshotPath,
  };
}

export async function readRealTrafficEvidenceLatest(outputPath = DEFAULT_OUTPUT_PATH) {
  try {
    return await readJsonFile(outputPath);
  } catch {
    return null;
  }
}

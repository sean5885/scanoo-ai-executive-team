import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { runControlDiagnostics } from "../src/control-diagnostics.mjs";
import { readExecutiveLiveMetrics } from "../src/executive-live-metrics.mjs";
import { cleanText } from "../src/message-intent-utils.mjs";
import { runSystemSelfCheck } from "../src/system-self-check.mjs";

const PRODUCTION_LATEST_PATH = process.env.PRODUCTION_EVAL_REPORT_PATH || ".data/evals/live/latest.json";
const PRODUCTION_HISTORY_MANIFEST_PATH = ".data/evals/live/history/manifest.json";
const DASHBOARD_OUTPUT_PATH = ".data/dashboard/quality-latest.json";

function safeNumber(value = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

async function readJsonFile(filePath = "") {
  const raw = await readFile(path.resolve(filePath), "utf8");
  return JSON.parse(raw);
}

async function readProductionEvalLatest() {
  try {
    return await readJsonFile(PRODUCTION_LATEST_PATH);
  } catch (error) {
    return {
      available: false,
      dataset_mode: "unknown",
      dataset_source: null,
      error: error instanceof Error ? error.message : String(error),
      task_success_rate: null,
      fake_completion_rate: null,
      evidence_coverage_rate: null,
      agent_parallel_efficiency: null,
      failed_cases: [],
    };
  }
}

async function readProductionTrend(maxCount = 10) {
  let manifest = null;
  try {
    manifest = await readJsonFile(PRODUCTION_HISTORY_MANIFEST_PATH);
  } catch {
    return [];
  }

  const snapshots = Array.isArray(manifest?.snapshots) ? manifest.snapshots : [];
  const picked = snapshots.slice(0, Math.max(1, maxCount));
  return picked.map((item) => ({
    run_id: cleanText(item?.run_id) || null,
    generated_at: cleanText(item?.generated_at) || null,
    task_success_rate: safeNumber(item?.task_success_rate),
    fake_completion_rate: safeNumber(item?.fake_completion_rate),
    evidence_coverage_rate: safeNumber(item?.evidence_coverage_rate),
    agent_parallel_efficiency: safeNumber(item?.agent_parallel_efficiency),
  }));
}

function buildDashboardReport({
  selfCheck = {},
  controlDiagnostics = {},
  productionEval = {},
  productionTrend = [],
  executiveLiveMetrics = {},
} = {}) {
  const failedCases = Array.isArray(productionEval?.failed_cases) ? productionEval.failed_cases : [];

  return {
    version: "quality_dashboard_v1",
    generated_at: new Date().toISOString(),
    self_check: {
      ok: selfCheck?.ok === true,
      system_status: cleanText(selfCheck?.system_summary?.status) || "fail",
      decision_os_score: safeNumber(selfCheck?.decision_os_observability?.readiness_score?.score),
      decision_os_level: cleanText(selfCheck?.decision_os_observability?.readiness_score?.level) || "unknown",
    },
    control_diagnostics: {
      ok: controlDiagnostics?.ok === true,
      overall_status: cleanText(controlDiagnostics?.diagnostics_summary?.overall_status) || "fail",
      control_status: cleanText(controlDiagnostics?.diagnostics_summary?.control_status) || "fail",
      routing_status: cleanText(controlDiagnostics?.diagnostics_summary?.routing_status) || "fail",
      write_status: cleanText(controlDiagnostics?.diagnostics_summary?.write_status) || "fail",
    },
    production_eval: {
      available: productionEval?.available !== false,
      dataset_mode: cleanText(productionEval?.dataset_mode) || "unknown",
      dataset_source: cleanText(productionEval?.dataset_source) || null,
      task_success_rate: safeNumber(productionEval?.task_success_rate),
      fake_completion_rate: safeNumber(productionEval?.fake_completion_rate),
      evidence_coverage_rate: safeNumber(productionEval?.evidence_coverage_rate),
      agent_parallel_efficiency: safeNumber(productionEval?.agent_parallel_efficiency),
      failed_case_count: failedCases.length,
      failed_cases: failedCases,
      sample_size: productionEval?.sample_size || null,
      counts: productionEval?.counts || null,
      trend: productionTrend,
    },
    executive_live_metrics: executiveLiveMetrics && typeof executiveLiveMetrics === "object"
      ? executiveLiveMetrics
      : null,
    collab_sample_readiness: executiveLiveMetrics?.collab_sample_readiness || null,
  };
}

function renderCliSummary(report = {}) {
  const production = report?.production_eval || {};
  const collabReadiness = report?.collab_sample_readiness || {};
  const collabReady = collabReadiness?.sample_ready === true;
  const collabMissing = Array.isArray(collabReadiness?.missing_requirements) && collabReadiness.missing_requirements.length
    ? collabReadiness.missing_requirements.join(",")
    : "none";
  return [
    "Quality Dashboard",
    `self-check: ${report?.self_check?.system_status || "fail"}`,
    `control-diagnostics: ${report?.control_diagnostics?.overall_status || "fail"}`,
    `task_success_rate: ${production.task_success_rate ?? "null"}`,
    `fake_completion_rate: ${production.fake_completion_rate ?? "null"}`,
    `evidence_coverage_rate: ${production.evidence_coverage_rate ?? "null"}`,
    `agent_parallel_efficiency: ${production.agent_parallel_efficiency ?? "null"}`,
    `failed_cases: ${production.failed_case_count ?? 0}`,
    `collab_sample_ready: ${collabReady ? "true" : "false"}`,
    `collab_sample_missing: ${collabMissing}`,
  ].join("\n");
}

async function writeDashboardReport(report = {}) {
  const resolvedPath = path.resolve(DASHBOARD_OUTPUT_PATH);
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return resolvedPath;
}

async function main() {
  const wantsJson = process.argv.includes("--json");
  const [selfCheck, controlDiagnostics, productionEval, productionTrend, executiveLiveMetrics] = await Promise.all([
    runSystemSelfCheck(),
    runControlDiagnostics(),
    readProductionEvalLatest(),
    readProductionTrend(),
    Promise.resolve(readExecutiveLiveMetrics()),
  ]);

  const dashboard = buildDashboardReport({
    selfCheck,
    controlDiagnostics,
    productionEval,
    productionTrend,
    executiveLiveMetrics,
  });
  const outputPath = await writeDashboardReport(dashboard);

  if (wantsJson) {
    console.log(JSON.stringify({ ...dashboard, output_path: outputPath }, null, 2));
  } else {
    console.log(renderCliSummary(dashboard));
    console.log(`output: ${outputPath}`);
  }

  if (dashboard?.self_check?.ok !== true || dashboard?.control_diagnostics?.ok !== true) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(`quality-dashboard error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

import { readFile } from "node:fs/promises";
import path from "node:path";

function getArgValue(flag = "") {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return "";
  }
  return process.argv[index + 1] || "";
}

function toNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatRate(value, digits = 4) {
  const numeric = toNumber(value, null);
  if (numeric == null) {
    return "unknown";
  }
  return numeric.toFixed(digits);
}

function buildAcceptanceReport(selfCheckResult = {}) {
  const truthful = selfCheckResult?.truthful_completion_metrics || {};
  const thresholds = truthful?.thresholds || {};
  const metrics = truthful?.metrics || {};

  const checks = [
    {
      id: "pdf_task_success_rate",
      passed: toNumber(metrics.pdf_task_success_rate, null) != null
        && toNumber(metrics.pdf_task_success_rate, 0) >= toNumber(thresholds.pdf_success_rate_min, 0.9),
      actual: formatRate(metrics.pdf_task_success_rate),
      target: `>=${formatRate(thresholds.pdf_success_rate_min || 0.9, 1)}`,
    },
    {
      id: "pdf_min_case_count",
      passed: toNumber(metrics.pdf_e2e_total, 0) >= toNumber(thresholds.pdf_min_case_count, 50),
      actual: String(toNumber(metrics.pdf_e2e_total, 0)),
      target: `>=${String(toNumber(thresholds.pdf_min_case_count, 50))}`,
    },
    {
      id: "fake_completion_rate",
      passed: toNumber(metrics.fake_completion_rate, null) != null
        && toNumber(metrics.fake_completion_rate, 1) < toNumber(thresholds.fake_completion_rate_max, 0.02),
      actual: formatRate(metrics.fake_completion_rate),
      target: `<${formatRate(thresholds.fake_completion_rate_max || 0.02, 2)}`,
    },
    {
      id: "verifier_coverage_rate",
      passed: toNumber(metrics.verifier_coverage_rate, null) != null
        && toNumber(metrics.verifier_coverage_rate, 0) >= toNumber(thresholds.verifier_coverage_rate_min, 1),
      actual: formatRate(metrics.verifier_coverage_rate),
      target: `>=${formatRate(thresholds.verifier_coverage_rate_min || 1, 1)}`,
    },
    {
      id: "parallel_ratio",
      passed: toNumber(metrics.parallel_ratio, null) != null
        && toNumber(metrics.parallel_ratio, 0) >= toNumber(thresholds.parallel_ratio_min, 0.4),
      actual: formatRate(metrics.parallel_ratio),
      target: `>=${formatRate(thresholds.parallel_ratio_min || 0.4, 1)}`,
    },
    {
      id: "blocked_misreported_completed_count",
      passed: toNumber(metrics.blocked_misreported_completed_count, 1) <= toNumber(thresholds.blocked_misreported_completed_max, 0),
      actual: String(toNumber(metrics.blocked_misreported_completed_count, 0)),
      target: `<=${String(toNumber(thresholds.blocked_misreported_completed_max, 0))}`,
    },
    {
      id: "documentation_consistency_rate",
      passed: toNumber(metrics.documentation_consistency_rate, null) != null
        && toNumber(metrics.documentation_consistency_rate, 0) >= toNumber(thresholds.documentation_consistency_rate_min, 1),
      actual: formatRate(metrics.documentation_consistency_rate),
      target: `>=${formatRate(thresholds.documentation_consistency_rate_min || 1, 1)}`,
    },
  ];

  const failedChecks = checks.filter((item) => item.passed !== true);
  return {
    version: "truthful_completion_acceptance_v1",
    generated_at: new Date().toISOString(),
    source: {
      self_check_run_id: selfCheckResult?.self_check_archive?.run_id || null,
      truthful_metrics_version: truthful?.version || null,
    },
    overall_status: failedChecks.length === 0 ? "pass" : "fail",
    check_count: checks.length,
    failed_check_count: failedChecks.length,
    failed_check_ids: failedChecks.map((item) => item.id),
    checks,
  };
}

function renderHuman(report = {}) {
  const lines = [
    `truthful completion acceptance: ${report?.overall_status === "pass" ? "PASS" : "FAIL"}`,
    `failed checks: ${Number(report?.failed_check_count || 0)}/${Number(report?.check_count || 0)}`,
  ];
  for (const check of Array.isArray(report?.checks) ? report.checks : []) {
    lines.push(
      `- ${check.id}: ${check.passed === true ? "pass" : "fail"} (actual=${check.actual}, target=${check.target})`,
    );
  }
  return lines.join("\n");
}

async function loadSelfCheckResult() {
  const fromPath = getArgValue("--from");
  if (fromPath) {
    const absolute = path.resolve(fromPath);
    const raw = await readFile(absolute, "utf8");
    return JSON.parse(raw);
  }
  const { runSystemSelfCheck } = await import("../src/system-self-check.mjs");
  return runSystemSelfCheck();
}

try {
  const wantsJson = process.argv.includes("--json");
  const selfCheckResult = await loadSelfCheckResult();
  const report = buildAcceptanceReport(selfCheckResult);
  if (wantsJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderHuman(report));
  }
  if (report.overall_status !== "pass") {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`truthful-completion-acceptance error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

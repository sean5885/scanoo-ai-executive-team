import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function getArgValue(flag = "") {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return "";
  }
  return process.argv[index + 1] || "";
}

function printUsage() {
  console.log([
    "Usage:",
    "  node scripts/metrics-baseline.mjs",
    "  node scripts/metrics-baseline.mjs --out .tmp/metrics/baseline.json",
    "  node scripts/metrics-baseline.mjs --json",
  ].join("\n"));
}

function toNumberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function buildBaselinePayload(selfCheckResult = {}) {
  const truthful = selfCheckResult?.truthful_completion_metrics || {};
  const metrics = truthful?.metrics || {};
  const thresholds = truthful?.thresholds || {};

  return {
    version: "metrics-baseline-v1",
    generated_at: new Date().toISOString(),
    source: {
      script: "scripts/metrics-baseline.mjs",
      self_check_archive_run_id: selfCheckResult?.self_check_archive?.run_id || null,
    },
    status: truthful?.status || "unknown",
    summary: truthful?.summary || "truthful completion metrics unavailable",
    thresholds: {
      pdf_success_rate_min: toNumberOrNull(thresholds.pdf_success_rate_min),
      pdf_min_case_count: toNumberOrNull(thresholds.pdf_min_case_count),
      fake_completion_rate_max: toNumberOrNull(thresholds.fake_completion_rate_max),
      verifier_coverage_rate_min: toNumberOrNull(thresholds.verifier_coverage_rate_min),
      parallel_ratio_min: toNumberOrNull(thresholds.parallel_ratio_min),
      blocked_misreported_completed_max: toNumberOrNull(thresholds.blocked_misreported_completed_max),
      documentation_consistency_rate_min: toNumberOrNull(thresholds.documentation_consistency_rate_min),
    },
    metrics: {
      important_task_total: toNumberOrNull(metrics.important_task_total),
      pdf_e2e_pass: toNumberOrNull(metrics.pdf_e2e_pass),
      pdf_e2e_total: toNumberOrNull(metrics.pdf_e2e_total),
      pdf_task_success_rate: toNumberOrNull(metrics.pdf_task_success_rate),
      pdf_acceptance_case_coverage_fail: metrics.pdf_acceptance_case_coverage_fail === true,
      pdf_acceptance_success_rate_fail: metrics.pdf_acceptance_success_rate_fail === true,
      pdf_acceptance_hard_gate_fail: metrics.pdf_acceptance_hard_gate_fail === true,
      fake_completion_count: toNumberOrNull(metrics.fake_completion_count),
      fake_completion_rate: toNumberOrNull(metrics.fake_completion_rate),
      verifier_covered_count: toNumberOrNull(metrics.verifier_covered_count),
      verifier_coverage_rate: toNumberOrNull(metrics.verifier_coverage_rate),
      parallel_step_count: toNumberOrNull(metrics.parallel_step_count),
      total_step_count: toNumberOrNull(metrics.total_step_count),
      parallel_ratio: toNumberOrNull(metrics.parallel_ratio),
      blocked_misreported_completed_count: toNumberOrNull(metrics.blocked_misreported_completed_count),
      documentation_consistency_rate: toNumberOrNull(metrics.documentation_consistency_rate),
      sample_ready_for_gate: metrics.sample_ready_for_gate === true,
    },
  };
}

async function writeJson(targetPath, payload) {
  const outputPath = path.resolve(targetPath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return outputPath;
}

async function run() {
  if (process.argv.includes("--help")) {
    printUsage();
    return;
  }

  const wantsJson = process.argv.includes("--json");
  const outPath = getArgValue("--out");

  const { runSystemSelfCheck } = await import("../src/system-self-check.mjs");
  const result = await runSystemSelfCheck();
  const baseline = buildBaselinePayload(result);

  if (outPath) {
    const writtenPath = await writeJson(outPath, baseline);
    if (!wantsJson) {
      console.log(`metrics baseline written: ${writtenPath}`);
    }
  }

  if (wantsJson || !outPath) {
    console.log(JSON.stringify(baseline, null, 2));
  }
}

run().catch((error) => {
  console.error(`metrics-baseline error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

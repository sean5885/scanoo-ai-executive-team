import test from "node:test";
import assert from "node:assert/strict";

const [
  { productionLikePacks, productionLikeCases },
  { computeQualityMetrics },
] = await Promise.all([
  import("../evals/production-like/index.mjs"),
  import("../src/quality-metrics.mjs"),
]);

test("production-like packs provide 4 packs and at least 100 cases", () => {
  assert.equal(productionLikePacks.length, 4);
  assert.equal(productionLikeCases.length, 100);
  for (const pack of productionLikePacks) {
    assert.equal(Array.isArray(pack.cases), true);
    assert.equal(pack.cases.length, 25);
  }
});

test("quality metrics formulas follow fixed definition", () => {
  const summary = computeQualityMetrics(productionLikeCases);

  assert.equal(summary.sample_size.total_tasks, 100);
  assert.equal(summary.sample_size.important_task_total, 100);
  assert.equal(summary.counts.passed_tasks, 89);
  assert.equal(summary.metrics.task_success_rate, 0.89);

  assert.equal(summary.counts.fake_completion_count, 1);
  assert.equal(summary.metrics.fake_completion_rate, 0.01);

  assert.equal(summary.counts.artifacts_present_required, summary.counts.artifacts_required_total);
  assert.equal(summary.metrics.evidence_coverage_rate, 1);

  assert.equal(summary.metrics.agent_parallel_efficiency > 1, true);
  assert.equal(summary.metrics.pdf_task_success_rate, 0.9);

  assert.equal(summary.counts.tool_permission_violation_count, 0);
  assert.equal(summary.counts.blocked_misreported_completed_count, 0);
  assert.equal(summary.flags.routing_planner_regression, false);

  assert.equal(Array.isArray(summary.failed_cases), true);
  assert.equal(summary.failed_cases.length > 0, true);
  for (const item of summary.failed_cases) {
    assert.equal(typeof item.trace_id, "string");
    assert.equal(typeof item.task_id, "string");
    assert.equal(typeof item.node_id, "string");
  }
});

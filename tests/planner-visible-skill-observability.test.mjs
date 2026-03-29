import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const {
  renderPlannerVisibleSkillObservabilityReport,
  runPlannerVisibleSkillObservabilityCheck,
} = await import("../src/planner-visible-skill-observability.mjs");

test.after(() => {
  testDb.close();
});

test("planner-visible skill observability check stays green and keeps rollback triggers inactive", async () => {
  const report = await runPlannerVisibleSkillObservabilityCheck();

  assert.equal(report.ok, true);
  assert.equal(report.decision, "allow_guarded_future_promotion");
  assert.equal(report.summary.planner_selected_document_summarize, true);
  assert.deepEqual(report.summary.selector_key_hit_rate, {
    hits: 2,
    total: 2,
    ratio: 1,
  });
  assert.equal(report.summary.fallback_count, 0);
  assert.equal(report.summary.fail_closed_count, 0);
  assert.deepEqual(report.summary.skill_surface_split, {
    planner_visible: 2,
    internal_only: 0,
    planner_visible_ratio: 1,
    internal_only_ratio: 0,
  });
  assert.deepEqual(report.safety, {
    answer_pipeline_before_user_response: true,
    raw_payload_exposed: false,
    selector_drift_detected: false,
    routing_unchanged: true,
    fail_closed_guard_verified: true,
  });
  assert.equal(report.rollback.should_rollback, false);
  assert.deepEqual(report.rollback.triggered_conditions, []);
  assert.deepEqual(report.rollback.observed, {
    selector_drift: false,
    answer_bypass: false,
    regression_break: false,
    routing_mismatch: false,
  });
  assert.equal(report.future_expansion.second_planner_visible_skill_allowed, true);
  assert.equal(report.future_expansion.automatic_promotion, false);
  assert.equal(report.cases.success_probe.ok, true);
  assert.equal(report.cases.fail_closed_probe.ok, true);
  assert.equal(report.cases.routing_guard.ok, true);
});

test("planner-visible skill observability report renderer exposes the main guard lines", async () => {
  const report = await runPlannerVisibleSkillObservabilityCheck();
  const text = renderPlannerVisibleSkillObservabilityReport(report);

  assert.match(text, /Planner-Visible Skill Observability/);
  assert.match(text, /decision: allow_guarded_future_promotion/);
  assert.match(text, /selector_key_hit_rate=2\/2 \(1\)/);
  assert.match(text, /rollback: should_rollback=false \| triggered=none/);
  assert.match(text, /future: second_planner_visible_skill_allowed=true \| automatic_promotion=false/);
});

test("planner-visible skill check CLI renders the same green summary", () => {
  const output = execFileSync("node", ["scripts/planner-visible-skill-check.mjs"], {
    cwd: process.cwd(),
    env: testDb.env,
  }).toString();

  assert.match(output, /Planner-Visible Skill Observability/);
  assert.match(output, /decision: allow_guarded_future_promotion/);
  assert.match(output, /selector_key_hit_rate=2\/2 \(1\)/);
  assert.match(output, /rollback: should_rollback=false \| triggered=none/);
});

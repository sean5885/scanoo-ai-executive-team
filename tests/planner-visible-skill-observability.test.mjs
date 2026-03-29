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
  assert.equal(report.decision, "allow_two_planner_visible_skills");
  assert.equal(report.summary.planner_selected_document_summarize, true);
  assert.deepEqual(report.summary.selector_key_hit_rate, {
    hits: 3,
    total: 3,
    ratio: 1,
  });
  assert.deepEqual(report.summary.selector_hit_rate_per_skill, {
    search_and_summarize: {
      hits: 2,
      total: 2,
      ratio: 1,
    },
    document_summarize: {
      hits: 1,
      total: 1,
      ratio: 1,
    },
  });
  assert.equal(report.summary.fallback_count, 0);
  assert.equal(report.summary.fail_closed_count, 2);
  assert.equal(report.summary.fail_closed_ratio, 0.5);
  assert.equal(report.summary.ambiguity_trigger_count, 1);
  assert.deepEqual(report.summary.routing_fallback_distribution, {
    search_company_brain_docs: 2,
    search_and_detail_doc: 2,
  });
  assert.deepEqual(report.summary.skill_surface_split, {
    planner_visible: 3,
    internal_only: 0,
    planner_visible_ratio: 1,
    internal_only_ratio: 0,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(report.query_types)), {
    search_and_summarize: {
      total: 1,
      ok: 1,
      fail_closed_count: 0,
      fail_closed_ratio: 0,
      ambiguity_trigger_count: 0,
      planner_visible_hits: 1,
      routing_fallback_distribution: {
        search_company_brain_docs: 1,
      },
    },
    detail_summary: {
      total: 1,
      ok: 1,
      fail_closed_count: 0,
      fail_closed_ratio: 0,
      ambiguity_trigger_count: 0,
      planner_visible_hits: 1,
      routing_fallback_distribution: {
        search_and_detail_doc: 1,
      },
    },
    mixed_query: {
      total: 1,
      ok: 1,
      fail_closed_count: 1,
      fail_closed_ratio: 1,
      ambiguity_trigger_count: 1,
      planner_visible_hits: 0,
      routing_fallback_distribution: {
        search_company_brain_docs: 1,
      },
    },
    follow_up_reference: {
      total: 1,
      ok: 1,
      fail_closed_count: 1,
      fail_closed_ratio: 1,
      ambiguity_trigger_count: 0,
      planner_visible_hits: 0,
      routing_fallback_distribution: {
        search_and_detail_doc: 1,
      },
    },
  });
  assert.deepEqual(report.safety, {
    answer_pipeline_before_user_response: true,
    raw_payload_exposed: false,
    selector_overlap_detected: false,
    routing_unchanged: true,
    fail_closed_guard_verified: true,
  });
  assert.equal(report.rollback.should_rollback, false);
  assert.deepEqual(report.rollback.triggered_conditions, []);
  assert.deepEqual(report.rollback.observed, {
    selector_overlap_threshold_exceeded: false,
    fail_closed_rate_anomalous: false,
    routing_mismatch: false,
    answer_inconsistency: false,
  });
  assert.equal(report.future_expansion.second_planner_visible_skill_allowed, true);
  assert.equal(report.future_expansion.automatic_promotion, false);
  assert.equal(report.cases.success_probe.search_and_summarize.ok, true);
  assert.equal(report.cases.success_probe.document_summarize.ok, true);
  assert.equal(report.cases.fail_closed_probe.ok, true);
  assert.deepEqual(report.cases.routing_guard.map((item) => item.ok), [true, true]);
  assert.deepEqual(
    report.cases.query_type_watch.map((item) => ({
      case_id: item.case_id,
      fail_closed: item.fail_closed,
      ambiguity_triggered: item.ambiguity_triggered,
      fallback_action: item.fallback_action,
    })),
    [
      {
        case_id: "query_type_search_and_summarize",
        fail_closed: false,
        ambiguity_triggered: false,
        fallback_action: "search_company_brain_docs",
      },
      {
        case_id: "query_type_detail_summary",
        fail_closed: false,
        ambiguity_triggered: false,
        fallback_action: "search_and_detail_doc",
      },
      {
        case_id: "query_type_mixed_query",
        fail_closed: true,
        ambiguity_triggered: true,
        fallback_action: "search_company_brain_docs",
      },
      {
        case_id: "query_type_follow_up_reference",
        fail_closed: true,
        ambiguity_triggered: false,
        fallback_action: "search_and_detail_doc",
      },
    ],
  );
});

test("planner-visible skill observability report renderer exposes the main guard lines", async () => {
  const report = await runPlannerVisibleSkillObservabilityCheck();
  const text = renderPlannerVisibleSkillObservabilityReport(report);

  assert.match(text, /Planner-Visible Multi-Skill Observability/);
  assert.match(text, /decision: allow_two_planner_visible_skills/);
  assert.match(text, /selector_key_hit_rate=3\/3 \(1\)/);
  assert.match(text, /selector_hit_rate_per_skill=search_and_summarize=2\/2 \(1\), document_summarize=1\/1 \(1\)/);
  assert.match(text, /fail_closed=2 \(0\.5\)/);
  assert.match(text, /routing_fallback_distribution: search_company_brain_docs:2, search_and_detail_doc:2/);
  assert.match(text, /query_types: search_and_summarize=fail_closed:0\/1, ambiguity:0 \| detail_summary=fail_closed:0\/1, ambiguity:0 \| mixed_query=fail_closed:1\/1, ambiguity:1 \| follow_up_reference=fail_closed:1\/1, ambiguity:0/);
  assert.match(text, /rollback: should_rollback=false \| triggered=none/);
  assert.match(text, /future: second_planner_visible_skill_allowed=true \| automatic_promotion=false/);
});

test("planner-visible skill check CLI renders the same green summary", () => {
  const output = execFileSync("node", ["scripts/planner-visible-skill-check.mjs"], {
    cwd: process.cwd(),
    env: testDb.env,
  }).toString();

  assert.match(output, /Planner-Visible Multi-Skill Observability/);
  assert.match(output, /decision: allow_two_planner_visible_skills/);
  assert.match(output, /selector_key_hit_rate=3\/3 \(1\)/);
  assert.match(output, /rollback: should_rollback=false \| triggered=none/);
});

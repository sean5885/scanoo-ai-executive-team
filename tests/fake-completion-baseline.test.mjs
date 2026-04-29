import test from "node:test";
import assert from "node:assert/strict";

import { EVIDENCE_TYPES, verifyTaskCompletion } from "../src/executive-verifier.mjs";

function buildBaselineVerificationCases() {
  return [
    {
      id: "search-with-evidence-pass",
      taskType: "search",
      replyText: "根據文件，A 方案成本較低。",
      evidence: [
        { type: EVIDENCE_TYPES.tool_output, summary: "retrieved_docs:3" },
      ],
      expectedFakeCompletion: false,
      expectedPass: true,
    },
    {
      id: "search-reply-only-fake",
      taskType: "search",
      replyText: "我已查完，完整確認沒有問題。",
      evidence: [],
      expectedFakeCompletion: true,
      expectedPass: false,
    },
    {
      id: "summarize-with-summary-evidence-pass",
      taskType: "summarize",
      replyText: "重點有三項。",
      evidence: [
        { type: EVIDENCE_TYPES.summary_generated, summary: "summary_ready" },
      ],
      expectedFakeCompletion: false,
      expectedPass: true,
    },
    {
      id: "summarize-missing-evidence-fake",
      taskType: "summarize",
      replyText: "我已整理完成。",
      evidence: [],
      expectedFakeCompletion: true,
      expectedPass: false,
    },
    {
      id: "tool-required-without-dispatch-not-completed",
      taskType: "search",
      executionJournal: {
        classified_intent: "search",
        selected_action: "search_company_brain_docs",
        dispatched_actions: [],
        raw_evidence: [
          { type: EVIDENCE_TYPES.summary_generated, summary: "reply_only", source: "reply_text" },
        ],
        fallback_used: false,
        tool_required: true,
        reply_text: "這題已完成。",
      },
      expectedFakeCompletion: true,
      expectedPass: false,
    },
    {
      id: "decision-support-with-tool-evidence-pass",
      taskType: "decision_support",
      replyText: "建議先走分批 rollout。",
      evidence: [
        { type: EVIDENCE_TYPES.tool_output, summary: "supporting_evidence:2" },
      ],
      expectedFakeCompletion: false,
      expectedPass: true,
    },
  ];
}

function computeFakeCompletionBaseline(cases = []) {
  const results = cases.map((item) => ({
    id: item.id,
    verification: verifyTaskCompletion(item),
  }));
  const fakeCompletionCount = results.filter((item) => item.verification.fake_completion === true).length;
  const passCount = results.filter((item) => item.verification.pass === true).length;

  return {
    total: results.length,
    fake_completion_count: fakeCompletionCount,
    fake_completion_rate: Number((fakeCompletionCount / results.length).toFixed(4)),
    pass_count: passCount,
    pass_rate: Number((passCount / results.length).toFixed(4)),
    results,
  };
}

test("fake completion baseline fixture stays deterministic", () => {
  const cases = buildBaselineVerificationCases();
  assert.equal(cases.length, 6);
});

test("fake completion baseline metrics are stable", () => {
  const cases = buildBaselineVerificationCases();
  const baseline = computeFakeCompletionBaseline(cases);

  for (const item of baseline.results) {
    const source = cases.find((entry) => entry.id === item.id);
    assert.equal(item.verification.fake_completion, source.expectedFakeCompletion, item.id);
    assert.equal(item.verification.pass, source.expectedPass, item.id);
  }

  assert.equal(baseline.total, 6);
  assert.equal(baseline.fake_completion_count, 3);
  assert.equal(baseline.fake_completion_rate, 0.5);
  assert.equal(baseline.pass_count, 3);
  assert.equal(baseline.pass_rate, 0.5);
});

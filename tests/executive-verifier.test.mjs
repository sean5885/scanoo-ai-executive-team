import test from "node:test";
import assert from "node:assert/strict";

import { EVIDENCE_TYPES, verifyTaskCompletion } from "../src/executive-verifier.mjs";

test("verifier rejects completion without evidence", () => {
  const result = verifyTaskCompletion({
    taskType: "search",
    replyText: "我已經查完了。",
    evidence: [],
  });

  assert.equal(result.pass, false);
  assert.equal(result.required_evidence_present, false);
  assert.equal(result.fake_completion, true);
});

test("meeting verifier flags missing owner and deadline", () => {
  const result = verifyTaskCompletion({
    taskType: "meeting_processing",
    replyText: "會議紀要已整理。",
    structuredResult: {
      summary: "summary",
      decisions: ["確認先做 beta"],
      action_items: [{ title: "整理 PRD", owner: "待確認", deadline: "待確認" }],
      knowledge_writeback: { required: true, proposals: [] },
    },
    evidence: [
      { type: EVIDENCE_TYPES.summary_generated, summary: "meeting_summary" },
      { type: EVIDENCE_TYPES.structured_output, summary: "meeting_output_schema" },
    ],
  });

  assert.equal(result.pass, false);
  assert.match(result.issues.join(" "), /owner|deadline/);
});

test("verifier passes when summary has evidence and structured result", () => {
  const result = verifyTaskCompletion({
    taskType: "summarize",
    replyText: "我已整理出三個重點。",
    evidence: [
      { type: EVIDENCE_TYPES.tool_output, summary: "retrieved_sources:3" },
      { type: EVIDENCE_TYPES.summary_generated, summary: "summary_text" },
      { type: EVIDENCE_TYPES.structured_output, summary: "summary_schema" },
    ],
  });

  assert.equal(result.pass, true);
});

test("reply text alone cannot satisfy verifier for tool-backed search", () => {
  const result = verifyTaskCompletion({
    taskType: "search",
    executionJournal: {
      classified_intent: "search",
      selected_action: "search_company_brain_docs",
      dispatched_actions: [{ action: "search_company_brain_docs", status: "attempted" }],
      raw_evidence: [
        { type: EVIDENCE_TYPES.summary_generated, summary: "reply_text_present", source: "reply_text" },
      ],
      fallback_used: false,
      tool_required: false,
      reply_text: "我已經整理好了。",
    },
  });

  assert.equal(result.pass, false);
  assert.equal(result.required_evidence_present, false);
  assert.match(result.issues.join(" "), /insufficient_evidence/);
});

test("supporting outputs cannot satisfy verifier as tool evidence", () => {
  const result = verifyTaskCompletion({
    taskType: "search",
    executionJournal: {
      classified_intent: "search",
      selected_action: "search_company_brain_docs",
      dispatched_actions: [{ action: "search_company_brain_docs", status: "attempted" }],
      raw_evidence: [
        { type: EVIDENCE_TYPES.summary_generated, summary: "reply_text_present", source: "reply_text" },
        { source: "supporting_outputs", summary: "supporting_agents:2" },
      ],
      fallback_used: false,
      tool_required: false,
    },
  });

  assert.equal(result.pass, false);
  assert.equal(result.required_evidence_present, false);
  assert.match(result.issues.join(" "), /insufficient_evidence/);
});

test("synthetic agent hint cannot count as execution evidence", () => {
  const result = verifyTaskCompletion({
    taskType: "search",
    executionJournal: {
      classified_intent: "search",
      selected_action: "search_company_brain_docs",
      dispatched_actions: [{ action: "search_company_brain_docs", status: "attempted" }],
      raw_evidence: [
        { type: EVIDENCE_TYPES.summary_generated, summary: "reply_text_present", source: "reply_text" },
      ],
      fallback_used: false,
      tool_required: false,
      synthetic_agent_hint: {
        agent: "doc_agent",
        action: "doc_answer",
        status: "ok",
      },
    },
  });

  assert.equal(result.pass, false);
  assert.equal(result.required_evidence_present, false);
  assert.match(result.issues.join(" "), /insufficient_evidence/);
});

test("expected schema missing fields are flagged as partial completion", () => {
  const result = verifyTaskCompletion({
    taskType: "meeting_processing",
    structuredResult: {
      summary: "會議摘要",
      action_items: [{ title: "補齊規格", owner: "Amy", deadline: "2026-05-31" }],
      knowledge_writeback: { proposals: [] },
    },
    expectedOutputSchema: {
      summary: "string",
      decisions: "array",
      action_items: "array",
    },
    evidence: [
      { type: EVIDENCE_TYPES.summary_generated, summary: "meeting_summary" },
      { type: EVIDENCE_TYPES.structured_output, summary: "meeting_structured_result" },
    ],
  });

  assert.equal(result.pass, false);
  assert.equal(result.partial_completion, true);
  assert.match(result.issues.join(" "), /missing_fields/);
  assert.match(result.issues.join(" "), /missing_field:decisions/);
});

test("overclaim language is blocked when search evidence is missing", () => {
  const result = verifyTaskCompletion({
    taskType: "search",
    replyText: "我已確認一定完全沒有問題。",
    evidence: [],
  });

  assert.equal(result.pass, false);
  assert.equal(result.overclaim, true);
  assert.match(result.issues.join(" "), /overclaim/);
});

test("subtask artifact evidence gate blocks completion when any subtask evidence is unverifiable", () => {
  const result = verifyTaskCompletion({
    taskType: "search",
    executionJournal: {
      classified_intent: "search",
      selected_action: "search_company_brain_docs",
      dispatched_actions: [{ action: "search_company_brain_docs", status: "attempted" }],
      raw_evidence: [
        { type: EVIDENCE_TYPES.tool_output, summary: "retrieved_sources:1", source: "reply_metadata" },
        { type: EVIDENCE_TYPES.summary_generated, summary: "reply_text_present", source: "reply_text" },
      ],
      subtask_artifacts: [
        {
          artifact_id: "consult:task-1",
          agent_id: "consult",
          task: "查證工具結果",
          status: "failed",
          required_evidence: ["tool_output"],
          observed_evidence: ["summary_generated"],
          missing_required_evidence: ["tool_output"],
          verifiable: false,
          error: "subtask_artifact_missing_evidence",
        },
      ],
      merge_evidence_gate: {
        pass: false,
        total_subtasks: 1,
        verifiable_subtasks: 0,
        failing_subtasks: [
          {
            artifact_id: "consult:task-1",
            agent_id: "consult",
            task: "查證工具結果",
            missing_required_evidence: ["tool_output"],
          },
        ],
      },
      fallback_used: false,
      tool_required: false,
      reply_text: "先給你初稿。",
    },
  });

  assert.equal(result.pass, false);
  assert.equal(result.required_evidence_present, false);
  assert.equal(result.partial_completion, true);
  assert.equal(result.execution_policy_state, "blocked");
  assert.equal(result.execution_policy_reason, "subtask_evidence_missing");
  assert.match(result.issues.join(" "), /subtask_evidence_missing/);
});

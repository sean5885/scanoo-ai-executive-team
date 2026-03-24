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

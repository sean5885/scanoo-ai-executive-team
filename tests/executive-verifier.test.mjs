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

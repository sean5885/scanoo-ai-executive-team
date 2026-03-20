import test from "node:test";
import assert from "node:assert/strict";

import { createReflectionRecord, EXECUTIVE_ERROR_TAXONOMY } from "../src/executive-reflection.mjs";

test("reflection records fake completion and robotic response", () => {
  const reflection = createReflectionRecord({
    task: {
      id: "task-1",
      task_type: "meeting_processing",
      current_agent_id: "generalist",
      objective: "整理會議紀要",
    },
    requestText: "幫我整理會議並標出待確認項",
    replyText: "任務已啟動，請稍候。",
    evidence: [],
    verification: {
      pass: false,
      fake_completion: true,
      issues: ["insufficient_evidence", "robotic_response"],
      required_evidence_present: false,
    },
    routing: {
      current_agent_id: "generalist",
      reason: "default",
    },
  });

  assert.equal(reflection.task_type, "meeting_processing");
  assert.match(reflection.what_went_wrong.join(" "), /fake_completion/);
  assert.equal(reflection.response_quality.robotic_response, true);
  assert.equal(reflection.task_input, "幫我整理會議並標出待確認項");
  assert.equal(reflection.error_type, "fake_completion");
  assert.ok(EXECUTIVE_ERROR_TAXONOMY.includes("robotic_response"));
});

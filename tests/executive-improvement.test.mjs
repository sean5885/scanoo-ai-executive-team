import test from "node:test";
import assert from "node:assert/strict";

import { createImprovementProposals } from "../src/executive-improvement.mjs";

test("improvement engine emits verification and meeting proposals from reflection", () => {
  const proposals = createImprovementProposals({
    reflection: {
      what_went_wrong: ["fake_completion", "missing_deadline", "missing_owner", "knowledge_write_error"],
      response_quality: "robotic_response",
      routing_quality: "wrong_routing",
    },
    task: {
      current_agent_id: "meeting",
      task_type: "meeting_processing",
    },
  });

  assert.ok(proposals.length >= 4);
  assert.match(proposals.map((item) => item.category).join(","), /verification_improvement/);
  assert.match(proposals.map((item) => item.category).join(","), /meeting_agent_improvement/);
  assert.match(proposals.map((item) => item.category).join(","), /knowledge_policy_update/);
  assert.ok(proposals.some((item) => item.mode === "human_approval"));
});

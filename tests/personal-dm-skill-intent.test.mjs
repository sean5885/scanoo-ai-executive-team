import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const {
  extractExplicitSkillQueryHint,
  heuristicallyPlanPersonalDMSkillIntent,
  planPersonalDMSkillIntent,
} = await import("../src/planner/personal-dm-skill-intent.mjs");

test.after(() => {
  testDb.close();
});

test("extractExplicitSkillQueryHint keeps quoted skill names", () => {
  assert.equal(
    extractExplicitSkillQueryHint('幫我安裝 skill "find-skills"'),
    "find-skills",
  );
});

test("heuristicallyPlanPersonalDMSkillIntent detects install requests", () => {
  const decision = heuristicallyPlanPersonalDMSkillIntent("幫我安裝 skill find-skills");
  assert.equal(decision.is_delegated_task, true);
  assert.equal(decision.intent, "skill_install_request");
  assert.match(decision.reason || "", /heuristic_skill_install_request/);
});

test("planPersonalDMSkillIntent falls back to heuristics when model classification fails", async () => {
  const decision = await planPersonalDMSkillIntent({
    text: "幫我安裝 skill find-skills",
    async generateText() {
      throw new Error("openclaw_text_generation_failed");
    },
  });

  assert.equal(decision.is_delegated_task, true);
  assert.equal(decision.intent, "skill_install_request");
  assert.match(decision.reason || "", /heuristic_skill_install_request/);
});

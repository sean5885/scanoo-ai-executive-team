import test from "node:test";
import assert from "node:assert/strict";

import { runSystemSelfCheck } from "../src/system-self-check.mjs";

test("system self-check validates agent registry, routes, and service imports", async () => {
  const result = await runSystemSelfCheck();

  assert.equal(result.ok, true);
  assert.equal(result.agents.missing.length, 0);
  assert.equal(result.agents.invalid_contracts.length, 0);
  assert.equal(result.agents.knowledge_subcommands_missing.length, 0);
  assert.equal(result.routes.missing.length, 0);
  assert.equal(result.services.every((item) => item.ok), true);
  assert.equal(result.planner_contract.gate_ok, true);
  assert.equal(result.planner_contract.consistency_ok, true);
  assert.deepEqual(result.planner_contract.failing_categories, []);
});

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("planner diagnostics CLI renders the fixed single-view summary", () => {
  const output = execFileSync("node", ["scripts/planner-diagnostics.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.match(output, /Planner Diagnostics/);
  assert.match(output, /planner contract gate: pass/);
  assert.match(output, /summary: gate=pass \| undefined_actions=0 \| undefined_presets=0 \| selector_contract_mismatches=0 \| deprecated_reachable_targets=0/);
  assert.match(output, /decision: Gate passes\. No planner implementation or contract change is required\./);
});

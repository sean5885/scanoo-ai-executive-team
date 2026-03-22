import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPlannerContractGate,
  renderPlannerContractConsistencyReport,
  runPlannerContractConsistencyCheck,
} from "../src/planner-contract-consistency.mjs";

test("planner contract consistency report surfaces selector kind drift without inventing undefined targets", () => {
  const report = runPlannerContractConsistencyCheck();

  assert.equal(report.contract.version, "v1");
  assert.equal(report.ok, true);
  assert.equal(report.gate.ok, true);
  assert.equal(report.summary.undefined_actions, 0);
  assert.equal(report.summary.undefined_presets, 0);
  assert.equal(report.summary.deprecated_reachable_targets, 0);
  assert.equal(report.summary.selector_contract_mismatches, 0);
  assert.deepEqual(report.findings.selector_contract_mismatches, []);
});

test("planner contract consistency CLI renderer includes the main drift counters", () => {
  const report = runPlannerContractConsistencyCheck();
  const text = renderPlannerContractConsistencyReport(report);

  assert.match(text, /planner contract gate:/);
  assert.match(text, /planner contract consistency:/);
  assert.match(text, /undefined actions: 0/);
  assert.match(text, /undefined presets: 0/);
  assert.match(text, /selector\/contract mismatches:/);
});

test("planner contract gate only fails on blocking contract drift categories", () => {
  const gate = buildPlannerContractGate({
    undefined_actions: [],
    undefined_presets: [],
    deprecated_reachable_targets: [{ category: "deprecated_reachable_targets" }],
    selector_contract_mismatches: [],
  });

  assert.equal(gate.ok, true);
  assert.deepEqual(gate.failing_categories, []);
  assert.deepEqual(gate.fail_summary, []);
});

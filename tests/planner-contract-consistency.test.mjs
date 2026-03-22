import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPlannerDiagnosticsDecision,
  buildPlannerDiagnosticsSummary,
  buildPlannerContractGate,
  renderPlannerContractConsistencyReport,
  runPlannerContractConsistencyCheck,
} from "../src/planner-contract-consistency.mjs";

test("planner contract consistency report surfaces selector kind drift without inventing undefined targets", () => {
  const report = runPlannerContractConsistencyCheck();

  assert.equal(report.contract.version, "v1");
  assert.equal(report.ok, true);
  assert.equal(report.gate.ok, true);
  assert.equal(report.diagnostics_summary.gate, "pass");
  assert.equal(report.summary.undefined_actions, 0);
  assert.equal(report.summary.undefined_presets, 0);
  assert.equal(report.summary.deprecated_reachable_targets, 0);
  assert.equal(report.summary.selector_contract_mismatches, 0);
  assert.deepEqual(report.diagnostics_summary, {
    gate: "pass",
    undefined_actions: 0,
    undefined_presets: 0,
    selector_contract_mismatches: 0,
    deprecated_reachable_targets: 0,
  });
  assert.equal(report.decision.action, "observe_only");
  assert.deepEqual(report.findings.selector_contract_mismatches, []);
});

test("planner contract consistency CLI renderer includes the main drift counters", () => {
  const report = runPlannerContractConsistencyCheck();
  const text = renderPlannerContractConsistencyReport(report);

  assert.match(text, /Planner Diagnostics/);
  assert.match(text, /planner contract gate:/);
  assert.match(text, /summary: gate=pass \| undefined_actions=0 \| undefined_presets=0 \| selector_contract_mismatches=0 \| deprecated_reachable_targets=0/);
  assert.match(text, /decision: Gate passes\./);
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

test("planner diagnostics decision keeps deprecated reachable targets as non-blocking warnings", () => {
  const summary = buildPlannerDiagnosticsSummary({
    gate: { ok: true },
    summary: {
      undefined_actions: 0,
      undefined_presets: 0,
      selector_contract_mismatches: 0,
      deprecated_reachable_targets: 1,
    },
  });
  const decision = buildPlannerDiagnosticsDecision(summary);

  assert.deepEqual(summary, {
    gate: "pass",
    undefined_actions: 0,
    undefined_presets: 0,
    selector_contract_mismatches: 0,
    deprecated_reachable_targets: 1,
  });
  assert.equal(decision.action, "warn_deprecated_only");
  assert.match(decision.summary, /warnings only/);
});

test("planner diagnostics decision defaults to fixing planner implementation on blocking drift", () => {
  const decision = buildPlannerDiagnosticsDecision({
    gate: "fail",
    undefined_actions: 1,
    undefined_presets: 0,
    selector_contract_mismatches: 0,
    deprecated_reachable_targets: 0,
  });

  assert.equal(decision.action, "fix_planner_implementation");
  assert.deepEqual(decision.blocking_categories, ["undefined_actions"]);
  assert.match(decision.summary, /fix planner implementation first/);
  assert.match(decision.summary, /update the contract only/);
});

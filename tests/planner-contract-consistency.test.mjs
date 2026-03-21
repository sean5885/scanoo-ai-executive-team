import test from "node:test";
import assert from "node:assert/strict";

import {
  renderPlannerContractConsistencyReport,
  runPlannerContractConsistencyCheck,
} from "../src/planner-contract-consistency.mjs";

test("planner contract consistency report surfaces selector kind drift without inventing undefined targets", () => {
  const report = runPlannerContractConsistencyCheck();

  assert.equal(report.contract.version, "v1");
  assert.equal(report.summary.undefined_actions, 0);
  assert.equal(report.summary.undefined_presets, 0);
  assert.equal(report.summary.deprecated_reachable_targets, 0);
  assert.equal(report.summary.selector_contract_mismatches > 0, true);
  assert.equal(
    report.findings.selector_contract_mismatches.some((finding) => (
      finding.target === "search_and_detail_doc"
      && finding.reason === "target_kind_mismatch"
    )),
    true,
  );
});

test("planner contract consistency CLI renderer includes the main drift counters", () => {
  const report = runPlannerContractConsistencyCheck();
  const text = renderPlannerContractConsistencyReport(report);

  assert.match(text, /planner contract consistency:/);
  assert.match(text, /undefined actions: 0/);
  assert.match(text, /undefined presets: 0/);
  assert.match(text, /selector\/contract mismatches:/);
});

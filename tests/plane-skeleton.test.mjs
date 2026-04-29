import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();

const [
  contractsModule,
  evidenceModule,
  executionModule,
  plannerModule,
] = await Promise.all([
  import("../src/contracts/index.mjs"),
  import("../src/evidence/index.mjs"),
  import("../src/execution/index.mjs"),
  import("../src/executive-planner.mjs"),
]);

test.after(() => {
  testDb.close();
});

test("contracts skeleton exposes capability contracts and taxonomy", () => {
  const contracts = contractsModule.listCapabilityContracts();
  assert.ok(Array.isArray(contracts));
  assert.ok(contracts.length >= 4);
  assert.equal(contractsModule.FAILURE_TAXONOMY.includes("contract_violation"), true);
  assert.equal(contractsModule.getCapabilityContract("decision")?.capability, "decision");
});

test("evidence skeleton normalizes evidence records", () => {
  const facade = evidenceModule.createEvidencePlaneFacade();
  const collected = facade.collectEvidence([
    { type: "tool_output", summary: "ok" },
    { type: "", summary: "skip" },
    null,
  ]);

  assert.deepEqual(collected, [{ type: "tool_output", summary: "ok" }]);
  assert.equal(facade.verify({}).pass, null);
});

test("execution skeleton delegates selector when injected", () => {
  const facade = executionModule.createExecutionPlaneFacade({
    decisionSelector: () => ({
      selected_action: "get_runtime_info",
      reason: "injected",
      routing_reason: "injected",
    }),
  });
  const selected = facade.decision.select({});
  assert.equal(selected.selected_action, "get_runtime_info");
  assert.equal(facade.decision.contract?.capability, "decision");
});

test("executive planner exposes execution plane scaffold metadata", () => {
  const metadata = plannerModule.getPlannerExecutionPlaneMetadata();
  assert.equal(metadata.version, executionModule.EXECUTION_PLANE_VERSION);
  assert.deepEqual(metadata.capabilities, {
    decision: "decision",
    dispatch: "dispatch",
    recovery: "recovery",
    formatter: "formatter",
  });
});

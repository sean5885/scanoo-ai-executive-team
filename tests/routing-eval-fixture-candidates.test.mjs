import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";
const testDb = await createTestDbHarness();
const [
  {
    loadRoutingEvalSet,
    runRoutingEval,
  },
  {
    buildRoutingEvalConversionInput,
    prepareRoutingEvalFixtureCandidates,
  },
] = await Promise.all([
  import("../src/routing-eval.mjs"),
  import("../src/routing-eval-fixture-candidates.mjs"),
]);
import { ROUTING_NO_MATCH } from "../src/planner-error-codes.mjs";

test.after(() => {
  testDb.close();
});

function hasRoutingErrorCode(result = {}, code = "") {
  const values = [
    result?.expected?.planner_action,
    result?.expected?.agent_or_tool,
    result?.actual?.planner_action,
    result?.actual?.agent_or_tool,
  ];
  return values.some((value) => {
    const normalized = String(value || "").replace(/^error:/, "");
    return normalized === code;
  });
}

test("routing eval conversion input carries current error summary and case-level input for the checked-in dataset", async () => {
  const testCases = await loadRoutingEvalSet();
  const run = await runRoutingEval({ testCases });
  const conversion = buildRoutingEvalConversionInput({ run, testCases });
  const routingNoMatchGroup = conversion.error_breakdown_input.find((item) => item.error_code === ROUTING_NO_MATCH);
  const expectedSummary = run.summary.error_breakdown[ROUTING_NO_MATCH];
  const expectedCaseIds = run.results
    .filter((result) => hasRoutingErrorCode(result, ROUTING_NO_MATCH))
    .map((result) => result.id)
    .sort();
  const actualCaseIds = (routingNoMatchGroup?.cases || [])
    .map((item) => item.source_case_id)
    .sort();

  assert.equal(conversion.top_miss_cases_input.length, run.summary.top_miss_cases.length);
  assert.ok(routingNoMatchGroup);
  assert.deepEqual(routingNoMatchGroup.summary, expectedSummary);
  assert.deepEqual(actualCaseIds, expectedCaseIds);

  for (const item of routingNoMatchGroup.cases) {
    assert.equal(item.error_code, ROUTING_NO_MATCH);
    assert.ok(["expected_only", "actual_only", "matched"].includes(item.error_role));
    assert.equal(item.observed_actual.planner_action, ROUTING_NO_MATCH);
    assert.equal(item.current_expected.planner_action, ROUTING_NO_MATCH);
  }
});

test("routing eval fixture candidates prefer observed actual route for miss cases", async () => {
  const testCases = await loadRoutingEvalSet();
  const degradedCases = testCases.map((testCase, index) => (
    index === 0
      ? {
          ...testCase,
          expected: {
            ...testCase.expected,
            planner_action: `${testCase.expected.planner_action}_mismatch`,
            agent_or_tool: `${testCase.expected.agent_or_tool}_mismatch`,
          },
        }
      : testCase
  ));
  const run = await runRoutingEval({ testCases: degradedCases });
  const prepared = prepareRoutingEvalFixtureCandidates({
    run,
    testCases: degradedCases,
    prefer: "actual",
  });
  const candidate = prepared.fixture_candidates.find((item) => item.source_case_id === "doc-001");

  assert.equal(prepared.ok, true);
  assert.ok(candidate);
  assert.equal(candidate.suggested_dataset_action, "update_existing_fixture");
  assert.equal(candidate.lane, "knowledge_assistant");
  assert.equal(candidate.planner_action, "search_and_detail_doc");
  assert.equal(candidate.agent_or_tool, "tool:search_and_detail_doc");
  assert.match(candidate.fixture_source, /createCase\(/);
  assert.match(candidate.fixture_source, /search_and_detail_doc/);
});

test("routing eval fixture candidate CLI emits current-dataset candidates with stable format", () => {
  const raw = execFileSync("node", ["scripts/routing-eval-fixture-candidates.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const parsed = JSON.parse(raw);
  const routingNoMatchGroup = parsed.conversion_input.error_breakdown_input.find((item) => item.error_code === ROUTING_NO_MATCH);
  const routingNoMatchCandidates = parsed.fixture_candidates.filter((item) => item.involved_error_codes?.includes(ROUTING_NO_MATCH));

  assert.equal(parsed.ok, true);
  assert.ok(Array.isArray(parsed.conversion_input.top_miss_cases_input));
  assert.ok(Array.isArray(parsed.conversion_input.error_breakdown_input));
  assert.ok(Array.isArray(parsed.fixture_candidates));
  assert.ok(routingNoMatchGroup);
  assert.ok(routingNoMatchGroup.summary.expected >= 1);
  assert.equal(routingNoMatchCandidates.length, routingNoMatchGroup.cases.length);

  for (const candidate of routingNoMatchCandidates) {
    assert.equal(candidate.selection_basis, "observed_actual_route");
    assert.equal(candidate.suggested_dataset_action, "update_existing_fixture");
    assert.equal(candidate.fixture.id, candidate.target_case_id);
    assert.equal(candidate.fixture.expected.planner_action, candidate.planner_action);
    assert.equal(candidate.fixture.expected.agent_or_tool, candidate.agent_or_tool);
    assert.match(candidate.fixture_source, /createCase\(/);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import {
  loadRoutingEvalSet,
  runRoutingEval,
} from "../src/routing-eval.mjs";
import {
  buildRoutingEvalConversionInput,
  prepareRoutingEvalFixtureCandidates,
} from "../src/routing-eval-fixture-candidates.mjs";
import { ROUTING_NO_MATCH } from "../src/planner-error-codes.mjs";

test("routing eval conversion input expands hard-routing error groups into case-level input", async () => {
  const testCases = await loadRoutingEvalSet();
  const run = await runRoutingEval({ testCases });
  const conversion = buildRoutingEvalConversionInput({ run, testCases });
  const routingNoMatchGroup = conversion.error_breakdown_input.find((item) => item.error_code === ROUTING_NO_MATCH);

  assert.equal(conversion.top_miss_cases_input.length, 0);
  assert.ok(routingNoMatchGroup);
  assert.deepEqual(routingNoMatchGroup.summary, {
    expected: 1,
    actual: 1,
    matched: 1,
    misses: 0,
  });
  assert.equal(routingNoMatchGroup.cases.length, 1);
  assert.equal(routingNoMatchGroup.cases[0].source_case_id, "runtime-010");
  assert.equal(routingNoMatchGroup.cases[0].observed_actual.planner_action, ROUTING_NO_MATCH);
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

test("routing eval fixture candidate CLI emits machine-readable output", () => {
  const raw = execFileSync("node", ["scripts/routing-eval-fixture-candidates.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const parsed = JSON.parse(raw);

  assert.equal(parsed.ok, true);
  assert.ok(Array.isArray(parsed.conversion_input.top_miss_cases_input));
  assert.ok(Array.isArray(parsed.conversion_input.error_breakdown_input));
  assert.ok(Array.isArray(parsed.fixture_candidates));
  assert.ok(parsed.fixture_candidates.some((item) => item.source_case_id === "runtime-010"));
});

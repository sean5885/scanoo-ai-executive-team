import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import {
  ROUTING_EVAL_MIN_ACCURACY_RATIO,
  loadRoutingEvalSet,
  runRoutingEval,
  validateRoutingEvalSet,
} from "../src/routing-eval.mjs";

test("routing eval set stays within deterministic baseline size and schema", async () => {
  const testCases = await loadRoutingEvalSet();
  const issues = validateRoutingEvalSet(testCases);

  assert.equal(issues.length, 0);
  assert.ok(testCases.length >= 50);
  assert.ok(testCases.length <= 100);
});

test("routing eval baseline currently has zero mismatches", async () => {
  const run = await runRoutingEval();

  assert.equal(run.validation_issues.length, 0);
  assert.equal(run.ok, true);
  assert.equal(run.threshold.min_accuracy_ratio, ROUTING_EVAL_MIN_ACCURACY_RATIO);
  assert.equal(run.summary.miss_count, 0);
  assert.equal(run.summary.overall.hits, run.summary.total_cases);
  assert.equal(run.summary.overall.accuracy_ratio, 1);
});

test("routing eval CLI supports json output", () => {
  const raw = execFileSync("node", ["scripts/routing-eval.mjs", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const parsed = JSON.parse(raw);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.threshold.min_accuracy_ratio, ROUTING_EVAL_MIN_ACCURACY_RATIO);
  assert.equal(parsed.summary.miss_count, 0);
  assert.ok(parsed.summary.total_cases >= 50);
  assert.ok(Array.isArray(parsed.summary.top_miss_cases));
});

test("routing eval gate fails when overall accuracy ratio drops below 0.9", async () => {
  const testCases = await loadRoutingEvalSet();
  const degradedCases = testCases.map((testCase, index) => (
    index < 7
      ? {
          ...testCase,
          expected: {
            ...testCase.expected,
            planner_action: `${testCase.expected.planner_action}_mismatch`,
          },
        }
      : testCase
  ));

  const run = await runRoutingEval({ testCases: degradedCases });

  assert.equal(run.ok, false);
  assert.equal(run.summary.overall.hits, testCases.length - 7);
  assert.equal(run.summary.miss_count, 7);
  assert.equal(run.summary.overall.accuracy_ratio < ROUTING_EVAL_MIN_ACCURACY_RATIO, true);
  assert.equal(run.summary.top_miss_cases.length, 7);
});

test("routing eval gate passes when overall accuracy ratio stays above 0.9", async () => {
  const testCases = await loadRoutingEvalSet();
  const allowedMisses = Math.floor(testCases.length * (1 - ROUTING_EVAL_MIN_ACCURACY_RATIO));
  const boundaryCases = testCases.map((testCase, index) => (
    index < allowedMisses
      ? {
          ...testCase,
          expected: {
            ...testCase.expected,
            agent_or_tool: `${testCase.expected.agent_or_tool}_mismatch`,
          },
        }
      : testCase
  ));

  const run = await runRoutingEval({ testCases: boundaryCases });

  assert.equal(run.ok, true);
  assert.equal(run.summary.overall.hits, testCases.length - allowedMisses);
  assert.equal(run.summary.miss_count, allowedMisses);
  assert.equal(run.summary.overall.accuracy_ratio > ROUTING_EVAL_MIN_ACCURACY_RATIO, true);
  assert.equal(run.summary.top_miss_cases.length, allowedMisses);
});

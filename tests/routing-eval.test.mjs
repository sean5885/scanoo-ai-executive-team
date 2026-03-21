import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import {
  formatRoutingEvalReport,
  ROUTING_EVAL_MIN_ACCURACY_RATIO,
  loadRoutingEvalSet,
  runRoutingEval,
  summarizeRoutingEval,
  validateRoutingEvalSet,
} from "../src/routing-eval.mjs";
import {
  FALLBACK_DISABLED,
  INVALID_ACTION,
  ROUTING_NO_MATCH,
} from "../src/planner-error-codes.mjs";

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
  assert.deepEqual(Object.keys(parsed.summary.error_breakdown), [
    ROUTING_NO_MATCH,
    INVALID_ACTION,
    FALLBACK_DISABLED,
  ]);
});

test("routing eval summary tracks hard routing error breakdown by code", () => {
  const summary = summarizeRoutingEval([
    {
      expected: {
        planner_action: ROUTING_NO_MATCH,
        agent_or_tool: `error:${ROUTING_NO_MATCH}`,
      },
      actual: {
        planner_action: ROUTING_NO_MATCH,
        agent_or_tool: `error:${ROUTING_NO_MATCH}`,
      },
      matches: {
        overall: true,
        lane: true,
        planner_action: true,
        agent_or_tool: true,
      },
      miss_dimensions: [],
      latency_ms: 1,
    },
    {
      expected: {
        planner_action: INVALID_ACTION,
        agent_or_tool: `error:${INVALID_ACTION}`,
      },
      actual: {
        planner_action: INVALID_ACTION,
        agent_or_tool: `error:${INVALID_ACTION}`,
      },
      matches: {
        overall: true,
        lane: true,
        planner_action: true,
        agent_or_tool: true,
      },
      miss_dimensions: [],
      latency_ms: 1,
    },
    {
      expected: {
        planner_action: INVALID_ACTION,
        agent_or_tool: `error:${INVALID_ACTION}`,
      },
      actual: {
        planner_action: ROUTING_NO_MATCH,
        agent_or_tool: `error:${ROUTING_NO_MATCH}`,
      },
      matches: {
        overall: false,
        lane: true,
        planner_action: false,
        agent_or_tool: false,
      },
      miss_dimensions: ["planner_action", "agent_or_tool"],
      latency_ms: 1,
    },
    {
      expected: {
        planner_action: FALLBACK_DISABLED,
        agent_or_tool: `error:${FALLBACK_DISABLED}`,
      },
      actual: {
        planner_action: FALLBACK_DISABLED,
        agent_or_tool: `error:${FALLBACK_DISABLED}`,
      },
      matches: {
        overall: true,
        lane: true,
        planner_action: true,
        agent_or_tool: true,
      },
      miss_dimensions: [],
      latency_ms: 1,
    },
  ]);

  assert.deepEqual(summary.error_breakdown, {
    [ROUTING_NO_MATCH]: {
      expected: 1,
      actual: 2,
      matched: 1,
      misses: 1,
    },
    [INVALID_ACTION]: {
      expected: 2,
      actual: 1,
      matched: 1,
      misses: 1,
    },
    [FALLBACK_DISABLED]: {
      expected: 1,
      actual: 1,
      matched: 1,
      misses: 0,
    },
  });
});

test("routing eval report prints hard routing error breakdown", () => {
  const report = formatRoutingEvalReport({
    ok: true,
    threshold: {
      min_accuracy_ratio: ROUTING_EVAL_MIN_ACCURACY_RATIO,
    },
    summary: {
      total_cases: 1,
      overall: { hits: 1, total: 1, accuracy_ratio: 1, accuracy: 100 },
      lane_accuracy: { hits: 1, total: 1, accuracy_ratio: 1, accuracy: 100 },
      planner_accuracy: { hits: 1, total: 1, accuracy_ratio: 1, accuracy: 100 },
      agent_tool_accuracy: { hits: 1, total: 1, accuracy_ratio: 1, accuracy: 100 },
      by_lane_accuracy: {},
      by_action_accuracy: {},
      error_breakdown: {
        [ROUTING_NO_MATCH]: { expected: 1, actual: 1, matched: 1, misses: 0 },
        [INVALID_ACTION]: { expected: 0, actual: 0, matched: 0, misses: 0 },
        [FALLBACK_DISABLED]: { expected: 0, actual: 0, matched: 0, misses: 0 },
      },
      latency_ms: { avg: 1, p95: 1, max: 1 },
      top_miss_cases: [],
      miss_count: 0,
    },
  });

  assert.match(report, /Error breakdown/);
  assert.match(report, /ROUTING_NO_MATCH: expected 1 \| actual 1 \| matched 1 \| misses 0/);
});

test("routing eval gate fails when overall accuracy ratio drops below 0.9", async () => {
  const testCases = await loadRoutingEvalSet();
  const failingMisses = Math.floor(testCases.length * (1 - ROUTING_EVAL_MIN_ACCURACY_RATIO)) + 1;
  const degradedCases = testCases.map((testCase, index) => (
    index < failingMisses
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
  assert.equal(run.summary.overall.hits, testCases.length - failingMisses);
  assert.equal(run.summary.miss_count, failingMisses);
  assert.equal(run.summary.overall.accuracy_ratio < ROUTING_EVAL_MIN_ACCURACY_RATIO, true);
  assert.equal(run.summary.top_miss_cases.length, Math.min(failingMisses, 10));
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

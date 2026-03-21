import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildRoutingEvalDecisionAdvice } from "../src/routing-eval-fixture-candidates.mjs";
import { runRoutingEval } from "../src/routing-eval.mjs";
import {
  FALLBACK_DISABLED,
  INVALID_ACTION,
  ROUTING_NO_MATCH,
} from "../src/planner-error-codes.mjs";

function buildRun({
  accuracyRatio = 1,
  errorBreakdown = {},
  missCount = 0,
  ok = true,
} = {}) {
  return {
    ok,
    threshold: {
      min_accuracy_ratio: 0.9,
    },
    summary: {
      total_cases: 10,
      miss_count: missCount,
      overall: {
        accuracy_ratio: accuracyRatio,
        accuracy: Number((accuracyRatio * 100).toFixed(2)),
      },
      error_breakdown: {
        [ROUTING_NO_MATCH]: {
          expected: 0,
          actual: 0,
          matched: 0,
          misses: 0,
        },
        [INVALID_ACTION]: {
          expected: 0,
          actual: 0,
          matched: 0,
          misses: 0,
        },
        [FALLBACK_DISABLED]: {
          expected: 0,
          actual: 0,
          matched: 0,
          misses: 0,
        },
        ...errorBreakdown,
      },
    },
  };
}

test("routing eval decision advice maps error breakdown into fixture, rule, and risk recommendations", () => {
  const advice = buildRoutingEvalDecisionAdvice({
    run: buildRun({
      accuracyRatio: 0.9,
      missCount: 4,
      ok: false,
      errorBreakdown: {
        [ROUTING_NO_MATCH]: {
          expected: 0,
          actual: 2,
          matched: 0,
          misses: 2,
        },
        [INVALID_ACTION]: {
          expected: 0,
          actual: 1,
          matched: 0,
          misses: 1,
        },
        [FALLBACK_DISABLED]: {
          expected: 0,
          actual: 1,
          matched: 0,
          misses: 1,
        },
      },
    }),
  });

  const actions = advice.recommendations.map((item) => item.action);

  assert.ok(actions.includes("review_fixture_coverage"));
  assert.ok(actions.includes("check_routing_rule"));
  assert.ok(actions.includes("manual_review_high_risk"));
  assert.equal(advice.minimal_decision.action, "manual_review_high_risk");
  assert.equal(advice.minimal_decision.severity, "high");
});

test("routing eval decision advice warns when accuracy declines", () => {
  const advice = buildRoutingEvalDecisionAdvice({
    run: buildRun({
      accuracyRatio: 0.9,
      missCount: 1,
      ok: true,
    }),
    previousRun: buildRun({
      accuracyRatio: 1,
      missCount: 0,
      ok: true,
    }),
  });

  assert.equal(advice.trend.status, "declined");
  assert.equal(advice.warnings[0].code, "accuracy_declined");
  assert.equal(advice.minimal_decision.action, "warn_accuracy_decline");
});

test("routing eval decision advice recommends no change when accuracy is stable", () => {
  const previousRun = buildRun({
    accuracyRatio: 1,
    missCount: 0,
    ok: true,
  });
  const advice = buildRoutingEvalDecisionAdvice({
    run: buildRun({
      accuracyRatio: 1,
      missCount: 0,
      ok: true,
    }),
    previousRun,
  });

  assert.equal(advice.trend.status, "stable");
  assert.equal(advice.minimal_decision.action, "no_change");
});

test("routing eval fixture candidate CLI emits trend-aware decision advice when previous run is provided", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "routing-eval-advice-"));
  const runPath = path.join(tempDir, "routing-eval.json");
  const previousPath = path.join(tempDir, "routing-eval-previous.json");
  const run = await runRoutingEval();

  writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  writeFileSync(previousPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");

  const raw = execFileSync("node", [
    "scripts/routing-eval-fixture-candidates.mjs",
    "--input",
    runPath,
    "--previous",
    previousPath,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const parsed = JSON.parse(raw);

  assert.equal(parsed.trend.status, "stable");
  assert.equal(parsed.decision_advice.minimal_decision.action, "no_change");
  assert.equal(parsed.diagnostics_summary.decision_advice.minimal_decision.action, "no_change");
  assert.equal(parsed.diagnostics_summary.trend_report.available, true);
});

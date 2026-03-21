import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildRoutingTrendReport,
  formatRoutingTrendReport,
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

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

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
  const archiveDir = path.join(os.tmpdir(), `routing-diagnostics-${Date.now()}-json`);
  const raw = execFileSync("node", ["scripts/routing-eval.mjs", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archiveDir,
    },
  });
  const parsed = JSON.parse(raw);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.threshold.min_accuracy_ratio, ROUTING_EVAL_MIN_ACCURACY_RATIO);
  assert.equal(parsed.summary.miss_count, 0);
  assert.ok(parsed.summary.total_cases >= 50);
  assert.ok(Array.isArray(parsed.summary.top_miss_cases));
  assert.equal(parsed.diagnostics_summary.accuracy_ratio, 1);
  assert.equal(parsed.summary.comparable_summary.accuracy_ratio, 1);
  assert.equal(parsed.diagnostics_summary.trend_report.available, false);
  assert.equal(parsed.diagnostics_summary.decision_advice.minimal_decision.action, "observe_only");
  assert.ok(parsed.diagnostics_archive?.run_id);
  assert.ok(parsed.diagnostics_archive?.snapshot_path.endsWith(".json"));
  assert.deepEqual(Object.keys(parsed.summary.error_breakdown), [
    ROUTING_NO_MATCH,
    INVALID_ACTION,
    FALLBACK_DISABLED,
  ]);
  assert.deepEqual(Object.keys(parsed.diagnostics_summary.error_breakdown), [
    ROUTING_NO_MATCH,
    INVALID_ACTION,
    FALLBACK_DISABLED,
  ]);
  assert.deepEqual(Object.keys(parsed.summary.comparable_summary.error_breakdown), [
    ROUTING_NO_MATCH,
    INVALID_ACTION,
    FALLBACK_DISABLED,
  ]);
});

test("routing eval archives diagnostics snapshots into a manifest", () => {
  const archiveDir = path.join(os.tmpdir(), `routing-diagnostics-${Date.now()}-manifest`);
  const raw = execFileSync("node", ["scripts/routing-eval.mjs", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archiveDir,
    },
  });
  const parsed = JSON.parse(raw);
  const manifest = readJson(path.join(archiveDir, "manifest.json"));

  assert.equal(manifest.latest_run_id, parsed.diagnostics_archive.run_id);
  assert.equal(Array.isArray(manifest.snapshots), true);
  assert.equal(manifest.snapshots.length >= 1, true);
  assert.equal(manifest.snapshots[0].run_id, parsed.diagnostics_archive.run_id);
  assert.equal(typeof manifest.snapshots[0].timestamp, "string");
  assert.equal(typeof manifest.snapshots[0].accuracy_ratio, "number");
  assert.deepEqual(Object.keys(manifest.snapshots[0].error_breakdown).sort(), [
    FALLBACK_DISABLED,
    INVALID_ACTION,
    ROUTING_NO_MATCH,
  ].sort());
  assert.equal(typeof manifest.snapshots[0].trend_report_summary.available, "boolean");
});

test("routing eval CLI human-readable output is a single diagnostics summary view", () => {
  const raw = execFileSync("node", ["scripts/routing-eval.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.match(raw, /Routing Diagnostics Summary/);
  assert.match(raw, /Decision: observe_only \| severity info/);
  assert.doesNotMatch(raw, /^Routing Eval$/m);
  assert.doesNotMatch(raw, /^Routing Trend$/m);
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

test("routing eval summary exposes comparable summary for trend diffs", () => {
  const summary = summarizeRoutingEval([
    {
      expected: {
        lane: "knowledge_assistant",
        planner_action: "search_company_brain_docs",
        agent_or_tool: "tool:search_company_brain_docs",
      },
      actual: {
        lane: "knowledge_assistant",
        planner_action: "search_company_brain_docs",
        agent_or_tool: "tool:search_company_brain_docs",
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

  assert.deepEqual(summary.comparable_summary, {
    accuracy_ratio: 1,
    by_lane_accuracy: {
      knowledge_assistant: {
        hits: 1,
        total: 1,
        accuracy_ratio: 1,
        accuracy: 100,
      },
    },
    by_action_accuracy: {
      search_company_brain_docs: {
        hits: 1,
        total: 1,
        accuracy_ratio: 1,
        accuracy: 100,
      },
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
    },
  });
});

test("routing trend report compares current run against previous run", () => {
  const previousRun = {
    summary: {
      total_cases: 2,
      overall: { hits: 1, total: 2, accuracy_ratio: 0.5, accuracy: 50 },
      by_lane_accuracy: {
        knowledge_assistant: { hits: 1, total: 2, accuracy_ratio: 0.5, accuracy: 50 },
      },
      by_action_accuracy: {
        get_runtime_info: { hits: 1, total: 2, accuracy_ratio: 0.5, accuracy: 50 },
      },
      error_breakdown: {
        [ROUTING_NO_MATCH]: { expected: 1, actual: 1, matched: 1, misses: 0 },
        [INVALID_ACTION]: { expected: 0, actual: 0, matched: 0, misses: 0 },
        [FALLBACK_DISABLED]: { expected: 0, actual: 0, matched: 0, misses: 0 },
      },
      miss_count: 1,
    },
  };
  const currentRun = {
    summary: {
      total_cases: 2,
      overall: { hits: 2, total: 2, accuracy_ratio: 1, accuracy: 100 },
      by_lane_accuracy: {
        knowledge_assistant: { hits: 2, total: 2, accuracy_ratio: 1, accuracy: 100 },
      },
      by_action_accuracy: {
        get_runtime_info: { hits: 2, total: 2, accuracy_ratio: 1, accuracy: 100 },
      },
      error_breakdown: {
        [ROUTING_NO_MATCH]: { expected: 0, actual: 0, matched: 0, misses: 0 },
        [INVALID_ACTION]: { expected: 0, actual: 0, matched: 0, misses: 0 },
        [FALLBACK_DISABLED]: { expected: 0, actual: 0, matched: 0, misses: 0 },
      },
      miss_count: 0,
    },
  };

  const trend = buildRoutingTrendReport({
    currentRun,
    previousRun,
    currentLabel: "current",
    previousLabel: "previous",
  });
  const report = formatRoutingTrendReport(trend);

  assert.equal(trend.available, true);
  assert.equal(trend.delta.accuracy_ratio.delta, 0.5);
  assert.equal(trend.delta.miss_count.delta, -1);
  assert.equal(trend.delta.by_lane_accuracy.knowledge_assistant.status, "improved");
  assert.equal(trend.delta.error_breakdown.ROUTING_NO_MATCH.expected.delta, -1);
  assert.match(report, /Accuracy ratio: 1 vs 0.5 \| delta \+0.5000/);
  assert.match(report, /knowledge_assistant: 1 \(2\/2\) vs 0.5 \(1\/2\) \| delta \+0.5000 \| improved/);
});

test("routing eval CLI supports json compare output", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "routing-eval-"));
  const comparePath = path.join(tempDir, "previous-run.json");

  await writeFile(comparePath, `${JSON.stringify({
    ok: false,
    threshold: {
      min_accuracy_ratio: ROUTING_EVAL_MIN_ACCURACY_RATIO,
    },
    summary: {
      total_cases: 88,
      overall: { hits: 80, total: 88, accuracy_ratio: 0.9091, accuracy: 90.91 },
      lane_accuracy: { hits: 82, total: 88, accuracy_ratio: 0.9318, accuracy: 93.18 },
      planner_accuracy: { hits: 81, total: 88, accuracy_ratio: 0.9205, accuracy: 92.05 },
      agent_tool_accuracy: { hits: 80, total: 88, accuracy_ratio: 0.9091, accuracy: 90.91 },
      by_lane_accuracy: {
        knowledge_assistant: { hits: 37, total: 45, accuracy_ratio: 0.8222, accuracy: 82.22 },
      },
      by_action_accuracy: {
        get_runtime_info: { hits: 10, total: 16, accuracy_ratio: 0.625, accuracy: 62.5 },
      },
      error_breakdown: {
        [ROUTING_NO_MATCH]: { expected: 5, actual: 7, matched: 4, misses: 4 },
        [INVALID_ACTION]: { expected: 0, actual: 0, matched: 0, misses: 0 },
        [FALLBACK_DISABLED]: { expected: 0, actual: 0, matched: 0, misses: 0 },
      },
      latency_ms: { avg: 1, p95: 1, max: 1 },
      top_miss_cases: [],
      miss_count: 8,
    },
  }, null, 2)}\n`, "utf8");

  const raw = execFileSync("node", ["scripts/routing-eval.mjs", "--json", "--compare", comparePath], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const parsed = JSON.parse(raw);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.diagnostics_summary.trend_report.available, true);
  assert.equal(parsed.diagnostics_summary.decision_advice.trend.status, "improved");
  assert.equal(parsed.trend_report.available, true);
  assert.equal(parsed.trend_report.previous_label.endsWith("previous-run.json"), true);
  assert.equal(parsed.trend_report.delta.accuracy_ratio.delta > 0, true);
  assert.equal(parsed.trend_report.delta.miss_count.delta < 0, true);
});

test("routing eval CLI supports compare by archived snapshot run id", () => {
  const archiveDir = path.join(os.tmpdir(), `routing-diagnostics-${Date.now()}-snapshot-compare`);
  const firstRaw = execFileSync("node", ["scripts/routing-eval.mjs", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archiveDir,
    },
  });
  const firstParsed = JSON.parse(firstRaw);
  const secondRaw = execFileSync("node", [
    "scripts/routing-eval.mjs",
    "--json",
    "--compare-snapshot",
    firstParsed.diagnostics_archive.run_id,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archiveDir,
    },
  });
  const secondParsed = JSON.parse(secondRaw);

  assert.equal(secondParsed.diagnostics_summary.trend_report.available, true);
  assert.equal(
    secondParsed.diagnostics_summary.trend_report.previous_label,
    `snapshot:${firstParsed.diagnostics_archive.run_id}`,
  );
  assert.equal(secondParsed.diagnostics_summary.decision_advice.trend.status, "stable");
});

test("routing eval CLI supports compare by existing git tag", () => {
  const archiveDir = path.join(os.tmpdir(), `routing-diagnostics-${Date.now()}-tag-compare`);
  const raw = execFileSync("node", [
    "scripts/routing-eval.mjs",
    "--json",
    "--compare-tag",
    "routing-eval-baseline-v2",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archiveDir,
    },
    maxBuffer: 20 * 1024 * 1024,
  });
  const parsed = JSON.parse(raw);

  assert.equal(parsed.diagnostics_summary.trend_report.available, true);
  assert.equal(parsed.diagnostics_summary.trend_report.previous_label, "tag:routing-eval-baseline-v2");
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

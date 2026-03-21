import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import {
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
  assert.equal(run.summary.miss_count, 0);
  assert.equal(run.summary.overall.hits, run.summary.total_cases);
});

test("routing eval CLI supports json output", () => {
  const raw = execFileSync("node", ["scripts/routing-eval.mjs", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const parsed = JSON.parse(raw);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.summary.miss_count, 0);
  assert.ok(parsed.summary.total_cases >= 50);
});

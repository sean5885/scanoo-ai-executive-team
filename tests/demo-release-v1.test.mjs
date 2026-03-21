import test from "node:test";
import assert from "node:assert/strict";

import {
  buildStepReport,
  extractTrailingJson,
  parseNodeTestSummary,
  runStep,
} from "../scripts/demo-release-v1.mjs";

test("extractTrailingJson parses trailing JSON after log lines", () => {
  const parsed = extractTrailingJson([
    "[info]: [ 'client ready' ]",
    "{",
    '  "ok": true,',
    '  "agents": { "total": 20, "missing": [], "invalid_contracts": [] },',
    '  "routes": { "checked": [], "missing": [] },',
    '  "services": []',
    "}",
  ].join("\n"));

  assert.equal(parsed?.ok, true);
  assert.equal(parsed?.agents?.total, 20);
});

test("parseNodeTestSummary reads node test counters", () => {
  const summary = parseNodeTestSummary([
    "✔ first test (1ms)",
    "ℹ tests 3",
    "ℹ pass 2",
    "ℹ fail 1",
    "ℹ skipped 0",
    "ℹ todo 0",
    "ℹ duration_ms 88.4",
  ].join("\n"));

  assert.deepEqual(summary, {
    tests: 3,
    pass: 2,
    fail: 1,
    skipped: 0,
    todo: 0,
    duration_ms: 88,
  });
});

test("buildStepReport summarizes self-check output", () => {
  const report = buildStepReport(
    { summary_kind: "self_check" },
    {
      status: 0,
      error: null,
      stdout: [
        "[info]: [ 'client ready' ]",
        "{",
        '  "ok": true,',
        '  "agents": { "total": 20, "missing": [], "invalid_contracts": [] },',
        '  "routes": { "checked": [{ "pathname": "/api/messages/reply" }], "missing": [] },',
        '  "services": [{ "module": "./lane-executor.mjs", "ok": true }]',
        "}",
      ].join("\n"),
      stderr: "",
      signal: null,
      durationMs: 25,
    },
  );

  assert.equal(report.ok, true);
  assert.deepEqual(report.summaryLines, [
    "system_ok: yes",
    "agents_checked: 20, missing: 0, invalid_contracts: 0",
    "routes_checked: 1, missing: 0",
    "services_ok: 1/1",
  ]);
});

test("buildStepReport surfaces explicit failure details", () => {
  const report = buildStepReport(
    { summary_kind: "generic" },
    {
      status: 3,
      error: null,
      stdout: "",
      stderr: "boom failed",
      signal: null,
      durationMs: 12,
    },
  );

  assert.equal(report.ok, false);
  assert.match(report.errorLines.join("\n"), /exit_code: 3/);
  assert.match(report.errorLines.join("\n"), /details: boom failed/);
});

test("runStep captures stdout stderr and exit code", () => {
  const execution = runStep({
    command: process.execPath,
    args: ["-e", "console.log('ok'); console.error('warn'); process.exit(2);"],
  });

  assert.equal(execution.status, 2);
  assert.match(execution.stdout, /ok/);
  assert.match(execution.stderr, /warn/);
});

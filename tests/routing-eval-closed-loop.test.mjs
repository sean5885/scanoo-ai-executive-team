import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

test("routing eval closed loop writes decision artifacts and warns on rerun accuracy decline", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "routing-closed-loop-"));
  const archiveDir = path.join(baseDir, "diagnostics-history");
  const prepareOutput = execFileSync("node", [
    "scripts/routing-eval-closed-loop.mjs",
    "prepare",
    "--out-dir",
    baseDir,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archiveDir,
    },
  });
  const pointer = readJson(path.join(baseDir, "latest-session.json"));
  const degradedDatasetPath = path.join(baseDir, "degraded-routing-eval-set.mjs");
  const manifestAfterPrepare = readJson(path.join(archiveDir, "manifest.json"));

  assert.match(prepareOutput, /Diagnostics summary: observe_only \(info\)/);
  assert.equal(
    readJson(pointer.artifacts.initial_diagnostics_summary_json).decision_advice.minimal_decision.action,
    "observe_only",
  );
  assert.equal(manifestAfterPrepare.snapshots.length, 1);
  assert.equal(pointer.history.initial_snapshot.run_id, manifestAfterPrepare.latest_run_id);

  writeFileSync(
    degradedDatasetPath,
    [
      `import { routingEvalSet as base } from ${JSON.stringify(path.resolve(process.cwd(), "evals/routing-eval-set.mjs"))};`,
      "export const routingEvalSet = base.map((item, index) => (",
      "  index === 0",
      "    ? {",
      "        ...item,",
      "        expected: {",
      "          ...item.expected,",
      "          planner_action: `${item.expected.planner_action}_mismatch`,",
      "        },",
      "      }",
      "    : item",
      "));",
      "",
    ].join("\n"),
    "utf8",
  );

  const rerunOutput = execFileSync("node", [
    "scripts/routing-eval-closed-loop.mjs",
    "rerun",
    "--out-dir",
    baseDir,
    "--dataset",
    degradedDatasetPath,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archiveDir,
    },
  });
  const nextPointer = readJson(path.join(baseDir, "latest-session.json"));
  const rerunDiagnostics = readJson(nextPointer.artifacts.rerun_diagnostics_summary_json);
  const manifestAfterRerun = readJson(path.join(archiveDir, "manifest.json"));

  assert.match(rerunOutput, /Diagnostics summary: warn_accuracy_decline \(warning\)/);
  assert.equal(rerunDiagnostics.decision_advice.trend.status, "declined");
  assert.equal(rerunDiagnostics.decision_advice.minimal_decision.action, "warn_accuracy_decline");
  assert.equal(manifestAfterRerun.snapshots.length, 2);
  assert.equal(nextPointer.history.rerun_snapshot.run_id, manifestAfterRerun.latest_run_id);
});

test("routing eval closed loop prepare supports compare by existing git tag", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "routing-closed-loop-tag-"));
  const archiveDir = path.join(baseDir, "diagnostics-history");

  execFileSync("node", [
    "scripts/routing-eval-closed-loop.mjs",
    "prepare",
    "--out-dir",
    baseDir,
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

  const pointer = readJson(path.join(baseDir, "latest-session.json"));
  const diagnostics = readJson(pointer.artifacts.initial_diagnostics_summary_json);

  assert.equal(diagnostics.trend_report.available, true);
  assert.equal(diagnostics.trend_report.previous_label, "tag:routing-eval-baseline-v2");
});

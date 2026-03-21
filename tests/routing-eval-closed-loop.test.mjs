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
  const prepareOutput = execFileSync("node", [
    "scripts/routing-eval-closed-loop.mjs",
    "prepare",
    "--out-dir",
    baseDir,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const pointer = readJson(path.join(baseDir, "latest-session.json"));
  const degradedDatasetPath = path.join(baseDir, "degraded-routing-eval-set.mjs");

  assert.match(prepareOutput, /Decision advice: observe_only \(info\)/);
  assert.equal(readJson(pointer.artifacts.initial_decision_json).minimal_decision.action, "observe_only");

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
  });
  const nextPointer = readJson(path.join(baseDir, "latest-session.json"));
  const rerunAdvice = readJson(nextPointer.artifacts.rerun_decision_json);

  assert.match(rerunOutput, /Decision advice: warn_accuracy_decline \(warning\)/);
  assert.equal(rerunAdvice.trend.status, "declined");
  assert.equal(rerunAdvice.minimal_decision.action, "warn_accuracy_decline");
});

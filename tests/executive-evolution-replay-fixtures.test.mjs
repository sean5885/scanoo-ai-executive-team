import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  EXECUTIVE_REPLAY_FIXTURE_CATEGORIES,
  EXECUTIVE_REPLAY_FIXTURE_FILES,
} from "../evals/executive-replay/fixtures/index.mjs";
import {
  replayExecutiveTaskEvolution,
} from "../src/executive-evolution-replay.mjs";

const execFileAsync = promisify(execFile);
const fixtureDir = fileURLToPath(new URL("../evals/executive-replay/fixtures/", import.meta.url));

async function loadFixture(name) {
  const raw = await fs.readFile(path.join(fixtureDir, name), "utf8");
  return JSON.parse(raw);
}

function collectStrings(value, output = []) {
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, output);
    }
    return output;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectStrings(item, output);
    }
  }
  return output;
}

test("checked-in executive replay fixtures cover the bounded category set", async () => {
  const listedFiles = [...EXECUTIVE_REPLAY_FIXTURE_FILES];
  assert.ok(listedFiles.length >= 5 && listedFiles.length <= 10);

  const directoryFiles = (await fs.readdir(fixtureDir))
    .filter((name) => name.endsWith(".json"))
    .sort();
  assert.deepEqual(directoryFiles, [...listedFiles].sort());

  const fixtures = await Promise.all(listedFiles.map((name) => loadFixture(name)));
  const categories = new Set(fixtures.map((fixture) => fixture.category));
  assert.deepEqual(
    [...categories].sort(),
    [...EXECUTIVE_REPLAY_FIXTURE_CATEGORIES].sort(),
  );

  const ids = fixtures.map((fixture) => fixture.id);
  assert.equal(new Set(ids).size, ids.length);

  for (const fixture of fixtures) {
    assert.equal(fixture.constraints?.deterministic, true, fixture.id);
    assert.equal(fixture.constraints?.bounded, true, fixture.id);
    assert.equal(fixture.constraints?.external_side_effects, false, fixture.id);
    assert.ok(String(fixture.request_text || "").length <= 120, fixture.id);
    assert.ok((fixture.task?.work_plan || []).length <= 3, fixture.id);
    assert.ok((fixture.first_run?.routing?.dispatched_actions || []).length <= 3, fixture.id);
    assert.ok((fixture.second_run?.routing?.dispatched_actions || []).length <= 3, fixture.id);

    const strings = collectStrings(fixture);
    for (const value of strings) {
      assert.ok(!/^https?:\/\//i.test(value), `${fixture.id} should stay local-only`);
      assert.ok(value.length <= 200, `${fixture.id} contains unbounded text`);
    }
  }
});

test("checked-in executive replay fixtures stay replayable and match expected outcomes", async () => {
  for (const name of EXECUTIVE_REPLAY_FIXTURE_FILES) {
    const fixture = await loadFixture(name);
    const report = replayExecutiveTaskEvolution({
      task: fixture.task,
      requestText: fixture.request_text,
      firstRun: fixture.first_run,
      secondRun: fixture.second_run,
    });

    assert.equal(report.first_run.success, fixture.expected.first_run.success, `${fixture.id} first run success`);
    assert.equal(report.first_run.outcome.nextState, fixture.expected.first_run.outcome_state, `${fixture.id} first run outcome`);
    assert.equal(
      report.first_run.execution_reflection_summary.overall_status,
      fixture.expected.first_run.reflection_status,
      `${fixture.id} first run reflection`,
    );
    assert.equal(
      report.first_run.execution_reflection_summary.deviation_rate,
      fixture.expected.first_run.deviation_rate,
      `${fixture.id} first run deviation`,
    );

    assert.equal(report.second_run.success, fixture.expected.second_run.success, `${fixture.id} second run success`);
    assert.equal(report.second_run.outcome.nextState, fixture.expected.second_run.outcome_state, `${fixture.id} second run outcome`);
    assert.equal(
      report.second_run.execution_reflection_summary.overall_status,
      fixture.expected.second_run.reflection_status,
      `${fixture.id} second run reflection`,
    );
    assert.equal(
      report.second_run.execution_reflection_summary.deviation_rate,
      fixture.expected.second_run.deviation_rate,
      `${fixture.id} second run deviation`,
    );

    if (Array.isArray(fixture.expected.first_run.step_reasons)) {
      assert.deepEqual(
        report.first_run.execution_reflection.step_reviews.map((item) => item.reason),
        fixture.expected.first_run.step_reasons,
        `${fixture.id} first run reasons`,
      );
    }

    assert.equal(
      report.improvement_delta.status,
      fixture.expected.improvement_delta.status,
      `${fixture.id} delta status`,
    );
    assert.equal(
      report.improvement_delta.success.status,
      fixture.expected.improvement_delta.success_status,
      `${fixture.id} delta success`,
    );
    assert.equal(
      report.improvement_delta.deviation.rate.status,
      fixture.expected.improvement_delta.deviation_status,
      `${fixture.id} delta deviation`,
    );

    if (fixture.expected.improvement_delta.intent_status) {
      assert.equal(
        report.improvement_delta.steps.intents.status,
        fixture.expected.improvement_delta.intent_status,
        `${fixture.id} delta intents`,
      );
    }
  }
});

test("executive replay CLI can read a checked-in fixture directly", async () => {
  const fixturePath = path.join(fixtureDir, EXECUTIVE_REPLAY_FIXTURE_FILES[0]);
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/executive-evolution-replay.mjs",
    fixturePath,
  ], {
    cwd: process.cwd(),
  });

  assert.match(stdout, /Executive Evolution Replay/);
  assert.match(stdout, /Task:/);
  assert.match(stdout, /Improvement delta:/);
});


import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("executive replay pack CLI loads all fixtures", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/executive-evolution-replay-pack.mjs",
  ], {
    cwd: process.cwd(),
  });

  assert.match(stdout, /Executive Evolution Replay Pack/);
  assert.match(stdout, /normal-success\.search-answer \[normal_success\]/);
  assert.match(stdout, /partial-success\.meeting-follow-up \[partial_success\]/);
  assert.match(stdout, /fail-closed\.tool-required-fallback \[fail_closed\]/);
  assert.match(stdout, /follow-up-continuity\.active-doc \[follow_up_continuity\]/);
  assert.match(stdout, /missing-info\.improvement-trigger\.document-review \[missing_info_improvement_trigger\]/);
});

test("executive replay pack CLI aggregates improved unchanged and regressed counts correctly", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/executive-evolution-replay-pack.mjs",
  ], {
    cwd: process.cwd(),
  });

  assert.match(stdout, /Summary \| improved_count=2 \| unchanged_count=3 \| regressed_count=0/);
});

test("executive replay pack CLI supports --json", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/executive-evolution-replay-pack.mjs",
    "--json",
  ], {
    cwd: process.cwd(),
  });

  const parsed = JSON.parse(stdout);
  assert.equal(Array.isArray(parsed.cases), true);
  assert.equal(parsed.cases.length, 5);
  assert.deepEqual(parsed.summary, {
    total_count: 5,
    improved_count: 2,
    unchanged_count: 3,
    regressed_count: 0,
  });
});

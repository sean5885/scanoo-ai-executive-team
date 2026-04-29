import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("migration baseline script lists pr00-pr11", () => {
  const output = execFileSync("node", ["scripts/run-migration-baseline.mjs", "--list"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
  });
  assert.match(output, /pr00/);
  assert.match(output, /pr11/);
});

test("migration baseline script supports dry-run for pr11 without executing tests", () => {
  const output = execFileSync("node", ["scripts/run-migration-baseline.mjs", "pr11", "--dry-run"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
  });
  assert.match(output, /Running migration baseline: pr11/);
  assert.match(output, /\[migration-baseline:pr11\]/);
  assert.match(output, /tests\/system-self-check\.test\.mjs/);
  assert.match(output, /tests\/release-check\.test\.mjs/);
  assert.match(output, /tests\/pdf-acceptance-eval\.test\.mjs/);
  assert.match(output, /dry-run complete/);
});

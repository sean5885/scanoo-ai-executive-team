import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";

const { buildDependencySummary } = await import("../src/dependency-guardrails.mjs");

async function writeJson(filePath, payload) {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

test("dependency guardrails pass when lockfiles avoid blocked versions", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "dependency-guardrails-pass-"));
  await mkdir(path.join(baseDir, "openclaw-plugin", "lark-kb"), { recursive: true });

  await writeJson(path.join(baseDir, "package-lock.json"), {
    name: "demo",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "demo",
      },
      "node_modules/axios": {
        version: "1.13.6",
      },
    },
  });
  await writeJson(path.join(baseDir, "openclaw-plugin", "lark-kb", "package-lock.json"), {
    name: "lark-kb",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "lark-kb",
      },
      "node_modules/typescript": {
        version: "5.9.3",
      },
    },
  });

  const summary = await buildDependencySummary({ rootDir: baseDir });

  assert.equal(summary.status, "pass");
  assert.deepEqual(summary.violations, []);
  assert.deepEqual(summary.errors, []);
  assert.deepEqual(summary.checked_lockfiles, [
    "openclaw-plugin/lark-kb/package-lock.json",
    "package-lock.json",
  ]);
});

test("dependency guardrails fail when lockfile resolves to a blocked axios version", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "dependency-guardrails-fail-"));
  await writeJson(path.join(baseDir, "package-lock.json"), {
    name: "demo",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "demo",
      },
      "node_modules/axios": {
        version: "1.14.1",
      },
    },
  });

  const summary = await buildDependencySummary({ rootDir: baseDir });

  assert.equal(summary.status, "fail");
  assert.equal(summary.violations.length, 1);
  assert.deepEqual(summary.violations[0], {
    lockfile_path: "package-lock.json",
    package_name: "axios",
    detected_version: "1.14.1",
    package_path: "node_modules/axios",
    reason: "blocked due to the 2026-03-31 npm maintainer compromise",
  });
});

test("dependency guardrails CLI exits non-zero for blocked versions", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "dependency-guardrails-cli-"));
  await writeJson(path.join(baseDir, "package-lock.json"), {
    name: "demo",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "demo",
      },
      "node_modules/axios": {
        version: "0.30.4",
      },
    },
  });

  const result = spawnSync("node", [path.join(process.cwd(), "scripts", "dependency-guardrails.mjs"), "--json"], {
    cwd: baseDir,
    encoding: "utf8",
  });
  const parsed = JSON.parse(result.stdout);

  assert.equal(parsed.status, "fail");
  assert.equal(parsed.violations[0].detected_version, "0.30.4");
  assert.notEqual(result.status, 0);
});

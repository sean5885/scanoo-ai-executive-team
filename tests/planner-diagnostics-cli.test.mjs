import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

test("planner diagnostics CLI renders the fixed single-view summary", () => {
  const archiveDir = path.join(os.tmpdir(), `planner-diagnostics-summary-${Date.now()}`);
  const output = execFileSync("node", ["scripts/planner-diagnostics.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archiveDir,
    },
  });

  assert.match(output, /Planner Diagnostics/);
  assert.match(output, /planner contract gate: pass/);
  assert.match(output, /summary: gate=pass \| undefined_actions=0 \| undefined_presets=0 \| selector_contract_mismatches=0 \| deprecated_reachable_targets=0/);
  assert.match(output, /decision: Gate passes\. No planner implementation or contract change is required\./);
});

test("planner diagnostics CLI archives the full JSON report into snapshot history", async () => {
  const archiveDir = await mkdtemp(path.join(os.tmpdir(), "planner-diagnostics-history-"));
  const raw = execFileSync("node", ["scripts/planner-diagnostics.mjs", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archiveDir,
    },
  });
  const parsed = JSON.parse(raw);
  const manifest = readJson(path.join(archiveDir, "manifest.json"));
  const latestEntry = manifest.snapshots[0];
  const snapshot = readJson(path.join(archiveDir, "snapshots", `${manifest.latest_run_id}.json`));

  assert.equal(manifest.latest_run_id, latestEntry.run_id);
  assert.deepEqual(latestEntry, {
    run_id: manifest.latest_run_id,
    timestamp: latestEntry.timestamp,
    gate: "pass",
    undefined_actions: 0,
    undefined_presets: 0,
    selector_contract_mismatches: 0,
    deprecated_reachable_targets: 0,
  });
  assert.deepEqual(snapshot, parsed);
});

test("planner contract check also archives a snapshot-only history entry", async () => {
  const archiveDir = await mkdtemp(path.join(os.tmpdir(), "planner-contract-history-"));

  execFileSync("node", ["scripts/planner-contract-check.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archiveDir,
    },
  });

  const manifest = readJson(path.join(archiveDir, "manifest.json"));
  const latestEntry = manifest.snapshots[0];
  const snapshotPath = path.join(archiveDir, "snapshots", `${manifest.latest_run_id}.json`);
  const snapshot = readJson(snapshotPath);

  assert.match(manifest.latest_run_id, /^planner-contract-check-/);
  assert.equal(latestEntry.run_id, manifest.latest_run_id);
  assert.equal(latestEntry.gate, "pass");
  assert.equal(snapshot.diagnostics_summary.gate, "pass");
});

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, payload) {
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
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

test("planner diagnostics CLI renders compare-previous with directional markers", async () => {
  const archiveDir = await mkdtemp(path.join(os.tmpdir(), "planner-diagnostics-compare-previous-"));
  execFileSync("node", ["scripts/planner-diagnostics.mjs", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archiveDir,
    },
  });

  const manifestPath = path.join(archiveDir, "manifest.json");
  const manifest = readJson(manifestPath);
  const firstRunId = manifest.latest_run_id;
  const firstSnapshotPath = path.join(archiveDir, "snapshots", `${firstRunId}.json`);
  const firstSnapshot = readJson(firstSnapshotPath);

  firstSnapshot.gate = {
    ok: false,
    failing_categories: ["undefined_actions", "selector_contract_mismatches"],
    fail_summary: [
      { category: "undefined_actions", count: 2 },
      { category: "selector_contract_mismatches", count: 1 },
    ],
  };
  firstSnapshot.ok = false;
  firstSnapshot.summary.undefined_actions = 2;
  firstSnapshot.summary.selector_contract_mismatches = 1;
  firstSnapshot.diagnostics_summary.gate = "fail";
  firstSnapshot.diagnostics_summary.undefined_actions = 2;
  firstSnapshot.diagnostics_summary.selector_contract_mismatches = 1;
  firstSnapshot.decision = {
    action: "fix_planner_implementation",
    blocking_categories: ["undefined_actions", "selector_contract_mismatches"],
    summary: "Default: fix planner implementation first.",
  };
  writeJson(firstSnapshotPath, firstSnapshot);

  manifest.snapshots[0].gate = "fail";
  manifest.snapshots[0].undefined_actions = 2;
  manifest.snapshots[0].selector_contract_mismatches = 1;
  writeJson(manifestPath, manifest);

  const output = execFileSync("node", ["scripts/planner-diagnostics.mjs", "--compare-previous"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archiveDir,
    },
  });

  assert.match(output, /Planner Diagnostics Compare/);
  assert.match(output, /Current: snapshot:planner-diagnostics-/);
  assert.match(output, new RegExp(`Compare: snapshot:${firstRunId}`));
  assert.match(output, /↓ gate: fail -> pass/);
  assert.match(output, /↓ undefined_actions: 2 -> 0 \(-2\)/);
  assert.match(output, /= undefined_presets: 0/);
  assert.match(output, /↓ selector_contract_mismatches: 1 -> 0 \(-1\)/);
  assert.match(output, /= deprecated_reachable_targets: 0/);
  assert.doesNotMatch(output, /findings:/);
});

test("planner diagnostics CLI json compare_summary only includes changed fields", async () => {
  const archiveDir = await mkdtemp(path.join(os.tmpdir(), "planner-diagnostics-compare-json-"));
  execFileSync("node", ["scripts/planner-diagnostics.mjs", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archiveDir,
    },
  });

  const manifestPath = path.join(archiveDir, "manifest.json");
  const manifest = readJson(manifestPath);
  const firstRunId = manifest.latest_run_id;
  const firstSnapshotPath = path.join(archiveDir, "snapshots", `${firstRunId}.json`);
  const firstSnapshot = readJson(firstSnapshotPath);

  firstSnapshot.gate = {
    ok: false,
    failing_categories: ["undefined_presets"],
    fail_summary: [
      { category: "undefined_presets", count: 3 },
    ],
  };
  firstSnapshot.ok = false;
  firstSnapshot.summary.undefined_presets = 3;
  firstSnapshot.summary.deprecated_reachable_targets = 1;
  firstSnapshot.diagnostics_summary.gate = "fail";
  firstSnapshot.diagnostics_summary.undefined_presets = 3;
  firstSnapshot.diagnostics_summary.deprecated_reachable_targets = 1;
  firstSnapshot.decision = {
    action: "fix_planner_implementation",
    blocking_categories: ["undefined_presets"],
    summary: "Default: fix planner implementation first.",
  };
  writeJson(firstSnapshotPath, firstSnapshot);

  manifest.snapshots[0].gate = "fail";
  manifest.snapshots[0].undefined_presets = 3;
  manifest.snapshots[0].deprecated_reachable_targets = 1;
  writeJson(manifestPath, manifest);

  const raw = execFileSync("node", ["scripts/planner-diagnostics.mjs", "--json", "--compare-snapshot", firstRunId], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archiveDir,
    },
  });
  const parsed = JSON.parse(raw);
  const updatedManifest = readJson(manifestPath);
  const latestSnapshot = readJson(path.join(archiveDir, "snapshots", `${updatedManifest.latest_run_id}.json`));

  assert.deepEqual(parsed.compare_summary, {
    gate: {
      previous: "fail",
      current: "pass",
      status: "better",
    },
    undefined_presets: {
      previous: 3,
      current: 0,
      delta: -3,
      status: "better",
    },
    deprecated_reachable_targets: {
      previous: 1,
      current: 0,
      delta: -1,
      status: "better",
    },
  });
  assert.deepEqual(latestSnapshot.compare_summary, parsed.compare_summary);
});

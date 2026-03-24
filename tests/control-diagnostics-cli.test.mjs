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

function seedRoutingDiagnosticsArchive(routingArchiveDir) {
  execFileSync("node", ["scripts/routing-eval.mjs", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: routingArchiveDir,
    },
  });
}

test("control diagnostics CLI renders the fixed single-view summary", async () => {
  const controlArchiveDir = await mkdtemp(path.join(os.tmpdir(), "control-diagnostics-summary-"));
  const routingArchiveDir = await mkdtemp(path.join(os.tmpdir(), "control-diagnostics-routing-summary-"));
  seedRoutingDiagnosticsArchive(routingArchiveDir);

  const output = execFileSync("node", ["scripts/control-diagnostics.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      CONTROL_DIAGNOSTICS_ARCHIVE_DIR: controlArchiveDir,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: routingArchiveDir,
    },
  });

  assert.match(output, /Control Diagnostics/);
  assert.match(output, /summary: overall=pass \| control=pass \| routing=pass \| write=pass/);
  assert.match(output, /control_summary: issues=0 \| decisions=3 \| owners=3 \| integrations=3/);
  assert.match(output, /routing_summary: status=pass \| accuracy=1 \| compare=unavailable \| doc_boundary_regression=false/);
  assert.match(output, /write_summary: issues=0 \| guarded_operations=5 \| create_surfaces=2/);
  assert.match(output, /decision: observe_only \| line none/);
});

test("control diagnostics CLI archives the full JSON report into snapshot history", async () => {
  const controlArchiveDir = await mkdtemp(path.join(os.tmpdir(), "control-diagnostics-history-"));
  const routingArchiveDir = await mkdtemp(path.join(os.tmpdir(), "control-diagnostics-routing-history-"));
  seedRoutingDiagnosticsArchive(routingArchiveDir);

  const raw = execFileSync("node", ["scripts/control-diagnostics.mjs", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      CONTROL_DIAGNOSTICS_ARCHIVE_DIR: controlArchiveDir,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: routingArchiveDir,
    },
  });
  const parsed = JSON.parse(raw);
  const manifest = readJson(path.join(controlArchiveDir, "manifest.json"));
  const latestEntry = manifest.snapshots[0];
  const snapshot = readJson(path.join(controlArchiveDir, "snapshots", `${manifest.latest_run_id}.json`));

  assert.equal(manifest.latest_run_id, latestEntry.run_id);
  assert.deepEqual(latestEntry, {
    run_id: manifest.latest_run_id,
    timestamp: latestEntry.timestamp,
    overall_status: "pass",
    control_status: "pass",
    routing_status: "pass",
    write_status: "pass",
    control_issue_count: 0,
    routing_issue_count: 0,
    write_issue_count: 0,
  });
  assert.deepEqual(snapshot, parsed);
});

test("control diagnostics CLI renders compare-previous with directional markers", async () => {
  const controlArchiveDir = await mkdtemp(path.join(os.tmpdir(), "control-diagnostics-compare-previous-"));
  const routingArchiveDir = await mkdtemp(path.join(os.tmpdir(), "control-diagnostics-routing-compare-previous-"));
  seedRoutingDiagnosticsArchive(routingArchiveDir);

  execFileSync("node", ["scripts/control-diagnostics.mjs", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      CONTROL_DIAGNOSTICS_ARCHIVE_DIR: controlArchiveDir,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: routingArchiveDir,
    },
  });

  const manifestPath = path.join(controlArchiveDir, "manifest.json");
  const manifest = readJson(manifestPath);
  const firstRunId = manifest.latest_run_id;
  const firstSnapshotPath = path.join(controlArchiveDir, "snapshots", `${firstRunId}.json`);
  const firstSnapshot = readJson(firstSnapshotPath);

  firstSnapshot.ok = false;
  firstSnapshot.diagnostics_summary.overall_status = "fail";
  firstSnapshot.diagnostics_summary.control_status = "fail";
  firstSnapshot.diagnostics_summary.write_status = "fail";
  firstSnapshot.diagnostics_summary.control_issue_count = 2;
  firstSnapshot.diagnostics_summary.write_issue_count = 1;
  writeJson(firstSnapshotPath, firstSnapshot);

  manifest.snapshots[0].overall_status = "fail";
  manifest.snapshots[0].control_status = "fail";
  manifest.snapshots[0].write_status = "fail";
  manifest.snapshots[0].control_issue_count = 2;
  manifest.snapshots[0].write_issue_count = 1;
  writeJson(manifestPath, manifest);

  const output = execFileSync("node", ["scripts/control-diagnostics.mjs", "--compare-previous"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      CONTROL_DIAGNOSTICS_ARCHIVE_DIR: controlArchiveDir,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: routingArchiveDir,
    },
  });

  assert.match(output, /Control Diagnostics Compare/);
  assert.match(output, /Current: snapshot:control-diagnostics-/);
  assert.match(output, new RegExp(`Compare: snapshot:${firstRunId}`));
  assert.match(output, /↓ overall_status: fail -> pass/);
  assert.match(output, /↓ control_status: fail -> pass/);
  assert.match(output, /= routing_status: pass/);
  assert.match(output, /↓ write_status: fail -> pass/);
  assert.match(output, /↓ control_issue_count: 2 -> 0 \(-2\)/);
  assert.match(output, /= routing_issue_count: 0/);
  assert.match(output, /↓ write_issue_count: 1 -> 0 \(-1\)/);
});

test("control diagnostics CLI json compare_summary only includes changed fields", async () => {
  const controlArchiveDir = await mkdtemp(path.join(os.tmpdir(), "control-diagnostics-compare-json-"));
  const routingArchiveDir = await mkdtemp(path.join(os.tmpdir(), "control-diagnostics-routing-compare-json-"));
  seedRoutingDiagnosticsArchive(routingArchiveDir);

  execFileSync("node", ["scripts/control-diagnostics.mjs", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      CONTROL_DIAGNOSTICS_ARCHIVE_DIR: controlArchiveDir,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: routingArchiveDir,
    },
  });

  const manifestPath = path.join(controlArchiveDir, "manifest.json");
  const manifest = readJson(manifestPath);
  const firstRunId = manifest.latest_run_id;
  const firstSnapshotPath = path.join(controlArchiveDir, "snapshots", `${firstRunId}.json`);
  const firstSnapshot = readJson(firstSnapshotPath);

  firstSnapshot.ok = false;
  firstSnapshot.diagnostics_summary.overall_status = "degrade";
  firstSnapshot.diagnostics_summary.routing_status = "degrade";
  firstSnapshot.diagnostics_summary.routing_issue_count = 2;
  writeJson(firstSnapshotPath, firstSnapshot);

  manifest.snapshots[0].overall_status = "degrade";
  manifest.snapshots[0].routing_status = "degrade";
  manifest.snapshots[0].routing_issue_count = 2;
  writeJson(manifestPath, manifest);

  const raw = execFileSync("node", ["scripts/control-diagnostics.mjs", "--json", "--compare-snapshot", firstRunId], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      CONTROL_DIAGNOSTICS_ARCHIVE_DIR: controlArchiveDir,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: routingArchiveDir,
    },
  });
  const parsed = JSON.parse(raw);
  const updatedManifest = readJson(manifestPath);
  const latestSnapshot = readJson(path.join(controlArchiveDir, "snapshots", `${updatedManifest.latest_run_id}.json`));

  assert.deepEqual(parsed.compare_summary, {
    overall_status: {
      previous: "degrade",
      current: "pass",
      status: "better",
    },
    routing_status: {
      previous: "degrade",
      current: "pass",
      status: "better",
    },
    routing_issue_count: {
      previous: 2,
      current: 0,
      delta: -2,
      status: "better",
    },
  });
  assert.deepEqual(latestSnapshot.compare_summary, parsed.compare_summary);
});

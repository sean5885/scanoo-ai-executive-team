import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";

import {
  buildRealTrafficEvidenceReport,
  writeRealTrafficEvidenceReport,
} from "../src/real-traffic-evidence.mjs";

async function writeJson(filePath, payload) {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function isoHoursAgo(hours = 0) {
  return new Date(Date.now() - (hours * 60 * 60 * 1000)).toISOString();
}

test("real traffic evidence report passes when all windows meet thresholds", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "real-traffic-evidence-pass-"));
  const historyDir = path.join(baseDir, "history");
  await mkdir(historyDir, { recursive: true });

  const runAPath = path.join(historyDir, "run-a.json");
  const runBPath = path.join(historyDir, "run-b.json");
  const runCPath = path.join(historyDir, "run-c.json");
  const runDPath = path.join(historyDir, "run-d.json");

  const runPayload = {
    metrics: {
      task_success_rate: 1,
      fake_completion_rate: 0,
      evidence_coverage_rate: 1,
      pdf_task_success_rate: 1,
    },
  };

  await Promise.all([
    writeJson(runAPath, runPayload),
    writeJson(runBPath, runPayload),
    writeJson(runCPath, runPayload),
    writeJson(runDPath, runPayload),
  ]);

  const manifestPath = path.join(baseDir, "manifest.json");
  await writeJson(manifestPath, {
    latest_run_id: "run-a",
    snapshots: [
      { run_id: "run-a", generated_at: isoHoursAgo(1), path: runAPath },
      { run_id: "run-b", generated_at: isoHoursAgo(4), path: runBPath },
      { run_id: "run-c", generated_at: isoHoursAgo(30), path: runCPath },
      { run_id: "run-d", generated_at: isoHoursAgo(100), path: runDPath },
    ],
  });

  const report = await buildRealTrafficEvidenceReport({ manifestPath });
  assert.equal(report.overall_status, "pass");
  assert.deepEqual(report.blocking_reasons, []);
  assert.equal(report.windows.length, 3);
  assert.equal(report.windows.every((item) => item.status === "pass"), true);

  const persisted = await writeRealTrafficEvidenceReport(report, {
    outputPath: path.join(baseDir, "latest.json"),
    historyDir: path.join(baseDir, "evidence-history"),
  });
  assert.equal(typeof persisted.run_id, "string");
  assert.match(persisted.output_path, /latest\.json$/);
});

test("real traffic evidence report fails when recent window run misses threshold", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "real-traffic-evidence-fail-"));
  const historyDir = path.join(baseDir, "history");
  await mkdir(historyDir, { recursive: true });

  const runAPath = path.join(historyDir, "run-a.json");
  const runBPath = path.join(historyDir, "run-b.json");
  const runCPAth = path.join(historyDir, "run-c.json");
  const runDPath = path.join(historyDir, "run-d.json");

  await writeJson(runAPath, {
    metrics: {
      task_success_rate: 0.5,
      fake_completion_rate: 0,
      evidence_coverage_rate: 1,
      pdf_task_success_rate: 1,
    },
  });

  const healthy = {
    metrics: {
      task_success_rate: 1,
      fake_completion_rate: 0,
      evidence_coverage_rate: 1,
      pdf_task_success_rate: 1,
    },
  };
  await Promise.all([
    writeJson(runBPath, healthy),
    writeJson(runCPAth, healthy),
    writeJson(runDPath, healthy),
  ]);

  const manifestPath = path.join(baseDir, "manifest.json");
  await writeJson(manifestPath, {
    latest_run_id: "run-a",
    snapshots: [
      { run_id: "run-a", generated_at: isoHoursAgo(1), path: runAPath },
      { run_id: "run-b", generated_at: isoHoursAgo(4), path: runBPath },
      { run_id: "run-c", generated_at: isoHoursAgo(30), path: runCPAth },
      { run_id: "run-d", generated_at: isoHoursAgo(100), path: runDPath },
    ],
  });

  const report = await buildRealTrafficEvidenceReport({ manifestPath });
  assert.equal(report.overall_status, "fail");
  assert.equal(report.blocking_reasons.includes("window_24h_gate_fail"), true);
  const window24 = report.windows.find((item) => item.window_hours === 24);
  assert.equal(window24.status, "fail");
  assert.equal(window24.fail_runs >= 1, true);
});

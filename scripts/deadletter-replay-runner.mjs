import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { cleanText } from "../src/message-intent-utils.mjs";
import {
  listExecutiveWorkDeadletters,
  replayExecutiveWorkDeadletter,
} from "../src/task-runtime/autonomy-job-store.mjs";

const OUTPUT_LATEST_PATH = ".data/deadletter-replay/latest.json";
const OUTPUT_HISTORY_DIR = ".data/deadletter-replay/history";
const OUTPUT_MANIFEST_PATH = `${OUTPUT_HISTORY_DIR}/manifest.json`;

function getArgValue(flag = "") {
  const index = process.argv.indexOf(flag);
  if (index < 0) {
    return null;
  }
  return process.argv[index + 1] || null;
}

function normalizePositiveInteger(value = null, fallback = 50, { min = 1, max = 5000 } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

async function readJsonIfExists(filePath = "") {
  try {
    const raw = await readFile(path.resolve(filePath), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeJson(filePath = "", payload = {}) {
  const resolvedPath = path.resolve(filePath);
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return resolvedPath;
}

async function appendHistory(report = {}) {
  await mkdir(path.resolve(OUTPUT_HISTORY_DIR), { recursive: true });
  const runId = cleanText(report?.run_id) || `deadletter-replay-${Date.now()}`;
  const snapshotPath = path.resolve(OUTPUT_HISTORY_DIR, `${runId}.json`);
  await writeJson(snapshotPath, report);

  const manifest = await readJsonIfExists(OUTPUT_MANIFEST_PATH) || {
    version: "deadletter_replay_manifest_v1",
    latest_run_id: null,
    snapshots: [],
  };
  const entry = {
    run_id: runId,
    generated_at: report.generated_at || new Date().toISOString(),
    total_deadletters: Number(report?.total_deadletters || 0),
    replay_attempted: Number(report?.replay_attempted || 0),
    replay_succeeded: Number(report?.replay_succeeded || 0),
    replay_success_rate: Number.isFinite(Number(report?.replay_success_rate))
      ? Number(report.replay_success_rate)
      : null,
  };
  manifest.latest_run_id = runId;
  manifest.snapshots = [
    entry,
    ...(Array.isArray(manifest.snapshots) ? manifest.snapshots : []).filter((item) => cleanText(item?.run_id) !== runId),
  ].slice(0, 200);
  await writeJson(OUTPUT_MANIFEST_PATH, manifest);

  return {
    run_id: runId,
    snapshot_path: snapshotPath,
    manifest_path: path.resolve(OUTPUT_MANIFEST_PATH),
  };
}

function safeRatio(numerator = 0, denominator = 0, digits = 4) {
  const n = Number(numerator);
  const d = Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) {
    return null;
  }
  return Number((n / d).toFixed(digits));
}

async function main() {
  const wantsJson = process.argv.includes("--json");
  const dryRun = process.argv.includes("--dry-run");
  const limit = normalizePositiveInteger(getArgValue("--limit"), 50);
  const graphId = cleanText(getArgValue("--graph-id"));
  const operatorId = cleanText(getArgValue("--operator-id")) || "deadletter-replay-runner";
  const reason = cleanText(getArgValue("--reason")) || "scheduled_replay";

  const deadletters = listExecutiveWorkDeadletters({
    ...(graphId ? { graphId } : {}),
    limit,
  });
  const replayCandidates = Array.isArray(deadletters)
    ? deadletters.filter((item) => cleanText(item?.status || "deadletter") !== "replayed")
    : [];

  const replayResults = [];
  let replaySucceeded = 0;
  for (const deadletter of replayCandidates) {
    const deadletterId = cleanText(deadletter?.id);
    if (!deadletterId) {
      replayResults.push({
        deadletter_id: null,
        ok: false,
        error: "deadletter_id_missing",
      });
      continue;
    }
    if (dryRun) {
      replayResults.push({
        deadletter_id: deadletterId,
        ok: true,
        dry_run: true,
      });
      replaySucceeded += 1;
      continue;
    }
    const replay = replayExecutiveWorkDeadletter({
      deadletterId,
      operatorId,
      reason,
    });
    if (replay?.ok === true) {
      replaySucceeded += 1;
    }
    replayResults.push({
      deadletter_id: deadletterId,
      ok: replay?.ok === true,
      ...(replay?.error ? { error: cleanText(replay.error) || "replay_failed" } : {}),
    });
  }

  const report = {
    version: "deadletter_replay_report_v1",
    run_id: `deadletter-replay-${Date.now()}-${randomUUID().slice(0, 8)}`,
    generated_at: new Date().toISOString(),
    dry_run: dryRun,
    operator_id: operatorId,
    graph_id: graphId || null,
    total_deadletters: Array.isArray(deadletters) ? deadletters.length : 0,
    replay_attempted: replayCandidates.length,
    replay_succeeded: replaySucceeded,
    replay_success_rate: safeRatio(replaySucceeded, replayCandidates.length),
    results: replayResults,
  };

  const latestPath = await writeJson(OUTPUT_LATEST_PATH, report);
  const history = await appendHistory(report);
  const output = {
    ...report,
    output_path: latestPath,
    history,
  };
  if (wantsJson) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log([
      "Deadletter Replay Runner",
      `total_deadletters: ${output.total_deadletters}`,
      `replay_attempted: ${output.replay_attempted}`,
      `replay_succeeded: ${output.replay_succeeded}`,
      `replay_success_rate: ${output.replay_success_rate == null ? "null" : output.replay_success_rate}`,
      `output: ${latestPath}`,
    ].join("\n"));
  }
  if (!dryRun && output.replay_attempted > 0 && output.replay_success_rate != null && output.replay_success_rate < 0.95) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(`deadletter-replay-runner error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}


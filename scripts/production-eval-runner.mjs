import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { productionLikePacks } from "../evals/production-like/index.mjs";
import { cleanText } from "../src/message-intent-utils.mjs";
import { computeQualityMetrics } from "../src/quality-metrics.mjs";

const DEFAULT_OUTPUT_PATH = ".data/evals/production/latest.json";
const HISTORY_DIR = ".data/evals/production/history";
const HISTORY_MANIFEST_PATH = `${HISTORY_DIR}/manifest.json`;

function getArgValue(flag = "") {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] || null;
}

function parsePackFilter() {
  const packs = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== "--pack") {
      continue;
    }
    const value = cleanText(process.argv[index + 1]);
    if (value) {
      packs.push(...value.split(",").map((item) => cleanText(item)));
    }
  }
  return Array.from(new Set(packs.filter(Boolean)));
}

function resolveSelectedPacks(packFilter = []) {
  if (!packFilter.length) {
    return productionLikePacks;
  }
  const map = new Map(productionLikePacks.map((pack) => [pack.id, pack]));
  const selected = [];
  for (const packId of packFilter) {
    const pack = map.get(packId);
    if (!pack) {
      throw new Error(`unknown production-like pack: ${packId}`);
    }
    selected.push(pack);
  }
  return selected;
}

function buildReport({ selectedPacks = [] } = {}) {
  const allCases = selectedPacks.flatMap((pack) => Array.isArray(pack?.cases) ? pack.cases : []);
  const summary = computeQualityMetrics(allCases);

  return {
    version: "production_eval_v1",
    generated_at: new Date().toISOString(),
    pack_ids: selectedPacks.map((pack) => pack.id),
    pack_count: selectedPacks.length,
    case_count: allCases.length,
    task_success_rate: summary.metrics.task_success_rate,
    fake_completion_rate: summary.metrics.fake_completion_rate,
    evidence_coverage_rate: summary.metrics.evidence_coverage_rate,
    agent_parallel_efficiency: summary.metrics.agent_parallel_efficiency,
    failed_cases: summary.failed_cases,
    metrics: summary.metrics,
    counts: summary.counts,
    sample_size: summary.sample_size,
    flags: summary.flags,
  };
}

function renderSummary(report = {}) {
  return [
    "Production Eval Runner",
    `packs: ${Array.isArray(report.pack_ids) ? report.pack_ids.join(",") : "none"}`,
    `cases: ${Number(report.case_count || 0)}`,
    `task_success_rate: ${report.task_success_rate ?? "null"}`,
    `fake_completion_rate: ${report.fake_completion_rate ?? "null"}`,
    `evidence_coverage_rate: ${report.evidence_coverage_rate ?? "null"}`,
    `agent_parallel_efficiency: ${report.agent_parallel_efficiency ?? "null"}`,
    `failed_cases: ${Array.isArray(report.failed_cases) ? report.failed_cases.length : 0}`,
  ].join("\n");
}

async function writeReport(report = {}, outputPath = DEFAULT_OUTPUT_PATH) {
  const resolvedPath = path.resolve(outputPath);
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return resolvedPath;
}

async function appendHistory(report = {}) {
  const runId = `production-eval-${Date.now()}`;
  const resolvedHistoryDir = path.resolve(HISTORY_DIR);
  const snapshotPath = path.join(resolvedHistoryDir, `${runId}.json`);
  const manifestPath = path.resolve(HISTORY_MANIFEST_PATH);

  await mkdir(resolvedHistoryDir, { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify({ ...report, run_id: runId }, null, 2)}\n`, "utf8");

  let manifest = {
    latest_run_id: null,
    snapshots: [],
  };
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    manifest = {
      latest_run_id: null,
      snapshots: [],
    };
  }

  const nextSnapshots = Array.isArray(manifest?.snapshots) ? manifest.snapshots : [];
  nextSnapshots.unshift({
    run_id: runId,
    generated_at: report.generated_at,
    path: snapshotPath,
    task_success_rate: report.task_success_rate,
    fake_completion_rate: report.fake_completion_rate,
    evidence_coverage_rate: report.evidence_coverage_rate,
    agent_parallel_efficiency: report.agent_parallel_efficiency,
  });

  const nextManifest = {
    latest_run_id: runId,
    snapshots: nextSnapshots.slice(0, 50),
  };
  await writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");

  return {
    run_id: runId,
    snapshot_path: snapshotPath,
    manifest_path: manifestPath,
  };
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log([
      "Usage:",
      "  node scripts/production-eval-runner.mjs",
      "  node scripts/production-eval-runner.mjs --pack pdf-single-doc",
      "  node scripts/production-eval-runner.mjs --output .data/evals/production/latest.json",
      "  node scripts/production-eval-runner.mjs --json",
    ].join("\n"));
    return;
  }

  const wantsJson = process.argv.includes("--json");
  const packFilter = parsePackFilter();
  const selectedPacks = resolveSelectedPacks(packFilter);
  const outputPath = getArgValue("--output") || DEFAULT_OUTPUT_PATH;
  const report = buildReport({ selectedPacks });
  const writtenPath = await writeReport(report, outputPath);
  const history = await appendHistory(report);

  if (wantsJson) {
    console.log(JSON.stringify({ ...report, output_path: writtenPath, history }, null, 2));
  } else {
    console.log(renderSummary(report));
    console.log(`output: ${writtenPath}`);
    console.log(`history: ${history.snapshot_path}`);
  }
}

try {
  await main();
} catch (error) {
  console.error(`production-eval-runner error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

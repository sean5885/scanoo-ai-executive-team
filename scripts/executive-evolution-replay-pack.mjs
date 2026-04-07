import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { replayExecutiveTaskEvolution } from "../src/executive-evolution-replay.mjs";

const fixtureDir = fileURLToPath(new URL("../evals/executive-replay/fixtures/", import.meta.url));

function printUsage() {
  console.log([
    "Usage:",
    "  node scripts/executive-evolution-replay-pack.mjs",
    "  node scripts/executive-evolution-replay-pack.mjs --json",
  ].join("\n"));
}

async function listReplaySpecFiles() {
  return (await fs.readdir(fixtureDir))
    .filter((name) => name.endsWith(".json"))
    .sort();
}

async function readReplaySpec(fileName = "") {
  const raw = await fs.readFile(path.join(fixtureDir, fileName), "utf8");
  return JSON.parse(raw);
}

function buildCaseResult(fileName = "", spec = {}, report = {}) {
  return {
    file: fileName,
    id: spec?.id || path.basename(fileName, ".json"),
    category: spec?.category || null,
    status: report?.improvement_delta?.status || "same",
    first_run_success: report?.first_run?.success === true,
    second_run_success: report?.second_run?.success === true,
    first_run_outcome: report?.first_run?.outcome?.nextState || null,
    second_run_outcome: report?.second_run?.outcome?.nextState || null,
    first_run_reflection_status: report?.first_run?.execution_reflection_summary?.overall_status || null,
    second_run_reflection_status: report?.second_run?.execution_reflection_summary?.overall_status || null,
  };
}

function buildSummary(caseResults = []) {
  const items = Array.isArray(caseResults) ? caseResults : [];
  return {
    total_count: items.length,
    improved_count: items.filter((item) => item.status === "improved").length,
    unchanged_count: items.filter((item) => item.status === "same").length,
    regressed_count: items.filter((item) => item.status === "regressed").length,
  };
}

function formatCaseResult(item = {}) {
  return [
    `${item.id} [${item.category || "unknown"}]`,
    `status=${item.status || "same"}`,
    `first=${item.first_run_success === true}/${item.first_run_outcome || "unknown"}/${item.first_run_reflection_status || "unknown"}`,
    `second=${item.second_run_success === true}/${item.second_run_outcome || "unknown"}/${item.second_run_reflection_status || "unknown"}`,
  ].join(" | ");
}

async function main() {
  if (process.argv.includes("--help")) {
    printUsage();
    return;
  }

  const wantsJson = process.argv.includes("--json");
  const files = await listReplaySpecFiles();
  const cases = [];

  for (const fileName of files) {
    const spec = await readReplaySpec(fileName);
    const report = replayExecutiveTaskEvolution({
      task: spec?.task || null,
      requestText: spec?.request_text || "",
      firstRun: spec?.first_run || null,
      secondRun: spec?.second_run || null,
    });
    cases.push(buildCaseResult(fileName, spec, report));
  }

  const summary = buildSummary(cases);
  const output = {
    fixture_dir: fixtureDir,
    cases,
    summary,
  };

  if (wantsJson) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log("Executive Evolution Replay Pack");
  for (const item of cases) {
    console.log(formatCaseResult(item));
  }
  console.log([
    "Summary",
    `improved_count=${summary.improved_count}`,
    `unchanged_count=${summary.unchanged_count}`,
    `regressed_count=${summary.regressed_count}`,
  ].join(" | "));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});


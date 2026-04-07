import fs from "node:fs/promises";

import {
  formatExecutiveReplayReport,
  replayExecutiveTaskEvolution,
} from "../src/executive-evolution-replay.mjs";

function getArgValue(flag = "") {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] || null;
}

async function readReplaySpec() {
  const filePath = process.argv[2] && !process.argv[2].startsWith("--")
    ? process.argv[2]
    : null;
  const raw = filePath
    ? await fs.readFile(filePath, "utf8")
    : await new Promise((resolve, reject) => {
        let buffer = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          buffer += chunk;
        });
        process.stdin.on("end", () => resolve(buffer));
        process.stdin.on("error", reject);
      });
  return JSON.parse(raw);
}

function printUsage() {
  console.log([
    "Usage:",
    "  node scripts/executive-evolution-replay.mjs <spec.json>",
    "  cat spec.json | node scripts/executive-evolution-replay.mjs --json",
  ].join("\n"));
}

async function main() {
  if (process.argv.includes("--help")) {
    printUsage();
    return;
  }

  const wantsJson = process.argv.includes("--json");
  const spec = await readReplaySpec();
  const report = replayExecutiveTaskEvolution({
    task: spec?.task || null,
    requestText: spec?.request_text || "",
    firstRun: spec?.first_run || null,
    secondRun: spec?.second_run || null,
  });

  if (wantsJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(formatExecutiveReplayReport(report));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

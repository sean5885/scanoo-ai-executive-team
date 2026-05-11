#!/usr/bin/env node

import {
  buildMemoryInfluenceReport,
  DEFAULT_ACTION_CHANGED_RATE_MIN,
  DEFAULT_MEMORY_HIT_RATE_MIN,
  DEFAULT_MEMORY_INFLUENCE_CASE_COUNT,
  MEMORY_INFLUENCE_GATE_VERSION,
  renderMemoryInfluenceReport,
} from "../src/memory-influence-gate.mjs";
import { cleanText } from "../src/message-intent-utils.mjs";

function toNumber(value, fallback) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getArgValue(flag = "") {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] || null;
}

function parseArgs() {
  return {
    wantsJson: process.argv.includes("--json"),
    strict: process.argv.includes("--strict"),
    caseCount: Math.max(1, Math.floor(toNumber(getArgValue("--cases"), DEFAULT_MEMORY_INFLUENCE_CASE_COUNT))),
    memoryHitRateMin: toNumber(getArgValue("--memory-hit-rate-min"), DEFAULT_MEMORY_HIT_RATE_MIN),
    actionChangedRateMin: toNumber(getArgValue("--action-changed-rate-min"), DEFAULT_ACTION_CHANGED_RATE_MIN),
  };
}

async function main() {
  const args = parseArgs();
  const report = await buildMemoryInfluenceReport({
    caseCount: args.caseCount,
    memoryHitRateMin: args.memoryHitRateMin,
    actionChangedRateMin: args.actionChangedRateMin,
  });
  if (args.wantsJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderMemoryInfluenceReport(report));
  }
  if (args.strict && report.ok !== true) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const result = {
    gate_version: MEMORY_INFLUENCE_GATE_VERSION,
    ok: false,
    gate: "fail",
    error: cleanText(error?.message || "") || "memory_influence_gate_runtime_error",
  };
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
});

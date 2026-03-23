import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { tasks as defaultTasks } from "../evals/real-user-tasks.mjs";
import { resetPlannerRuntimeContext, runPlannerToolFlow } from "../src/executive-planner.mjs";
import { cleanText } from "../src/message-intent-utils.mjs";

const SILENT_LOGGER = {
  info() {},
  debug() {},
  warn() {},
  error() {},
};

function normalizeRealUserTask(entry) {
  if (typeof entry === "string") {
    return {
      message: cleanText(entry),
      task_type: "",
      payload: {},
    };
  }

  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return {
      message: "",
      task_type: "",
      payload: {},
    };
  }

  return {
    message: cleanText(entry.message || entry.task || ""),
    task_type: cleanText(entry.taskType || entry.task_type || ""),
    payload: entry.payload && typeof entry.payload === "object" && !Array.isArray(entry.payload)
      ? entry.payload
      : {},
  };
}

export function projectRealUserResult(plannerResult = null) {
  if (!plannerResult || typeof plannerResult !== "object" || Array.isArray(plannerResult)) {
    return {
      final_result: plannerResult,
    };
  }

  const finalResult = plannerResult?.agent_execution?.result
    ? plannerResult.agent_execution.result
    : plannerResult;

  return {
    ...plannerResult,
    final_result: finalResult,
  };
}

export async function runRealUserTask(entry, { logger = SILENT_LOGGER } = {}) {
  const task = normalizeRealUserTask(entry);
  const plannerResult = await runPlannerToolFlow({
    userIntent: task.message,
    taskType: task.task_type,
    payload: task.payload,
    logger,
  });

  return {
    task,
    ...projectRealUserResult(plannerResult),
  };
}

export async function runRealUserLoop(entries = defaultTasks, { logger = SILENT_LOGGER } = {}) {
  const results = [];

  for (const entry of entries) {
    resetPlannerRuntimeContext();
    results.push(await runRealUserTask(entry, { logger }));
  }

  return results;
}

async function main() {
  const results = await runRealUserLoop(defaultTasks);

  for (const item of results) {
    const finalResult = item?.final_result || {};
    console.log(`\nTASK: ${item.task.message}`);
    console.log(`SELECTED_ACTION: ${item?.selected_action || "null"}`);
    console.log(`FINAL_RESULT_KIND: ${cleanText(finalResult?.kind || "") || "unknown"}`);
    console.log(`FINAL_RESULT_STATUS: ${cleanText(finalResult?.status || "") || "unknown"}`);
    console.log(`FINAL_RESULT_SUMMARY: ${cleanText(finalResult?.summary || "") || "(none)"}`);
    console.log(`EXECUTION_ERROR: ${cleanText(item?.execution_result?.error || "") || "none"}`);
  }
}

const isMain = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  await main();
}

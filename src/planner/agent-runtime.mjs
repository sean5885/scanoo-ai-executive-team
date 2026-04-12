import {
  formatDocResult,
  formatMixedResult,
  formatRuntimeResult,
} from "./result-formatters.mjs";
import { executeAgent } from "./agent-executor.mjs";

const AGENT_RUNTIME_RESULTS = Object.freeze({
  runtime_agent: Object.freeze({
    runtime_check: Object.freeze({
      runtime_status: "healthy",
      status: "ok",
    }),
  }),
  planner_agent: Object.freeze({
    planner_route: Object.freeze({
      message: "planner route placeholder result",
      status: "ok",
    }),
  }),
  company_brain_agent: Object.freeze({
    company_brain_read: Object.freeze({
      answer: "company brain read placeholder result",
      status: "ok",
    }),
  }),
});

function normalizeAgentExecution(exec = {}) {
  const normalizedAgent = typeof exec?.agent === "string" ? exec.agent.trim() : "";
  const normalizedAction = typeof exec?.action === "string" ? exec.action.trim() : "";

  if (normalizedAgent && normalizedAction) {
    return {
      ...exec,
      agent: normalizedAgent,
      action: normalizedAction,
    };
  }

  const derived = executeAgent({
    selected_action: exec?.selected_action,
    action: exec?.action,
    task_type: exec?.task_type,
    taskType: exec?.taskType,
  });
  return {
    ...exec,
    agent: normalizedAgent || derived.agent,
    action: normalizedAction || derived.action,
  };
}

export function runAgentExecution(exec, ctx = {}) {
  void ctx;
  const normalizedExec = normalizeAgentExecution(exec);
  const agent = normalizedExec.agent;
  const action = normalizedExec.action;
  const rawResult = AGENT_RUNTIME_RESULTS[agent]?.[action];

  if (rawResult) {
    let result = rawResult;

    if (agent === "runtime_agent" && action === "runtime_check") {
      result = formatRuntimeResult(rawResult);
    } else if (agent === "company_brain_agent" && action === "company_brain_read") {
      result = formatDocResult(rawResult);
    } else if (agent === "planner_agent" && action === "planner_route") {
      result = formatMixedResult(rawResult);
    }

    return {
      ...normalizedExec,
      result,
    };
  }

  return {
    ...normalizedExec,
    result: {
      status: "unknown",
    },
  };
}

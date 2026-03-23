import {
  formatDocResult,
  formatMeetingResult,
  formatMixedResult,
  formatRuntimeResult,
} from "./result-formatters.mjs";
import { executeAgent } from "./agent-executor.mjs";

const AGENT_RUNTIME_RESULTS = Object.freeze({
  meeting_agent: Object.freeze({
    meeting_summary: Object.freeze({
      summary: "meeting workflow placeholder result",
      status: "ok",
    }),
  }),
  doc_agent: Object.freeze({
    doc_answer: Object.freeze({
      answer: "doc workflow placeholder result",
      status: "ok",
    }),
  }),
  runtime_agent: Object.freeze({
    runtime_check: Object.freeze({
      runtime_status: "healthy",
      status: "ok",
    }),
  }),
  mixed_agent: Object.freeze({
    mixed_lane: Object.freeze({
      message: "mixed workflow placeholder result",
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

  const derived = executeAgent({ lane: exec?.lane });
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

    if (agent === "meeting_agent" && action === "meeting_summary") {
      result = formatMeetingResult(rawResult);
    } else if (agent === "doc_agent" && action === "doc_answer") {
      result = formatDocResult(rawResult);
    } else if (agent === "runtime_agent" && action === "runtime_check") {
      result = formatRuntimeResult(rawResult);
    } else if (agent === "mixed_agent" && action === "mixed_lane") {
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
      status: "fallback",
    },
  };
}

import { buildResultEnvelope } from "./result-schema.mjs";

export function formatMeetingResult(result = {}) {
  return buildResultEnvelope("meeting", {
    status: result.status || "ok",
    summary: result.summary || "meeting workflow placeholder result",
    actionable_items: result.action_items || [],
    confidence: 0.85,
    data: result,
  });
}

export function formatDocResult(result = {}) {
  return buildResultEnvelope("doc", {
    status: result.status || "ok",
    summary: result.answer || "doc workflow placeholder result",
    actionable_items: [],
    confidence: 0.8,
    data: result,
  });
}

export function formatRuntimeResult(result = {}) {
  return buildResultEnvelope("runtime", {
    status: result.status || "ok",
    summary: `runtime status: ${result.runtime_status || "unknown"}`,
    actionable_items: [],
    confidence: 0.9,
    data: result,
  });
}

export function formatMixedResult(result = {}) {
  return buildResultEnvelope("mixed", {
    status: result.status || "ok",
    summary: result.message || "mixed workflow placeholder result",
    actionable_items: [],
    confidence: 0.75,
    data: result,
  });
}

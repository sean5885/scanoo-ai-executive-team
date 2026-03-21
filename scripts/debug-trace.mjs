import process from "node:process";

import { getTraceDebugSnapshot } from "../src/monitoring-store.mjs";

function printUsage() {
  console.error("Usage: node scripts/debug-trace.mjs <trace_id>");
}

function toPrintableJson(value) {
  if (value == null) {
    return "null";
  }
  return JSON.stringify(value, null, 2);
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function compactValue(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function pushDetail(lines, label, value) {
  const normalized = compactValue(value);
  if (!normalized) {
    return;
  }
  lines.push(`  ${label}: ${normalized}`);
}

function buildPlannerSummary(event = null) {
  const payload = event?.payload || {};
  return {
    event: event?.event || null,
    action: payload.selected_action || payload.chosen_action || payload.action || payload.next_agent_id || null,
    why: payload.reasoning?.why || payload.why || payload.reason || null,
    alternative: payload.reasoning?.alternative || payload.alternative || null,
  };
}

function buildLaneSummary(event = null) {
  const payload = event?.payload || {};
  return {
    event: event?.event || null,
    lane: payload.chosen_lane || payload.capability_lane || null,
    action: payload.chosen_action || payload.selected_action || payload.action || null,
    why: payload.fallback_reason || payload.lane_reason || null,
  };
}

function buildFinalSummary(snapshot = {}) {
  const request = snapshot?.request || null;
  const event = snapshot?.final_result?.event || null;
  const payload = event?.payload || {};
  return {
    status_code: request?.status_code ?? payload.status_code ?? null,
    ok: request?.ok ?? payload.ok ?? null,
    error: request?.error_code || payload.error || null,
    error_message: request?.error_message || payload.error_message || null,
    event: event?.event || null,
  };
}

function isTimelineEvent(event = {}) {
  const payload = event?.payload || {};
  return event?.event === "request_input"
    || event?.event === "request_started"
    || event?.event === "request_finished"
    || event?.event === "route_started"
    || event?.event === "route_succeeded"
    || event?.event === "route_failed"
    || event?.event === "lane_resolved"
    || event?.event === "lane_selected"
    || event?.event === "lane_execution_planned"
    || event?.event === "lane_execution_result"
    || event?.event === "planner_tool_select"
    || event?.event === "planner_end_to_end"
    || event?.event === "executive_orchestrator_decision"
    || event?.event === "action_dispatch"
    || event?.event === "action_result"
    || /(?:started|completed|failed|succeeded|stopped)$/i.test(String(event?.event || ""))
    || payload?.ok === false
    || cleanText(payload?.error);
}

function buildTimelineDetails(event = {}) {
  const payload = event?.payload || {};
  const lines = [];

  if (event.event === "request_input") {
    pushDetail(lines, "input", payload.request_input);
    return lines;
  }

  pushDetail(lines, "route", payload.route);
  pushDetail(lines, "lane", payload.chosen_lane || payload.capability_lane);
  pushDetail(lines, "action", payload.chosen_action || payload.selected_action || payload.action);
  pushDetail(lines, "next_agent_id", payload.next_agent_id);
  pushDetail(lines, "ok", payload.ok);
  pushDetail(lines, "status_code", payload.status_code);
  pushDetail(lines, "error", payload.error);
  pushDetail(lines, "why", payload.reasoning?.why || payload.why || payload.reason);
  pushDetail(lines, "duration_ms", payload.duration_ms);
  return lines;
}

function buildTimeline(events = []) {
  const timelineEvents = events.filter(isTimelineEvent);
  return timelineEvents.map((event, index) => ({
    step: index + 1,
    event,
    details: buildTimelineDetails(event),
  }));
}

function formatFailurePoint(failurePoint, timeline) {
  if (!failurePoint) {
    return ["Failure Point", "  none"];
  }

  const matchedStep = timeline.find((entry) => (
    failurePoint.id != null
      ? entry.event.id === failurePoint.id
      : entry.event.event === failurePoint.event && entry.event.component === failurePoint.component
  ));
  const payload = failurePoint.payload || {};
  const lines = ["Failure Point"];
  pushDetail(lines, "step", matchedStep?.step ?? null);
  pushDetail(lines, "layer", failurePoint.component || null);
  pushDetail(lines, "event", failurePoint.event || null);
  pushDetail(lines, "error", payload.error || payload.error_code || null);
  pushDetail(lines, "message", payload.error_message || payload.message || null);
  pushDetail(lines, "status_code", payload.status_code || null);
  return lines;
}

function renderSection(title, lines = []) {
  return [title, ...lines].join("\n");
}

const traceId = cleanText(process.argv[2] || "");

if (!traceId) {
  printUsage();
  process.exitCode = 1;
} else {
  const snapshot = getTraceDebugSnapshot(traceId);

  if (!snapshot) {
    console.error(`Trace not found: ${traceId}`);
    process.exitCode = 1;
  } else {
    const planner = buildPlannerSummary(snapshot.planner_decision);
    const lane = buildLaneSummary(snapshot.lane_action);
    const finalResult = buildFinalSummary(snapshot);
    const timeline = buildTimeline(snapshot.events || []);
    const output = [
      renderSection("Trace", [
        `  trace_id: ${snapshot.trace_id}`,
        `  request: ${snapshot.request?.method || "-"} ${snapshot.request?.pathname || "-"}`,
        `  route: ${snapshot.request?.route_name || snapshot.final_result?.event?.payload?.route || "-"}`,
        `  status_code: ${finalResult.status_code ?? "-"}`,
        `  ok: ${finalResult.ok == null ? "-" : String(finalResult.ok)}`,
        `  duration_ms: ${snapshot.request?.duration_ms ?? "-"}`,
      ]),
      renderSection("Request Input", [
        `${toPrintableJson(snapshot.request_input?.payload?.request_input ?? null)}`,
      ]),
      renderSection("Planner Decision", [
        `  event: ${planner.event || "-"}`,
        `  action: ${planner.action || "-"}`,
        `  why: ${planner.why || "-"}`,
        `  alternative: ${compactValue(planner.alternative) || "-"}`,
      ]),
      renderSection("Lane / Action", [
        `  event: ${lane.event || "-"}`,
        `  lane: ${lane.lane || "-"}`,
        `  action: ${lane.action || "-"}`,
        `  why: ${lane.why || "-"}`,
      ]),
      renderSection("Final Result", [
        `  event: ${finalResult.event || "-"}`,
        `  status_code: ${finalResult.status_code ?? "-"}`,
        `  ok: ${finalResult.ok == null ? "-" : String(finalResult.ok)}`,
        `  error: ${finalResult.error || "-"}`,
        `  error_message: ${finalResult.error_message || "-"}`,
      ]),
      renderSection("Timeline", timeline.flatMap((entry) => [
        `Step ${entry.step} | ${entry.event.component || "-"} | ${entry.event.event || "-"}`,
        ...entry.details,
      ])),
      formatFailurePoint(snapshot.failure_point, timeline).join("\n"),
    ].join("\n\n");

    console.log(output);
  }
}

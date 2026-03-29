import { cleanText } from "./message-intent-utils.mjs";
import { createRequestId } from "./runtime-observability.mjs";
import { buildPlannerVisibleTelemetryEvent } from "./planner-visible-live-telemetry-spec.mjs";

const DEFAULT_PLANNER_VISIBLE_TELEMETRY_BUFFER_SIZE = 200;
const PLANNER_VISIBLE_TELEMETRY_CONTEXT = Symbol.for("lobster.planner_visible_live_telemetry");

const plannerVisibleTelemetryCollector = {
  maxEvents: DEFAULT_PLANNER_VISIBLE_TELEMETRY_BUFFER_SIZE,
  events: [],
};

function normalizeStringList(items = []) {
  if (!Array.isArray(items)) {
    return [];
  }
  return Array.from(new Set(items.map((item) => cleanText(item)).filter(Boolean)));
}

function ensureContextState(context = null) {
  if (!context || typeof context !== "object") {
    return null;
  }
  if (!(context._emitted_events instanceof Set)) {
    Object.defineProperty(context, "_emitted_events", {
      value: new Set(),
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return context;
}

function trimCollector() {
  const overflow = plannerVisibleTelemetryCollector.events.length - plannerVisibleTelemetryCollector.maxEvents;
  if (overflow > 0) {
    plannerVisibleTelemetryCollector.events.splice(0, overflow);
  }
}

export function createPlannerVisibleTelemetryContext({
  request_id = "",
  query_type = null,
  candidate_skills = [],
  selected_skill = null,
  routing_family = null,
  decision_reason = null,
  trace_id = null,
  task_type = null,
  selector_key = null,
  skill_surface_layer = null,
  skill_promotion_stage = null,
  reason_code = null,
} = {}) {
  return ensureContextState({
    request_id: cleanText(request_id) || createRequestId("planner_visible"),
    query_type: cleanText(query_type) || null,
    candidate_skills: normalizeStringList(candidate_skills),
    selected_skill: cleanText(selected_skill) || null,
    routing_family: cleanText(routing_family) || null,
    decision_reason: cleanText(decision_reason) || null,
    trace_id: cleanText(trace_id) || null,
    task_type: cleanText(task_type) || null,
    selector_key: cleanText(selector_key) || null,
    skill_surface_layer: cleanText(skill_surface_layer) || null,
    skill_promotion_stage: cleanText(skill_promotion_stage) || null,
    reason_code: cleanText(reason_code) || null,
  });
}

export function attachPlannerVisibleTelemetryContext(target, context = null) {
  if (!target || typeof target !== "object" || !context || typeof context !== "object") {
    return null;
  }
  const normalizedContext = ensureContextState(context);
  Object.defineProperty(target, PLANNER_VISIBLE_TELEMETRY_CONTEXT, {
    value: normalizedContext,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return normalizedContext;
}

export function getPlannerVisibleTelemetryContext(target) {
  return ensureContextState(target?.[PLANNER_VISIBLE_TELEMETRY_CONTEXT] || null);
}

export function copyPlannerVisibleTelemetryContext(source, target) {
  const context = getPlannerVisibleTelemetryContext(source);
  if (!context) {
    return null;
  }
  return attachPlannerVisibleTelemetryContext(target, context);
}

export function updatePlannerVisibleTelemetryContext(targetOrContext, patch = {}) {
  const context = getPlannerVisibleTelemetryContext(targetOrContext) || ensureContextState(targetOrContext);
  if (!context) {
    return null;
  }
  const normalizedPatch = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};

  if (Object.prototype.hasOwnProperty.call(normalizedPatch, "request_id")) {
    context.request_id = cleanText(normalizedPatch.request_id) || context.request_id || createRequestId("planner_visible");
  }
  if (Object.prototype.hasOwnProperty.call(normalizedPatch, "query_type")) {
    context.query_type = cleanText(normalizedPatch.query_type) || null;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedPatch, "candidate_skills")) {
    context.candidate_skills = normalizeStringList(normalizedPatch.candidate_skills);
  }
  if (Object.prototype.hasOwnProperty.call(normalizedPatch, "selected_skill")) {
    context.selected_skill = cleanText(normalizedPatch.selected_skill) || null;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedPatch, "routing_family")) {
    context.routing_family = cleanText(normalizedPatch.routing_family) || null;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedPatch, "decision_reason")) {
    context.decision_reason = cleanText(normalizedPatch.decision_reason) || null;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedPatch, "trace_id")) {
    context.trace_id = cleanText(normalizedPatch.trace_id) || null;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedPatch, "task_type")) {
    context.task_type = cleanText(normalizedPatch.task_type) || null;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedPatch, "selector_key")) {
    context.selector_key = cleanText(normalizedPatch.selector_key) || null;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedPatch, "skill_surface_layer")) {
    context.skill_surface_layer = cleanText(normalizedPatch.skill_surface_layer) || null;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedPatch, "skill_promotion_stage")) {
    context.skill_promotion_stage = cleanText(normalizedPatch.skill_promotion_stage) || null;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedPatch, "reason_code")) {
    context.reason_code = cleanText(normalizedPatch.reason_code) || null;
  }

  return context;
}

export function hasPlannerVisibleTelemetryEvent(targetOrContext, event = "") {
  const context = getPlannerVisibleTelemetryContext(targetOrContext) || ensureContextState(targetOrContext);
  return Boolean(context?._emitted_events?.has(cleanText(event)));
}

export function emitPlannerVisibleTelemetryEvent({
  event = "",
  context = null,
  extra = {},
} = {}) {
  const normalizedContext = ensureContextState(context);
  if (!normalizedContext) {
    return null;
  }
  const normalizedEvent = cleanText(event);
  if (!normalizedEvent) {
    return null;
  }

  const telemetryEvent = buildPlannerVisibleTelemetryEvent({
    event: normalizedEvent,
    query_type: normalizedContext.query_type,
    selected_skill: normalizedContext.selected_skill,
    candidate_skills: normalizedContext.candidate_skills,
    decision_reason: normalizedContext.decision_reason,
    routing_family: normalizedContext.routing_family,
    request_id: normalizedContext.request_id,
    timestamp: new Date().toISOString(),
    trace_id: normalizedContext.trace_id,
    extra,
  });

  plannerVisibleTelemetryCollector.events.push(telemetryEvent);
  trimCollector();
  normalizedContext._emitted_events.add(normalizedEvent);
  return telemetryEvent;
}

export function listPlannerVisibleTelemetryCollectorEvents({
  request_id = "",
} = {}) {
  const normalizedRequestId = cleanText(request_id);
  return plannerVisibleTelemetryCollector.events
    .filter((event) => !normalizedRequestId || event.request_id === normalizedRequestId)
    .map((event) => ({ ...event }));
}

export function resetPlannerVisibleTelemetryCollector({
  max_events = DEFAULT_PLANNER_VISIBLE_TELEMETRY_BUFFER_SIZE,
} = {}) {
  const normalizedMaxEvents = Number.isInteger(max_events) && max_events > 0
    ? max_events
    : DEFAULT_PLANNER_VISIBLE_TELEMETRY_BUFFER_SIZE;
  plannerVisibleTelemetryCollector.maxEvents = normalizedMaxEvents;
  plannerVisibleTelemetryCollector.events.length = 0;
}

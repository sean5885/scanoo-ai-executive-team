import { cleanText } from "./message-intent-utils.mjs";

export const PLANNER_VISIBLE_TELEMETRY_QUERY_TYPES = Object.freeze([
  "search",
  "detail",
  "mixed",
  "follow-up",
]);

export const PLANNER_VISIBLE_TELEMETRY_REQUIRED_FIELDS = Object.freeze([
  "query_type",
  "selected_skill",
  "candidate_skills",
  "decision_reason",
  "routing_family",
  "request_id",
  "timestamp",
]);

export const PLANNER_VISIBLE_TELEMETRY_ROUTING_FAMILIES = Object.freeze([
  "planner_visible_search",
  "planner_visible_detail",
  "search_company_brain_docs",
  "search_and_detail_doc",
  "routing_no_match",
]);

export const PLANNER_VISIBLE_TELEMETRY_QUERY_TYPE_EXPECTATIONS = Object.freeze({
  search: Object.freeze({
    selected_skill: "search_and_summarize",
    routing_family: "planner_visible_search",
    fallback_routing_family: "search_company_brain_docs",
    ambiguous: false,
  }),
  detail: Object.freeze({
    selected_skill: "document_summarize",
    routing_family: "planner_visible_detail",
    fallback_routing_family: "search_and_detail_doc",
    ambiguous: false,
  }),
  mixed: Object.freeze({
    selected_skill: null,
    routing_family: "search_company_brain_docs",
    fallback_routing_family: "search_company_brain_docs",
    ambiguous: true,
  }),
  "follow-up": Object.freeze({
    selected_skill: null,
    routing_family: "search_and_detail_doc",
    fallback_routing_family: "search_and_detail_doc",
    ambiguous: false,
  }),
});

export const PLANNER_VISIBLE_TELEMETRY_BASELINE = Object.freeze({
  selector_overlap_count: 0,
  per_skill_hit_rate: Object.freeze({
    search_and_summarize: Object.freeze({
      hits: 2,
      total: 2,
      rate: 1,
    }),
    document_summarize: Object.freeze({
      hits: 1,
      total: 1,
      rate: 1,
    }),
  }),
  fail_closed: Object.freeze({
    count: 2,
    total: 4,
    rate: 0.5,
  }),
  ambiguity: Object.freeze({
    count: 1,
    total: 4,
    rate: 0.25,
  }),
  fallback_distribution: Object.freeze({
    search_company_brain_docs: Object.freeze({
      count: 2,
      share: 0.5,
    }),
    search_and_detail_doc: Object.freeze({
      count: 2,
      share: 0.5,
    }),
  }),
  routing_mismatch_rate: 0,
  answer_inconsistency_rate: 0,
});

export const PLANNER_VISIBLE_TELEMETRY_EVENT_CATALOG = Object.freeze({
  planner_visible_skill_selected: Object.freeze({
    stage: "selector",
    description: "A planner_visible skill was selected after deterministic selector and admission passed.",
    required_fields: Object.freeze([
      ...PLANNER_VISIBLE_TELEMETRY_REQUIRED_FIELDS,
      "trace_id",
      "reason_code",
      "selector_key",
      "admission_outcome",
    ]),
    optional_fields: Object.freeze([
      "skill_surface_layer",
      "skill_promotion_stage",
      "task_type",
      "user_intent_hash",
    ]),
  }),
  planner_visible_fail_closed: Object.freeze({
    stage: "admission",
    description: "The planner_visible path was evaluated and deliberately denied fail-closed.",
    required_fields: Object.freeze([
      ...PLANNER_VISIBLE_TELEMETRY_REQUIRED_FIELDS,
      "trace_id",
      "reason_code",
      "fail_closed_stage",
      "admission_outcome",
    ]),
    optional_fields: Object.freeze([
      "rejected_skills",
      "selector_key",
      "ambiguity_detected",
      "task_type",
    ]),
  }),
  planner_visible_ambiguity: Object.freeze({
    stage: "admission",
    description: "The request landed in an ambiguity boundary and could not safely enter planner_visible admission.",
    required_fields: Object.freeze([
      ...PLANNER_VISIBLE_TELEMETRY_REQUIRED_FIELDS,
      "trace_id",
      "reason_code",
      "ambiguity_signals",
      "admission_outcome",
    ]),
    optional_fields: Object.freeze([
      "rejected_skills",
      "selector_key",
      "task_type",
    ]),
  }),
  planner_visible_fallback: Object.freeze({
    stage: "routing",
    description: "A monitored request fell back into the original non-skill routing family.",
    required_fields: Object.freeze([
      ...PLANNER_VISIBLE_TELEMETRY_REQUIRED_FIELDS,
      "trace_id",
      "reason_code",
      "fallback_action",
      "fallback_reason",
    ]),
    optional_fields: Object.freeze([
      "fallback_family_source",
      "task_type",
      "disabled_skill",
    ]),
  }),
  planner_visible_answer_generated: Object.freeze({
    stage: "answer",
    description: "The final user-visible answer was generated after routing and answer-boundary checks.",
    required_fields: Object.freeze([
      ...PLANNER_VISIBLE_TELEMETRY_REQUIRED_FIELDS,
      "trace_id",
      "answer_pipeline_enforced",
      "raw_payload_blocked",
      "answer_contract_ok",
      "answer_consistency_proxy_ok",
    ]),
    optional_fields: Object.freeze([
      "answer_skill_action",
      "source_count",
      "limitation_count",
      "answer_shape_signature",
      "response_status",
    ]),
  }),
});

export const PLANNER_VISIBLE_TELEMETRY_METRIC_DEFINITIONS = Object.freeze({
  per_skill_hit_rate: Object.freeze({
    description: "Per-skill selection hit rate against requests where that skill was a candidate.",
    numerator: "count(planner_visible_skill_selected where selected_skill = skill)",
    denominator: "count(monitored planner_visible requests where candidate_skills contains skill)",
    baseline: PLANNER_VISIBLE_TELEMETRY_BASELINE.per_skill_hit_rate,
  }),
  fail_closed_rate: Object.freeze({
    description: "Rate of monitored requests that ended in a planner_visible fail-closed decision.",
    numerator: "count(planner_visible_fail_closed)",
    denominator: "count(monitored planner_visible requests)",
    baseline: PLANNER_VISIBLE_TELEMETRY_BASELINE.fail_closed,
  }),
  ambiguity_rate: Object.freeze({
    description: "Rate of monitored requests that triggered ambiguity handling.",
    numerator: "count(planner_visible_ambiguity)",
    denominator: "count(monitored planner_visible requests)",
    baseline: PLANNER_VISIBLE_TELEMETRY_BASELINE.ambiguity,
  }),
  fallback_distribution: Object.freeze({
    description: "Distribution of fallback routing families after planner_visible fail-closed or disablement.",
    numerator: "count(planner_visible_fallback grouped by routing_family)",
    denominator: "count(planner_visible_fallback)",
    baseline: PLANNER_VISIBLE_TELEMETRY_BASELINE.fallback_distribution,
  }),
  routing_mismatch_rate: Object.freeze({
    description: "Rate where emitted routing_family differs from the checked expectation for the request query_type or selected skill.",
    numerator: "count(monitored requests where routing_family mismatches PLANNER_VISIBLE_TELEMETRY_QUERY_TYPE_EXPECTATIONS)",
    denominator: "count(monitored planner_visible requests)",
    baseline: PLANNER_VISIBLE_TELEMETRY_BASELINE.routing_mismatch_rate,
  }),
  answer_inconsistency_rate: Object.freeze({
    description: "Proxy rate where the final answer boundary no longer matches selected skill, routing family, or normalized answer invariants.",
    numerator: "count(planner_visible_answer_generated where answer_consistency_proxy_ok = false)",
    denominator: "count(planner_visible_answer_generated)",
    baseline: PLANNER_VISIBLE_TELEMETRY_BASELINE.answer_inconsistency_rate,
  }),
});

export const PLANNER_VISIBLE_TELEMETRY_ALERT_POLICY = Object.freeze({
  selector_overlap_detected: Object.freeze({
    severity: "critical",
    condition: "selector_overlap_count > 0",
    baseline: 0,
    action: "rollback_single_skill_or_global",
  }),
  fail_closed_rate_anomalous: Object.freeze({
    severity: "high",
    baseline_rate: PLANNER_VISIBLE_TELEMETRY_BASELINE.fail_closed.rate,
    delta: 0.1,
    min_sample_size: 30,
    condition: "fail_closed_rate > baseline_rate + delta",
    action: "disable_impacted_skill_or_tighten_admission",
  }),
  ambiguity_rate_spike: Object.freeze({
    severity: "high",
    baseline_rate: PLANNER_VISIBLE_TELEMETRY_BASELINE.ambiguity.rate,
    delta: 0.1,
    min_sample_size: 30,
    condition: "ambiguity_rate > baseline_rate + delta or ambiguity_rate > rolling_7d_baseline + delta",
    action: "tighten_admission",
  }),
  fallback_distribution_anomalous: Object.freeze({
    severity: "high",
    baseline_distribution: PLANNER_VISIBLE_TELEMETRY_BASELINE.fallback_distribution,
    share_delta: 0.2,
    min_sample_size: 30,
    condition: "new fallback routing_family appears or any known family share drifts by more than share_delta",
    action: "investigate_routing_then_disable_or_tighten",
  }),
  answer_mismatch_detected: Object.freeze({
    severity: "critical",
    baseline_rate: 0,
    warn_threshold_count: 1,
    critical_threshold_count: 3,
    critical_window: "1h",
    condition: "answer_inconsistency_rate > 0 or answer mismatch count reaches critical threshold",
    action: "disable_impacted_skill_immediately",
  }),
});

export const PLANNER_VISIBLE_TELEMETRY_ROLLBACK_MODES = Object.freeze({
  single_skill_disable: Object.freeze({
    description: "Disable one planner_visible skill from strict planner catalog exposure while keeping internal skill runtime intact.",
    target_scope: "skill",
    preserves_planner_contract: true,
  }),
  global_planner_visible_disable: Object.freeze({
    description: "Disable all planner_visible catalog exposure and route back to the existing non-skill routing family.",
    target_scope: "family",
    preserves_planner_contract: true,
  }),
  admission_tightening: Object.freeze({
    description: "Keep planner_visible enabled but narrow admission so more traffic fails closed earlier.",
    target_scope: "admission",
    preserves_planner_contract: true,
  }),
});

export const PLANNER_VISIBLE_TELEMETRY_TRACE_STAGES = Object.freeze([
  "query",
  "planner",
  "selector",
  "admission",
  "routing",
  "answer",
]);

function normalizeCandidateSkills(items = []) {
  if (!Array.isArray(items)) {
    return [];
  }
  return Array.from(new Set(items.map((item) => cleanText(item)).filter(Boolean)));
}

function normalizeQueryType(value = "") {
  const normalized = cleanText(value);
  return PLANNER_VISIBLE_TELEMETRY_QUERY_TYPES.includes(normalized)
    ? normalized
    : null;
}

export function listPlannerVisibleTelemetryEvents() {
  return Object.keys(PLANNER_VISIBLE_TELEMETRY_EVENT_CATALOG);
}

export function buildPlannerVisibleTelemetryStubEvent({
  event = "",
  query_type = "",
  selected_skill = null,
  candidate_skills = [],
  decision_reason = "",
  routing_family = "",
  request_id = "",
  timestamp = "",
  trace_id = null,
  extra = {},
} = {}) {
  const normalizedEvent = cleanText(event);
  if (!PLANNER_VISIBLE_TELEMETRY_EVENT_CATALOG[normalizedEvent]) {
    throw new TypeError("unknown_planner_visible_telemetry_event");
  }

  const normalizedQueryType = normalizeQueryType(query_type);
  if (!normalizedQueryType) {
    throw new TypeError("invalid_planner_visible_query_type");
  }

  const normalizedSelectedSkill = cleanText(selected_skill) || null;
  const normalizedCandidateSkills = normalizeCandidateSkills(candidate_skills);
  const candidateSkills = normalizedSelectedSkill && !normalizedCandidateSkills.includes(normalizedSelectedSkill)
    ? [normalizedSelectedSkill, ...normalizedCandidateSkills]
    : normalizedCandidateSkills;

  return Object.freeze({
    event: normalizedEvent,
    query_type: normalizedQueryType,
    selected_skill: normalizedSelectedSkill,
    candidate_skills: candidateSkills,
    decision_reason: cleanText(decision_reason) || null,
    routing_family: cleanText(routing_family) || null,
    request_id: cleanText(request_id) || null,
    timestamp: cleanText(timestamp) || null,
    trace_id: cleanText(trace_id) || null,
    ...(extra && typeof extra === "object" && !Array.isArray(extra) ? extra : {}),
  });
}

export function buildPlannerVisibleTelemetryEvent({
  event = "",
  query_type = "",
  selected_skill = null,
  candidate_skills = [],
  decision_reason = "",
  routing_family = "",
  request_id = "",
  timestamp = "",
  trace_id = null,
  extra = {},
} = {}) {
  const normalizedEvent = cleanText(event);
  const catalogEntry = PLANNER_VISIBLE_TELEMETRY_EVENT_CATALOG[normalizedEvent];
  if (!catalogEntry) {
    throw new TypeError("unknown_planner_visible_telemetry_event");
  }

  const allowedFields = new Set([
    "event",
    ...catalogEntry.required_fields,
    ...catalogEntry.optional_fields,
  ]);
  const normalizedExtra = {};
  const rawExtra = extra && typeof extra === "object" && !Array.isArray(extra) ? extra : {};
  for (const [key, value] of Object.entries(rawExtra)) {
    const normalizedKey = cleanText(key);
    if (!normalizedKey) {
      continue;
    }
    if (!allowedFields.has(normalizedKey)) {
      throw new TypeError(`unknown_planner_visible_telemetry_field:${normalizedKey}`);
    }
    normalizedExtra[normalizedKey] = Array.isArray(value)
      ? Object.freeze(value.map((item) => cleanText(item)).filter(Boolean))
      : value;
  }

  const builtEvent = buildPlannerVisibleTelemetryStubEvent({
    event: normalizedEvent,
    query_type,
    selected_skill,
    candidate_skills,
    decision_reason,
    routing_family,
    request_id,
    timestamp,
    trace_id,
    extra: normalizedExtra,
  });

  for (const field of catalogEntry.required_fields) {
    if (!Object.prototype.hasOwnProperty.call(builtEvent, field)) {
      throw new TypeError(`missing_planner_visible_telemetry_field:${field}`);
    }
  }

  return builtEvent;
}

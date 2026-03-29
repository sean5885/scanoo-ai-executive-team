import { cleanText } from "./message-intent-utils.mjs";
import {
  renderPlannerUserFacingReplyText,
  runPlannerToolFlow,
  selectPlannerTool,
} from "./executive-planner.mjs";
import { getPlannerSkillAction } from "./planner/skill-bridge.mjs";
import { normalizeUserResponse } from "./user-response-normalizer.mjs";

const RAW_PAYLOAD_PATTERN = /skill_bridge|document_summarize|search_and_summarize|side_effects|get_company_brain_doc_detail|search_knowledge_base|read-runtime|authority/i;

const SKILL_SELECTION_FIXTURES = Object.freeze([
  {
    case_id: "internal_only_skill_read",
    user_intent: "幫我整理 launch checklist",
    task_type: "skill_read",
    expected_action: "search_and_summarize",
    expected_selector_key: "skill.search_and_summarize.read",
    expected_surface_layer: "internal_only",
    expected_routing_reason: "selector_search_and_summarize_skill",
  },
  {
    case_id: "planner_visible_document_summary",
    user_intent: "幫我整理這份文件",
    task_type: "document_summary_skill",
    expected_action: "document_summarize",
    expected_selector_key: "skill.document_summarize.read",
    expected_surface_layer: "planner_visible",
    expected_routing_reason: "selector_document_summarize_skill",
  },
]);

const ROUTING_GUARD_FIXTURE = Object.freeze({
  case_id: "existing_doc_search_route",
  user_intent: "找 OKR 文件",
  task_type: "",
  expected_action: "search_company_brain_docs",
  expected_routing_reason: "selector_search_company_brain_docs",
});

export const PLANNER_VISIBLE_SKILL_ROLLBACK_CONDITIONS = Object.freeze([
  {
    code: "selector_drift",
    description: "selector action, selector_key, or planner-visible/internal-only split no longer matches the checked-in deterministic fixtures.",
  },
  {
    code: "answer_bypass",
    description: "a skill-backed reply reaches the user without the answer pipeline boundary log or leaks raw bridge payload into user-visible text.",
  },
  {
    code: "regression_break",
    description: "the document_summarize happy path fails, or the negative probe no longer fail-closes on read-runtime miss.",
  },
  {
    code: "routing_mismatch",
    description: "an existing non-skill routing fixture changes action/routing because of planner-visible skill wiring.",
  },
]);

function createEventLogger() {
  const events = [];

  function record(level, event, payload = {}) {
    events.push({
      level,
      event: cleanText(event) || "log",
      payload: payload && typeof payload === "object" && !Array.isArray(payload)
        ? { ...payload }
        : {},
    });
  }

  return {
    events,
    logger: {
      info(event, payload = {}) {
        record("info", event, payload);
      },
      warn(event, payload = {}) {
        record("warn", event, payload);
      },
      error(event, payload = {}) {
        record("error", event, payload);
      },
      debug(event, payload = {}) {
        record("debug", event, payload);
      },
    },
  };
}

function findLatestEvent(events = [], eventName = "") {
  const normalizedEventName = cleanText(eventName);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (cleanText(events[index]?.event) === normalizedEventName) {
      return events[index];
    }
  }
  return null;
}

function buildDocumentDetailOverride({
  accountId = "acct_planner_visible_obs",
  docId = "doc_planner_visible_obs",
  title = "Planner Visible Observability",
  url = "https://example.com/doc_planner_visible_obs",
  summary = {},
} = {}) {
  return {
    mirror: {
      get_company_brain_doc_detail: {
        success: true,
        data: {
          doc: {
            doc_id: docId,
            title,
            url,
            source: "mirror",
            created_at: "2026-03-20T00:00:00.000Z",
            creator: {
              account_id: accountId,
              open_id: `ou_${docId}`,
            },
          },
          summary,
          learning_state: {
            status: "learned",
            structured_summary: {
              overview: "",
              headings: [],
              highlights: [],
              snippet: "",
              content_length: 0,
            },
            key_concepts: [],
            tags: [],
            notes: "",
            learned_at: null,
            updated_at: null,
          },
        },
        error: null,
      },
    },
  };
}

function normalizeRatio(hitCount = 0, totalCount = 0) {
  if (!Number.isFinite(hitCount) || !Number.isFinite(totalCount) || totalCount <= 0) {
    return 0;
  }
  return Number((hitCount / totalCount).toFixed(4));
}

function buildPlannerEnvelopeFromFlowResult(result = {}) {
  return {
    ok: result?.execution_result?.ok === true,
    action: cleanText(result?.selected_action || "") || null,
    execution_result: result?.execution_result || null,
    trace_id: result?.trace_id || null,
  };
}

function buildSkillSelectionCase(fixture = {}) {
  const { events, logger } = createEventLogger();
  const result = selectPlannerTool({
    userIntent: fixture.user_intent,
    taskType: fixture.task_type,
    logger,
  });
  const event = findLatestEvent(events, "planner_tool_select");
  const selectedEntry = getPlannerSkillAction(result?.selected_action || "");
  const ok = cleanText(result?.selected_action) === cleanText(fixture.expected_action)
    && cleanText(result?.routing_reason) === cleanText(fixture.expected_routing_reason)
    && cleanText(event?.payload?.skill_selector_key) === cleanText(fixture.expected_selector_key)
    && cleanText(selectedEntry?.surface_layer) === cleanText(fixture.expected_surface_layer)
    && event?.payload?.skill_selector_fail_closed !== true;

  return {
    case_id: cleanText(fixture.case_id) || null,
    ok,
    selected_action: cleanText(result?.selected_action) || null,
    routing_reason: cleanText(result?.routing_reason) || null,
    selector_key: cleanText(event?.payload?.skill_selector_key) || null,
    surface_layer: cleanText(selectedEntry?.surface_layer) || null,
    selection_status: cleanText(event?.payload?.skill_selector_status) || null,
    fail_closed: event?.payload?.skill_selector_fail_closed === true,
  };
}

function buildRoutingGuardCase(fixture = {}) {
  const { events, logger } = createEventLogger();
  const result = selectPlannerTool({
    userIntent: fixture.user_intent,
    taskType: fixture.task_type,
    logger,
  });
  const event = findLatestEvent(events, "planner_tool_select");
  const ok = cleanText(result?.selected_action) === cleanText(fixture.expected_action)
    && cleanText(result?.routing_reason) === cleanText(fixture.expected_routing_reason)
    && event?.payload?.skill_selector_attempted !== true;

  return {
    case_id: cleanText(fixture.case_id) || null,
    ok,
    selected_action: cleanText(result?.selected_action) || null,
    routing_reason: cleanText(result?.routing_reason) || null,
    skill_selector_attempted: event?.payload?.skill_selector_attempted === true,
  };
}

async function runDocumentSummarizeSuccessProbe() {
  const { events, logger } = createEventLogger();
  const result = await runPlannerToolFlow({
    userIntent: "幫我整理這份文件",
    taskType: "document_summary_skill",
    payload: {
      account_id: "acct_planner_visible_success",
      doc_id: "doc_planner_visible_success",
      reader_overrides: buildDocumentDetailOverride({
        accountId: "acct_planner_visible_success",
        docId: "doc_planner_visible_success",
        title: "Planner Visible Rollout Note",
        url: "https://example.com/doc_planner_visible_success",
        summary: {
          overview: "這份文件說明 planner-visible skill rollout 的 guard、rollback 與 debug 步驟。",
          headings: ["觀測", "回滾", "Debug SOP"],
          highlights: ["answer pipeline 仍在 user boundary 前方"],
          snippet: "planner-visible skill rollout guard",
          content_length: 640,
        },
      }),
    },
    logger,
  });
  const plannerEnvelope = buildPlannerEnvelopeFromFlowResult(result);
  const userResponse = normalizeUserResponse({
    plannerEnvelope,
    logger,
  });
  const text = renderPlannerUserFacingReplyText(userResponse);
  const toolEvent = findLatestEvent(events, "lobster_tool_execution");
  const boundaryEvent = findLatestEvent(events, "chat_output_boundary");
  const selectionEvent = findLatestEvent(events, "planner_tool_select");
  const ok = cleanText(result?.selected_action) === "document_summarize"
    && result?.execution_result?.ok === true
    && toolEvent?.payload?.skill_surface_layer === "planner_visible"
    && boundaryEvent?.payload?.planner_skill_answer_pipeline_enforced === true
    && boundaryEvent?.payload?.planner_skill_raw_payload_blocked === true
    && !RAW_PAYLOAD_PATTERN.test(text);

  return {
    case_id: "document_summarize_success_probe",
    ok,
    selected_action: cleanText(result?.selected_action) || null,
    routing_reason: cleanText(result?.routing_reason) || null,
    selector_key: cleanText(selectionEvent?.payload?.skill_selector_key) || null,
    tool_surface_layer: cleanText(toolEvent?.payload?.skill_surface_layer) || null,
    answer_pipeline_enforced: boundaryEvent?.payload?.planner_skill_answer_pipeline_enforced === true,
    raw_payload_blocked: boundaryEvent?.payload?.planner_skill_raw_payload_blocked === true,
    raw_payload_exposed: RAW_PAYLOAD_PATTERN.test(text),
    response_text: text,
  };
}

async function runDocumentSummarizeFailClosedProbe() {
  const { events, logger } = createEventLogger();
  const result = await runPlannerToolFlow({
    userIntent: "幫我整理這份文件",
    taskType: "document_summary_skill",
    payload: {
      account_id: "acct_planner_visible_fail_closed",
      doc_id: "doc_planner_visible_missing",
      reader_overrides: {
        mirror: {
          get_company_brain_doc_detail: {
            success: false,
            error: "not_found",
            data: {},
          },
        },
      },
    },
    logger,
  });
  const plannerEnvelope = buildPlannerEnvelopeFromFlowResult(result);
  const userResponse = normalizeUserResponse({
    plannerEnvelope,
    logger,
  });
  const text = renderPlannerUserFacingReplyText(userResponse);
  const toolEvent = findLatestEvent(events, "lobster_tool_execution");
  const boundaryEvent = findLatestEvent(events, "chat_output_boundary");
  const ok = result?.execution_result?.ok === false
    && cleanText(result?.execution_result?.data?.stop_reason) === "fail_closed"
    && toolEvent?.payload?.skill_fail_closed === true
    && !RAW_PAYLOAD_PATTERN.test(text)
    && boundaryEvent?.payload?.planner_skill_raw_payload_blocked === true;

  return {
    case_id: "document_summarize_fail_closed_probe",
    ok,
    selected_action: cleanText(result?.selected_action) || null,
    stop_reason: cleanText(result?.execution_result?.data?.stop_reason) || null,
    tool_fail_closed: toolEvent?.payload?.skill_fail_closed === true,
    raw_payload_exposed: RAW_PAYLOAD_PATTERN.test(text),
    answer_pipeline_enforced: boundaryEvent?.payload?.planner_skill_answer_pipeline_enforced === true,
  };
}

export async function runPlannerVisibleSkillObservabilityCheck() {
  const selectionCases = SKILL_SELECTION_FIXTURES.map((fixture) => buildSkillSelectionCase(fixture));
  const routingGuard = buildRoutingGuardCase(ROUTING_GUARD_FIXTURE);
  const successProbe = await runDocumentSummarizeSuccessProbe();
  const failClosedProbe = await runDocumentSummarizeFailClosedProbe();

  const selectorHits = selectionCases.filter((item) => item.ok).length;
  const selectorTotal = selectionCases.length;
  const selectorFallbackCount = selectionCases.filter((item) => item.fail_closed).length;
  const selectedSkillCases = selectionCases.filter((item) => cleanText(item.selected_action));
  const plannerVisibleCount = selectedSkillCases.filter((item) => item.surface_layer === "planner_visible").length;
  const internalOnlyCount = selectedSkillCases.filter((item) => item.surface_layer === "internal_only").length;

  const observedRollback = {
    selector_drift: selectorHits !== selectorTotal,
    answer_bypass: successProbe.answer_pipeline_enforced !== true
      || successProbe.raw_payload_blocked !== true
      || successProbe.raw_payload_exposed === true
      || failClosedProbe.raw_payload_exposed === true,
    regression_break: successProbe.ok !== true || failClosedProbe.ok !== true,
    routing_mismatch: routingGuard.ok !== true,
  };

  const triggeredConditions = PLANNER_VISIBLE_SKILL_ROLLBACK_CONDITIONS
    .filter((condition) => observedRollback[condition.code] === true)
    .map((condition) => condition.code);

  const report = {
    ok: triggeredConditions.length === 0,
    decision: triggeredConditions.length === 0
      ? "allow_guarded_future_promotion"
      : "rollback_required",
    summary: {
      planner_selected_document_summarize: successProbe.selected_action === "document_summarize",
      selector_key_hit_rate: {
        hits: selectorHits,
        total: selectorTotal,
        ratio: normalizeRatio(selectorHits, selectorTotal),
      },
      fallback_count: selectorFallbackCount,
      fail_closed_count: 0,
      skill_surface_split: {
        planner_visible: plannerVisibleCount,
        internal_only: internalOnlyCount,
        planner_visible_ratio: normalizeRatio(plannerVisibleCount, selectedSkillCases.length),
        internal_only_ratio: normalizeRatio(internalOnlyCount, selectedSkillCases.length),
      },
    },
    safety: {
      answer_pipeline_before_user_response: successProbe.answer_pipeline_enforced === true
        && successProbe.raw_payload_blocked === true,
      raw_payload_exposed: successProbe.raw_payload_exposed === true || failClosedProbe.raw_payload_exposed === true,
      selector_drift_detected: observedRollback.selector_drift,
      routing_unchanged: routingGuard.ok === true,
      fail_closed_guard_verified: failClosedProbe.ok === true,
    },
    rollback: {
      should_rollback: triggeredConditions.length > 0,
      triggered_conditions: triggeredConditions,
      observed: observedRollback,
      conditions: PLANNER_VISIBLE_SKILL_ROLLBACK_CONDITIONS,
    },
    future_expansion: {
      second_planner_visible_skill_allowed: triggeredConditions.length === 0,
      automatic_promotion: false,
      reason: triggeredConditions.length === 0
        ? "Guarded future promotion is allowed only if the next candidate still passes readiness_check, answer-boundary safety, and this observability check."
        : "A rollback trigger fired, so a second planner_visible skill must stay blocked.",
    },
    cases: {
      selection: selectionCases,
      routing_guard: routingGuard,
      success_probe: successProbe,
      fail_closed_probe: failClosedProbe,
    },
  };

  return report;
}

export function renderPlannerVisibleSkillObservabilityReport(report = {}) {
  const summary = report?.summary || {};
  const safety = report?.safety || {};
  const rollback = report?.rollback || {};
  const split = summary?.skill_surface_split || {};
  const hitRate = summary?.selector_key_hit_rate || {};

  return [
    "Planner-Visible Skill Observability",
    `decision: ${cleanText(report?.decision) || "rollback_required"}`,
    `summary: document_summarize_selected=${summary.planner_selected_document_summarize === true} | selector_key_hit_rate=${Number(hitRate.hits || 0)}/${Number(hitRate.total || 0)} (${Number(hitRate.ratio || 0)}) | fallback_count=${Number(summary.fallback_count || 0)} | fail_closed_count=${Number(summary.fail_closed_count || 0)} | planner_visible=${Number(split.planner_visible || 0)} | internal_only=${Number(split.internal_only || 0)}`,
    `safety: answer_pipeline_before_user_response=${safety.answer_pipeline_before_user_response === true} | raw_payload_exposed=${safety.raw_payload_exposed === true} | selector_drift_detected=${safety.selector_drift_detected === true} | routing_unchanged=${safety.routing_unchanged === true} | fail_closed_guard_verified=${safety.fail_closed_guard_verified === true}`,
    `rollback: should_rollback=${rollback.should_rollback === true} | triggered=${Array.isArray(rollback.triggered_conditions) && rollback.triggered_conditions.length > 0 ? rollback.triggered_conditions.join(",") : "none"}`,
    `future: second_planner_visible_skill_allowed=${report?.future_expansion?.second_planner_visible_skill_allowed === true} | automatic_promotion=${report?.future_expansion?.automatic_promotion === true}`,
  ].join("\n");
}

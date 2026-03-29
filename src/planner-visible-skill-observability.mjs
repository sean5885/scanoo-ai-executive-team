import { cleanText } from "./message-intent-utils.mjs";
import {
  listPlannerDecisionCatalogEntries,
  renderPlannerUserFacingReplyText,
  runPlannerToolFlow,
  selectPlannerTool,
  validatePlannerUserInputDecision,
} from "./executive-planner.mjs";
import { getPlannerSkillAction, listPlannerSkillActions } from "./planner/skill-bridge.mjs";
import { normalizeUserResponse } from "./user-response-normalizer.mjs";

const RAW_PAYLOAD_PATTERN = /skill_bridge|document_summarize|search_and_summarize|side_effects|get_company_brain_doc_detail|search_knowledge_base|read-runtime|authority/i;
const PLANNER_VISIBLE_SKILL_ACTIONS = Object.freeze([
  "search_and_summarize",
  "document_summarize",
]);

const SKILL_SELECTION_FIXTURES = Object.freeze([
  {
    case_id: "planner_visible_search_skill_read",
    user_intent: "幫我整理 launch checklist",
    task_type: "skill_read",
    expected_action: "search_and_summarize",
    expected_selector_key: "skill.search_and_summarize.read",
    expected_surface_layer: "planner_visible",
    expected_routing_reason: "selector_search_and_summarize_skill",
  },
  {
    case_id: "planner_visible_search_knowledge_read",
    user_intent: "幫我整理 launch checklist",
    task_type: "knowledge_read_skill",
    expected_action: "search_and_summarize",
    expected_selector_key: "skill.search_and_summarize.read",
    expected_surface_layer: "planner_visible",
    expected_routing_reason: "selector_search_and_summarize_skill",
  },
  {
    case_id: "planner_visible_document_summary",
    user_intent: "幫我整理 launch checklist 文件重點",
    task_type: "document_summary_skill",
    expected_action: "document_summarize",
    expected_selector_key: "skill.document_summarize.read",
    expected_surface_layer: "planner_visible",
    expected_routing_reason: "selector_document_summarize_skill",
  },
]);

const QUERY_TYPE_WATCH_FIXTURES = Object.freeze([
  {
    case_id: "query_type_search_and_summarize",
    query_type: "search_and_summarize",
    text: "幫我搜尋 launch checklist 並整理重點",
    expected_catalog_actions: ["search_and_summarize"],
    expected_rejected_actions: ["document_summarize"],
    expected_fallback_action: "search_company_brain_docs",
    expected_fallback_routing_reason: "selector_search_company_brain_docs",
    expected_fail_closed: false,
    expected_ambiguity: false,
    valid_params: {
      search_and_summarize: {
        account_id: "acct_obs_search",
        q: "launch checklist",
      },
    },
  },
  {
    case_id: "query_type_detail_summary",
    query_type: "detail_summary",
    text: "幫我整理 launch checklist 文件重點",
    expected_catalog_actions: ["document_summarize"],
    expected_rejected_actions: ["search_and_summarize"],
    expected_fallback_action: "search_and_detail_doc",
    expected_fallback_routing_reason: "selector_search_and_detail_doc",
    expected_fail_closed: false,
    expected_ambiguity: false,
    valid_params: {
      document_summarize: {
        account_id: "acct_obs_detail",
        doc_id: "doc_launch_checklist",
      },
    },
  },
  {
    case_id: "query_type_mixed_query",
    query_type: "mixed_query",
    text: "幫我搜尋這份 launch checklist 文件並整理重點",
    expected_catalog_actions: [],
    expected_rejected_actions: ["search_and_summarize", "document_summarize"],
    expected_fallback_action: "search_company_brain_docs",
    expected_fallback_routing_reason: "selector_search_company_brain_docs",
    expected_fail_closed: true,
    expected_ambiguity: true,
    valid_params: {
      search_and_summarize: {
        account_id: "acct_obs_mixed",
        q: "launch checklist",
      },
      document_summarize: {
        account_id: "acct_obs_mixed",
        doc_id: "doc_launch_checklist",
      },
    },
  },
  {
    case_id: "query_type_follow_up_reference",
    query_type: "follow_up_reference",
    text: "這份文件幫我整理重點",
    expected_catalog_actions: [],
    expected_rejected_actions: ["search_and_summarize", "document_summarize"],
    expected_fallback_action: "search_and_detail_doc",
    expected_fallback_routing_reason: "selector_search_and_detail_doc",
    expected_fail_closed: true,
    expected_ambiguity: false,
    valid_params: {
      search_and_summarize: {
        account_id: "acct_obs_follow_up",
        q: "這份文件",
      },
      document_summarize: {
        account_id: "acct_obs_follow_up",
        doc_id: "doc_follow_up",
      },
    },
  },
]);

const ROUTING_GUARD_FIXTURES = Object.freeze([
  {
    case_id: "existing_doc_search_route",
    user_intent: "找 OKR 文件",
    task_type: "",
    expected_action: "search_company_brain_docs",
    expected_routing_reason: "selector_search_company_brain_docs",
  },
  {
    case_id: "existing_detail_summary_route",
    user_intent: "幫我整理 launch checklist 文件重點",
    task_type: "",
    expected_action: "search_and_detail_doc",
    expected_routing_reason: "selector_search_and_detail_doc",
  },
]);

export const PLANNER_VISIBLE_SKILL_ROLLBACK_CONDITIONS = Object.freeze([
  {
    code: "selector_overlap_threshold_exceeded",
    description: "selector key conflicts or overlapping deterministic selector task types exceed the checked-in threshold.",
  },
  {
    code: "fail_closed_rate_anomalous",
    description: "fail-closed cases rise above the checked-in multi-skill baseline for the query-type watch pack.",
  },
  {
    code: "routing_mismatch",
    description: "an existing non-skill routing fixture changes action/routing because of planner-visible skill coexistence.",
  },
  {
    code: "answer_inconsistency",
    description: "answer normalization, raw-payload blocking, or per-skill user-facing reply consistency drifts from the checked-in boundary.",
  },
]);

const PLANNER_VISIBLE_SKILL_ROLLBACK_THRESHOLDS = Object.freeze({
  max_selector_key_conflicts: 0,
  max_selector_task_type_overlap_pairs: 0,
  expected_fail_closed_cases: 2,
  max_fail_closed_cases: 2,
  max_fail_closed_ratio: 0.5,
  max_answer_inconsistencies: 0,
});

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

function buildSearchOverride() {
  return {
    index: {
      search_knowledge_base: {
        success: true,
        data: {
          items: [
            {
              id: "doc_obs_1:0",
              snippet: "Back to [README.md](/Users/seanhan/Documents/Playground/README.md)\n- Ship checklist\n- owner: ops",
              metadata: {
                title: "Noisy Launch Notes",
                url: "https://example.com/noisy-launch-notes",
              },
            },
            {
              id: "doc_obs_2:0",
              snippet: "launch checklist rollout with review gate and rollback watch",
              metadata: {
                title: "Launch Rollout Guardrail",
                url: "https://example.com/launch-rollout-guardrail",
              },
            },
            {
              id: "doc_obs_3:0",
              snippet: "這份筆記整理 launch checklist、owner 與驗收條件。",
              metadata: {
                title: "Launch Checklist Summary",
                url: "https://example.com/launch-checklist-summary",
              },
            },
          ],
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

function buildPlannerVisibleSkillValidation(action = "", params = {}, text = "") {
  const result = validatePlannerUserInputDecision({
    action,
    params,
  }, { text });
  return {
    action: cleanText(action) || null,
    ok: result?.ok === true,
    error: cleanText(result?.error || "") || null,
  };
}

function buildQueryTypeWatchCase(fixture = {}) {
  const monitoredActions = PLANNER_VISIBLE_SKILL_ACTIONS;
  const catalogNames = listPlannerDecisionCatalogEntries({
    text: fixture.text,
  }).map((entry) => cleanText(entry?.name)).filter(Boolean);
  const admittedActions = monitoredActions.filter((action) => catalogNames.includes(action));
  const fallbackResult = selectPlannerTool({
    userIntent: fixture.text,
    taskType: "",
  });
  const validations = monitoredActions.map((action) => buildPlannerVisibleSkillValidation(
    action,
    fixture?.valid_params?.[action] || {},
    fixture.text,
  ));
  const expectedCatalogActions = Array.isArray(fixture.expected_catalog_actions)
    ? fixture.expected_catalog_actions.map((item) => cleanText(item)).filter(Boolean)
    : [];
  const expectedRejectedActions = Array.isArray(fixture.expected_rejected_actions)
    ? fixture.expected_rejected_actions.map((item) => cleanText(item)).filter(Boolean)
    : [];
  const actualRejectedActions = validations.filter((item) => item.ok !== true).map((item) => item.action);
  const expectedAmbiguity = fixture.expected_ambiguity === true;
  const ambiguityTriggered = expectedAmbiguity
    && admittedActions.length === 0
    && validations.every((item) => item.ok !== true);
  const failClosed = admittedActions.length === 0 && validations.some((item) => item.ok !== true);
  const ok = expectedCatalogActions.length === admittedActions.length
    && expectedCatalogActions.every((item) => admittedActions.includes(item))
    && expectedRejectedActions.every((item) => actualRejectedActions.includes(item))
    && cleanText(fallbackResult?.selected_action) === cleanText(fixture.expected_fallback_action)
    && cleanText(fallbackResult?.routing_reason) === cleanText(fixture.expected_fallback_routing_reason)
    && failClosed === (fixture.expected_fail_closed === true)
    && ambiguityTriggered === expectedAmbiguity;

  return {
    case_id: cleanText(fixture.case_id) || null,
    query_type: cleanText(fixture.query_type) || "unknown",
    ok,
    text: cleanText(fixture.text) || null,
    admitted_actions: admittedActions,
    validations,
    fail_closed: failClosed,
    ambiguity_triggered: ambiguityTriggered,
    fallback_action: cleanText(fallbackResult?.selected_action) || null,
    fallback_routing_reason: cleanText(fallbackResult?.routing_reason) || null,
  };
}

function buildSelectorHitRatePerSkill(selectionCases = []) {
  const perSkill = Object.create(null);
  for (const item of Array.isArray(selectionCases) ? selectionCases : []) {
    const skill = cleanText(item?.selected_action || "");
    if (!skill) {
      continue;
    }
    if (!perSkill[skill]) {
      perSkill[skill] = {
        hits: 0,
        total: 0,
      };
    }
    perSkill[skill].total += 1;
    if (item.ok === true) {
      perSkill[skill].hits += 1;
    }
  }

  return Object.fromEntries(
    Object.entries(perSkill).map(([skill, stats]) => [
      skill,
      {
        hits: stats.hits,
        total: stats.total,
        ratio: normalizeRatio(stats.hits, stats.total),
      },
    ]),
  );
}

function buildSelectorOverlapReport() {
  const plannerVisibleSkills = listPlannerSkillActions()
    .filter((entry) => cleanText(entry?.surface_layer) === "planner_visible");
  const selectorKeyConflicts = [];
  const selectorTaskTypeOverlapPairs = [];

  for (let index = 0; index < plannerVisibleSkills.length; index += 1) {
    for (let inner = index + 1; inner < plannerVisibleSkills.length; inner += 1) {
      const left = plannerVisibleSkills[index];
      const right = plannerVisibleSkills[inner];
      if (
        cleanText(left?.selector_key)
        && cleanText(left?.selector_key) === cleanText(right?.selector_key)
      ) {
        selectorKeyConflicts.push({
          left_action: cleanText(left?.action) || null,
          right_action: cleanText(right?.action) || null,
          selector_key: cleanText(left?.selector_key) || null,
        });
      }

      const leftTaskTypes = Array.isArray(left?.selector_task_types)
        ? left.selector_task_types.map((item) => cleanText(item)).filter(Boolean)
        : [];
      const rightTaskTypes = Array.isArray(right?.selector_task_types)
        ? right.selector_task_types.map((item) => cleanText(item)).filter(Boolean)
        : [];
      const overlap = leftTaskTypes.filter((item) => rightTaskTypes.includes(item));
      if (overlap.length > 0) {
        selectorTaskTypeOverlapPairs.push({
          left_action: cleanText(left?.action) || null,
          right_action: cleanText(right?.action) || null,
          task_types: Array.from(new Set(overlap)),
        });
      }
    }
  }

  return {
    thresholds: {
      max_selector_key_conflicts: PLANNER_VISIBLE_SKILL_ROLLBACK_THRESHOLDS.max_selector_key_conflicts,
      max_selector_task_type_overlap_pairs: PLANNER_VISIBLE_SKILL_ROLLBACK_THRESHOLDS.max_selector_task_type_overlap_pairs,
    },
    observed: {
      planner_visible_skill_count: plannerVisibleSkills.length,
      selector_key_conflicts: selectorKeyConflicts,
      selector_task_type_overlap_pairs: selectorTaskTypeOverlapPairs,
    },
    exceeded:
      selectorKeyConflicts.length > PLANNER_VISIBLE_SKILL_ROLLBACK_THRESHOLDS.max_selector_key_conflicts
      || selectorTaskTypeOverlapPairs.length > PLANNER_VISIBLE_SKILL_ROLLBACK_THRESHOLDS.max_selector_task_type_overlap_pairs,
  };
}

function normalizeResponseShape(userResponse = {}) {
  return {
    ok: userResponse?.ok === true,
    answer_present: cleanText(userResponse?.answer || "").length > 0,
    sources_present: Array.isArray(userResponse?.sources),
    limitations_present: Array.isArray(userResponse?.limitations),
  };
}

async function runSearchAndSummarizeSuccessProbe() {
  const { events, logger } = createEventLogger();
  const result = await runPlannerToolFlow({
    userIntent: "幫我搜尋 launch checklist 並整理重點",
    taskType: "skill_read",
    payload: {
      account_id: "acct_search_obs_success",
      q: "launch checklist",
      reader_overrides: buildSearchOverride(),
    },
    logger,
  });
  const plannerEnvelope = buildPlannerEnvelopeFromFlowResult(result);
  const userResponse = normalizeUserResponse({
    plannerEnvelope,
    logger,
  });
  const responseShape = normalizeResponseShape(userResponse);
  const text = renderPlannerUserFacingReplyText(userResponse);
  const toolEvent = findLatestEvent(events, "lobster_tool_execution");
  const boundaryEvent = findLatestEvent(events, "chat_output_boundary");
  const selectionEvent = findLatestEvent(events, "planner_tool_select");
  const ok = cleanText(result?.selected_action) === "search_and_summarize"
    && result?.execution_result?.ok === true
    && toolEvent?.payload?.skill_surface_layer === "planner_visible"
    && boundaryEvent?.payload?.planner_skill_answer_pipeline_enforced === true
    && boundaryEvent?.payload?.planner_skill_raw_payload_blocked === true
    && responseShape.ok === true
    && responseShape.answer_present === true
    && responseShape.sources_present === true
    && responseShape.limitations_present === true
    && !RAW_PAYLOAD_PATTERN.test(text);

  return {
    case_id: "search_and_summarize_success_probe",
    ok,
    selected_action: cleanText(result?.selected_action) || null,
    routing_reason: cleanText(result?.routing_reason) || null,
    selector_key: cleanText(selectionEvent?.payload?.skill_selector_key) || null,
    tool_surface_layer: cleanText(toolEvent?.payload?.skill_surface_layer) || null,
    answer_pipeline_enforced: boundaryEvent?.payload?.planner_skill_answer_pipeline_enforced === true,
    raw_payload_blocked: boundaryEvent?.payload?.planner_skill_raw_payload_blocked === true,
    raw_payload_exposed: RAW_PAYLOAD_PATTERN.test(text),
    normalized_shape: responseShape,
    response_text: text,
  };
}

async function runDocumentSummarizeSuccessProbe() {
  const { events, logger } = createEventLogger();
  const result = await runPlannerToolFlow({
    userIntent: "幫我整理 launch checklist 文件重點",
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
  const responseShape = normalizeResponseShape(userResponse);
  const text = renderPlannerUserFacingReplyText(userResponse);
  const toolEvent = findLatestEvent(events, "lobster_tool_execution");
  const boundaryEvent = findLatestEvent(events, "chat_output_boundary");
  const selectionEvent = findLatestEvent(events, "planner_tool_select");
  const ok = cleanText(result?.selected_action) === "document_summarize"
    && result?.execution_result?.ok === true
    && toolEvent?.payload?.skill_surface_layer === "planner_visible"
    && boundaryEvent?.payload?.planner_skill_answer_pipeline_enforced === true
    && boundaryEvent?.payload?.planner_skill_raw_payload_blocked === true
    && responseShape.ok === true
    && responseShape.answer_present === true
    && responseShape.sources_present === true
    && responseShape.limitations_present === true
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
    normalized_shape: responseShape,
    response_text: text,
  };
}

async function runDocumentSummarizeFailClosedProbe() {
  const { events, logger } = createEventLogger();
  const result = await runPlannerToolFlow({
    userIntent: "幫我整理 launch checklist 文件重點",
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

function buildQueryTypeSummary(queryTypeCases = []) {
  const summary = Object.create(null);
  for (const item of Array.isArray(queryTypeCases) ? queryTypeCases : []) {
    const queryType = cleanText(item?.query_type) || "unknown";
    if (!summary[queryType]) {
      summary[queryType] = {
        total: 0,
        ok: 0,
        fail_closed_count: 0,
        fail_closed_ratio: 0,
        ambiguity_trigger_count: 0,
        planner_visible_hits: 0,
        routing_fallback_distribution: {},
      };
    }
    const bucket = summary[queryType];
    bucket.total += 1;
    if (item?.ok === true) {
      bucket.ok += 1;
    }
    if (item?.fail_closed === true) {
      bucket.fail_closed_count += 1;
    }
    if (item?.ambiguity_triggered === true) {
      bucket.ambiguity_trigger_count += 1;
    }
    bucket.planner_visible_hits += Array.isArray(item?.admitted_actions) ? item.admitted_actions.length : 0;
    const fallbackKey = cleanText(item?.fallback_action) || "routing_no_match";
    bucket.routing_fallback_distribution[fallbackKey] = Number(bucket.routing_fallback_distribution[fallbackKey] || 0) + 1;
  }

  for (const bucket of Object.values(summary)) {
    bucket.fail_closed_ratio = normalizeRatio(bucket.fail_closed_count, bucket.total);
  }

  return summary;
}

function buildRoutingFallbackDistribution(queryTypeCases = []) {
  return queryTypeCases.reduce((accumulator, item) => {
    const key = cleanText(item?.fallback_action) || "routing_no_match";
    accumulator[key] = Number(accumulator[key] || 0) + 1;
    return accumulator;
  }, {});
}

function buildAnswerConsistencySummary(probes = []) {
  const bySkill = Object.create(null);
  let inconsistencies = 0;
  for (const probe of Array.isArray(probes) ? probes : []) {
    const skill = cleanText(probe?.selected_action) || cleanText(probe?.case_id || "");
    const consistent = probe?.answer_pipeline_enforced === true
      && probe?.raw_payload_blocked !== false
      && probe?.raw_payload_exposed !== true
      && (probe?.normalized_shape
        ? probe.normalized_shape.ok === true
          && probe.normalized_shape.answer_present === true
          && probe.normalized_shape.sources_present === true
          && probe.normalized_shape.limitations_present === true
        : true);
    bySkill[skill] = {
      consistent,
      answer_pipeline_enforced: probe?.answer_pipeline_enforced === true,
      raw_payload_blocked: probe?.raw_payload_blocked !== false,
      raw_payload_exposed: probe?.raw_payload_exposed === true,
    };
    if (!consistent) {
      inconsistencies += 1;
    }
  }

  return {
    inconsistency_count: inconsistencies,
    by_skill: bySkill,
  };
}

export async function runPlannerVisibleSkillObservabilityCheck() {
  const selectionCases = SKILL_SELECTION_FIXTURES.map((fixture) => buildSkillSelectionCase(fixture));
  const queryTypeCases = QUERY_TYPE_WATCH_FIXTURES.map((fixture) => buildQueryTypeWatchCase(fixture));
  const routingGuards = ROUTING_GUARD_FIXTURES.map((fixture) => buildRoutingGuardCase(fixture));
  const searchSuccessProbe = await runSearchAndSummarizeSuccessProbe();
  const documentSuccessProbe = await runDocumentSummarizeSuccessProbe();
  const failClosedProbe = await runDocumentSummarizeFailClosedProbe();

  const selectorHits = selectionCases.filter((item) => item.ok).length;
  const selectorTotal = selectionCases.length;
  const selectorFallbackCount = selectionCases.filter((item) => item.fail_closed).length;
  const selectedSkillCases = selectionCases.filter((item) => cleanText(item.selected_action));
  const plannerVisibleCount = selectedSkillCases.filter((item) => item.surface_layer === "planner_visible").length;
  const internalOnlyCount = selectedSkillCases.filter((item) => item.surface_layer === "internal_only").length;
  const selectorHitRatePerSkill = buildSelectorHitRatePerSkill(selectionCases);
  const queryTypeSummary = buildQueryTypeSummary(queryTypeCases);
  const totalFailClosedCount = queryTypeCases.filter((item) => item.fail_closed).length;
  const totalFailClosedRatio = normalizeRatio(totalFailClosedCount, queryTypeCases.length);
  const ambiguityTriggerCount = queryTypeCases.filter((item) => item.ambiguity_triggered).length;
  const routingFallbackDistribution = buildRoutingFallbackDistribution(queryTypeCases);
  const selectorOverlap = buildSelectorOverlapReport();
  const answerConsistency = buildAnswerConsistencySummary([
    searchSuccessProbe,
    documentSuccessProbe,
    {
      selected_action: "document_summarize",
      answer_pipeline_enforced: failClosedProbe.answer_pipeline_enforced,
      raw_payload_blocked: true,
      raw_payload_exposed: failClosedProbe.raw_payload_exposed,
    },
  ]);

  const observedRollback = {
    selector_overlap_threshold_exceeded: selectorOverlap.exceeded,
    fail_closed_rate_anomalous:
      totalFailClosedCount > PLANNER_VISIBLE_SKILL_ROLLBACK_THRESHOLDS.max_fail_closed_cases
      || totalFailClosedRatio > PLANNER_VISIBLE_SKILL_ROLLBACK_THRESHOLDS.max_fail_closed_ratio,
    routing_mismatch: routingGuards.some((item) => item.ok !== true),
    answer_inconsistency:
      answerConsistency.inconsistency_count > PLANNER_VISIBLE_SKILL_ROLLBACK_THRESHOLDS.max_answer_inconsistencies
      || searchSuccessProbe.ok !== true
      || documentSuccessProbe.ok !== true
      || failClosedProbe.ok !== true,
  };

  const triggeredConditions = PLANNER_VISIBLE_SKILL_ROLLBACK_CONDITIONS
    .filter((condition) => observedRollback[condition.code] === true)
    .map((condition) => condition.code);

  const report = {
    ok: triggeredConditions.length === 0,
    decision: triggeredConditions.length === 0
      ? "allow_two_planner_visible_skills"
      : "rollback_required",
    summary: {
      planner_selected_document_summarize: documentSuccessProbe.selected_action === "document_summarize",
      selector_key_hit_rate: {
        hits: selectorHits,
        total: selectorTotal,
        ratio: normalizeRatio(selectorHits, selectorTotal),
      },
      selector_hit_rate_per_skill: selectorHitRatePerSkill,
      fallback_count: selectorFallbackCount,
      fail_closed_count: totalFailClosedCount,
      fail_closed_ratio: totalFailClosedRatio,
      ambiguity_trigger_count: ambiguityTriggerCount,
      routing_fallback_distribution: routingFallbackDistribution,
      skill_surface_split: {
        planner_visible: plannerVisibleCount,
        internal_only: internalOnlyCount,
        planner_visible_ratio: normalizeRatio(plannerVisibleCount, selectedSkillCases.length),
        internal_only_ratio: normalizeRatio(internalOnlyCount, selectedSkillCases.length),
      },
    },
    query_types: queryTypeSummary,
    safety: {
      answer_pipeline_before_user_response:
        searchSuccessProbe.answer_pipeline_enforced === true
        && documentSuccessProbe.answer_pipeline_enforced === true,
      raw_payload_exposed:
        searchSuccessProbe.raw_payload_exposed === true
        || documentSuccessProbe.raw_payload_exposed === true
        || failClosedProbe.raw_payload_exposed === true,
      selector_overlap_detected: selectorOverlap.exceeded,
      routing_unchanged: routingGuards.every((item) => item.ok === true),
      fail_closed_guard_verified: failClosedProbe.ok === true,
    },
    rollback: {
      should_rollback: triggeredConditions.length > 0,
      triggered_conditions: triggeredConditions,
      observed: observedRollback,
      thresholds: PLANNER_VISIBLE_SKILL_ROLLBACK_THRESHOLDS,
      conditions: PLANNER_VISIBLE_SKILL_ROLLBACK_CONDITIONS,
    },
    observability: {
      selector_overlap: selectorOverlap,
      answer_consistency: answerConsistency,
    },
    future_expansion: {
      second_planner_visible_skill_allowed: triggeredConditions.length === 0,
      automatic_promotion: false,
      reason: triggeredConditions.length === 0
        ? "The checked-in watch keeps both planner_visible skills stable only while selector overlap stays at zero, fail-closed remains at the current bounded baseline, routing fallback stays unchanged, and answer normalization remains consistent."
        : "A rollback trigger fired, so two planner_visible skills should not stay enabled together.",
    },
    cases: {
      selection: selectionCases,
      query_type_watch: queryTypeCases,
      routing_guard: routingGuards,
      success_probe: {
        search_and_summarize: searchSuccessProbe,
        document_summarize: documentSuccessProbe,
      },
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
  const perSkill = summary?.selector_hit_rate_per_skill || {};
  const perSkillText = Object.entries(perSkill)
    .map(([skill, stats]) => `${skill}=${Number(stats?.hits || 0)}/${Number(stats?.total || 0)} (${Number(stats?.ratio || 0)})`)
    .join(", ") || "none";
  const fallbackText = Object.entries(summary?.routing_fallback_distribution || {})
    .map(([action, count]) => `${action}:${Number(count || 0)}`)
    .join(", ") || "none";
  const queryTypeText = Object.entries(report?.query_types || {})
    .map(([queryType, stats]) => `${queryType}=fail_closed:${Number(stats?.fail_closed_count || 0)}/${Number(stats?.total || 0)}, ambiguity:${Number(stats?.ambiguity_trigger_count || 0)}`)
    .join(" | ") || "none";

  return [
    "Planner-Visible Multi-Skill Observability",
    `decision: ${cleanText(report?.decision) || "rollback_required"}`,
    `summary: selector_key_hit_rate=${Number(hitRate.hits || 0)}/${Number(hitRate.total || 0)} (${Number(hitRate.ratio || 0)}) | selector_hit_rate_per_skill=${perSkillText} | fail_closed=${Number(summary.fail_closed_count || 0)} (${Number(summary.fail_closed_ratio || 0)}) | ambiguity_trigger_count=${Number(summary.ambiguity_trigger_count || 0)} | planner_visible=${Number(split.planner_visible || 0)} | internal_only=${Number(split.internal_only || 0)}`,
    `routing_fallback_distribution: ${fallbackText}`,
    `query_types: ${queryTypeText}`,
    `safety: answer_pipeline_before_user_response=${safety.answer_pipeline_before_user_response === true} | raw_payload_exposed=${safety.raw_payload_exposed === true} | selector_overlap_detected=${safety.selector_overlap_detected === true} | routing_unchanged=${safety.routing_unchanged === true} | fail_closed_guard_verified=${safety.fail_closed_guard_verified === true}`,
    `rollback: should_rollback=${rollback.should_rollback === true} | triggered=${Array.isArray(rollback.triggered_conditions) && rollback.triggered_conditions.length > 0 ? rollback.triggered_conditions.join(",") : "none"}`,
    `future: second_planner_visible_skill_allowed=${report?.future_expansion?.second_planner_visible_skill_allowed === true} | automatic_promotion=${report?.future_expansion?.automatic_promotion === true}`,
  ].join("\n");
}

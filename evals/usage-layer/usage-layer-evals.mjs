import { routingEvalSet } from "../routing-eval-set.mjs";

const routingEvalIndex = new Map(
  routingEvalSet.map((entry) => [`routing-eval:${entry.id}`, entry]),
);

function inferToolRequired(target = "") {
  return typeof target === "string"
    && (
      target.startsWith("tool:")
      || target.startsWith("workflow:")
      || target.startsWith("preset:")
    );
}

function inferReplyMode({
  expected_lane: expectedLane = "",
  expected_planner_action: expectedPlannerAction = "",
} = {}) {
  if (expectedLane === "doc_editor" && expectedPlannerAction === "comment_rewrite_preview") {
    return "card_preview";
  }
  if (expectedLane === "cloud_doc_workflow" || expectedLane === "meeting_workflow") {
    return "workflow_update";
  }
  if (expectedLane === "executive") {
    return "executive_brief";
  }
  if (expectedPlannerAction === "ROUTING_NO_MATCH") {
    return "fail_soft";
  }
  return "answer_first";
}

function inferSuccessType(expectedReplyMode = "") {
  if (expectedReplyMode === "workflow_update" || expectedReplyMode === "card_preview") {
    return "workflow_progress";
  }
  if (expectedReplyMode === "partial_success") {
    return "partial_success";
  }
  if (expectedReplyMode === "fail_soft") {
    return "fail_soft";
  }
  return "direct_answer";
}

function inferEvalOutcome(expectedSuccessType = "") {
  if (expectedSuccessType === "partial_success") {
    return "partial_success";
  }
  if (expectedSuccessType === "fail_soft") {
    return "fail_closed";
  }
  return "good_answer";
}

function createUsageLayerEval(entry = {}) {
  return Object.freeze({
    id: entry.id,
    user_text: entry.user_text,
    expected_lane: entry.expected_lane,
    expected_planner_action: entry.expected_planner_action,
    expected_agent_or_tool: entry.expected_agent_or_tool,
    tool_required: entry.tool_required === true,
    expected_reply_mode: entry.expected_reply_mode,
    expected_success_type: entry.expected_success_type,
    expected_eval_outcome: entry.expected_eval_outcome,
    should_fail_if_generic: entry.should_fail_if_generic === true,
    ...(entry.expected_owner_surface ? { expected_owner_surface: entry.expected_owner_surface } : {}),
    ...(entry.source_anchor ? { source_anchor: entry.source_anchor } : {}),
    ...(entry.context && typeof entry.context === "object" ? { context: Object.freeze({ ...entry.context }) } : {}),
    ...(entry.scope && typeof entry.scope === "object" ? { scope: Object.freeze({ ...entry.scope }) } : {}),
  });
}

export function createUsageLayerEvalFromRouting({
  id,
  source_anchor: sourceAnchor,
  expected_reply_mode: expectedReplyMode = null,
  expected_success_type: expectedSuccessType = null,
  expected_eval_outcome: expectedEvalOutcome = null,
  should_fail_if_generic: shouldFailIfGeneric = true,
  tool_required: toolRequired = null,
  expected_owner_surface: expectedOwnerSurface = null,
} = {}) {
  const routingEval = routingEvalIndex.get(sourceAnchor);
  if (!routingEval) {
    throw new Error(`unknown routing eval source anchor: ${sourceAnchor}`);
  }

  const resolvedReplyMode = expectedReplyMode || inferReplyMode({
    expected_lane: routingEval.expected.lane,
    expected_planner_action: routingEval.expected.planner_action,
  });
  const resolvedSuccessType = expectedSuccessType || inferSuccessType(resolvedReplyMode);

  return createUsageLayerEval({
    id,
    source_anchor: sourceAnchor,
    user_text: routingEval.text,
    expected_lane: routingEval.expected.lane,
    expected_planner_action: routingEval.expected.planner_action,
    expected_agent_or_tool: routingEval.expected.agent_or_tool,
    tool_required: typeof toolRequired === "boolean"
      ? toolRequired
      : inferToolRequired(routingEval.expected.agent_or_tool),
    expected_reply_mode: resolvedReplyMode,
    expected_success_type: resolvedSuccessType,
    expected_eval_outcome: expectedEvalOutcome || inferEvalOutcome(resolvedSuccessType),
    should_fail_if_generic: shouldFailIfGeneric,
    expected_owner_surface: expectedOwnerSurface,
    context: routingEval.context || null,
    scope: routingEval.scope || null,
  });
}

export function createManualUsageLayerEval(entry = {}) {
  const expectedReplyMode = entry.expected_reply_mode || inferReplyMode(entry);
  const expectedSuccessType = entry.expected_success_type || inferSuccessType(expectedReplyMode);
  return createUsageLayerEval({
    ...entry,
    tool_required: typeof entry.tool_required === "boolean"
      ? entry.tool_required
      : inferToolRequired(entry.expected_agent_or_tool),
    expected_reply_mode: expectedReplyMode,
    expected_success_type: expectedSuccessType,
    expected_eval_outcome: entry.expected_eval_outcome || inferEvalOutcome(expectedSuccessType),
    should_fail_if_generic: entry.should_fail_if_generic !== false,
  });
}

export function createFailClosedUsageLayerEvalFromRouting(entry = {}) {
  return createUsageLayerEvalFromRouting({
    ...entry,
    expected_reply_mode: "fail_soft",
    expected_success_type: "fail_soft",
    expected_eval_outcome: "fail_closed",
  });
}

export const usageLayerEvals = [
  createFailClosedUsageLayerEvalFromRouting({
    id: "entry-001",
    source_anchor: "routing-eval:doc-001",
  }),
  createFailClosedUsageLayerEvalFromRouting({
    id: "entry-002",
    source_anchor: "routing-eval:doc-002",
  }),
  createUsageLayerEvalFromRouting({
    id: "entry-003",
    source_anchor: "routing-eval:runtime-002",
  }),
  createUsageLayerEvalFromRouting({
    id: "entry-004",
    source_anchor: "routing-eval:doc-007",
  }),
  createFailClosedUsageLayerEvalFromRouting({
    id: "entry-005",
    source_anchor: "routing-eval:doc-019",
  }),
  createFailClosedUsageLayerEvalFromRouting({
    id: "entry-006",
    source_anchor: "routing-eval:doc-023a",
  }),
  createUsageLayerEvalFromRouting({
    id: "entry-007",
    source_anchor: "routing-eval:meeting-001",
  }),
  createUsageLayerEvalFromRouting({
    id: "entry-008",
    source_anchor: "routing-eval:mixed-001",
    tool_required: false,
  }),
  createUsageLayerEvalFromRouting({
    id: "entry-009",
    source_anchor: "routing-eval:mixed-006",
    tool_required: false,
  }),
  createUsageLayerEvalFromRouting({
    id: "entry-010",
    source_anchor: "routing-eval:runtime-010",
    should_fail_if_generic: true,
  }),
  createFailClosedUsageLayerEvalFromRouting({
    id: "usage-011",
    source_anchor: "routing-eval:doc-003",
  }),
  createFailClosedUsageLayerEvalFromRouting({
    id: "usage-012",
    source_anchor: "routing-eval:doc-004",
  }),
  createFailClosedUsageLayerEvalFromRouting({
    id: "usage-013",
    source_anchor: "routing-eval:doc-020",
  }),
  createFailClosedUsageLayerEvalFromRouting({
    id: "usage-014",
    source_anchor: "routing-eval:doc-021",
  }),
  createFailClosedUsageLayerEvalFromRouting({
    id: "usage-015",
    source_anchor: "routing-eval:doc-023",
  }),
  createFailClosedUsageLayerEvalFromRouting({
    id: "usage-016",
    source_anchor: "routing-eval:doc-029",
  }),
  createFailClosedUsageLayerEvalFromRouting({
    id: "usage-017",
    source_anchor: "routing-eval:doc-030",
  }),
  createFailClosedUsageLayerEvalFromRouting({
    id: "usage-018",
    source_anchor: "routing-eval:doc-033",
  }),
  createFailClosedUsageLayerEvalFromRouting({
    id: "usage-019",
    source_anchor: "routing-eval:doc-034",
  }),
  createFailClosedUsageLayerEvalFromRouting({
    id: "usage-020",
    source_anchor: "routing-eval:doc-035",
  }),
  createUsageLayerEvalFromRouting({
    id: "usage-021",
    source_anchor: "routing-eval:doc-036",
  }),
  createUsageLayerEvalFromRouting({
    id: "usage-022",
    source_anchor: "routing-eval:doc-037",
  }),
  createFailClosedUsageLayerEvalFromRouting({
    id: "usage-023",
    source_anchor: "routing-eval:doc-040",
  }),
  createFailClosedUsageLayerEvalFromRouting({
    id: "usage-024",
    source_anchor: "routing-eval:doc-041",
  }),
  createFailClosedUsageLayerEvalFromRouting({
    id: "usage-025",
    source_anchor: "routing-eval:doc-042",
  }),
  createUsageLayerEvalFromRouting({
    id: "usage-026",
    source_anchor: "routing-eval:runtime-001",
  }),
  createUsageLayerEvalFromRouting({
    id: "usage-027",
    source_anchor: "routing-eval:runtime-019",
  }),
  createUsageLayerEvalFromRouting({
    id: "usage-028",
    source_anchor: "routing-eval:runtime-022",
  }),
  createUsageLayerEvalFromRouting({
    id: "usage-029",
    source_anchor: "routing-eval:meeting-004",
  }),
  createUsageLayerEvalFromRouting({
    id: "usage-030",
    source_anchor: "routing-eval:meeting-006",
  }),
  createUsageLayerEvalFromRouting({
    id: "usage-031",
    source_anchor: "routing-eval:meeting-008",
  }),
  createUsageLayerEvalFromRouting({
    id: "usage-032",
    source_anchor: "routing-eval:meeting-009",
  }),
  createUsageLayerEvalFromRouting({
    id: "usage-033",
    source_anchor: "routing-eval:meeting-010",
  }),
  createUsageLayerEvalFromRouting({
    id: "usage-034",
    source_anchor: "routing-eval:meeting-011",
  }),
  createUsageLayerEvalFromRouting({
    id: "usage-035",
    source_anchor: "routing-eval:mixed-003",
    tool_required: false,
  }),
  createUsageLayerEvalFromRouting({
    id: "usage-036",
    source_anchor: "routing-eval:mixed-004",
    tool_required: false,
  }),
  createUsageLayerEvalFromRouting({
    id: "usage-037",
    source_anchor: "routing-eval:mixed-005",
    tool_required: false,
  }),
  createUsageLayerEvalFromRouting({
    id: "usage-038",
    source_anchor: "routing-eval:mixed-007",
    tool_required: false,
  }),
  createUsageLayerEvalFromRouting({
    id: "usage-039",
    source_anchor: "routing-eval:mixed-008",
    tool_required: false,
  }),
  createFailClosedUsageLayerEvalFromRouting({
    id: "usage-040",
    source_anchor: "routing-eval:mixed-011",
  }),
  createFailClosedUsageLayerEvalFromRouting({
    id: "usage-041",
    source_anchor: "routing-eval:mixed-012",
  }),
  createManualUsageLayerEval({
    id: "usage-042",
    source_anchor: "full-flow:mixed-copy-image-send",
    user_text: "幫我寫新品上線的 FB 貼文、做一張圖片並發送出去",
    expected_lane: "personal_assistant",
    expected_planner_action: "general_assistant_action",
    expected_agent_or_tool: "reply:default",
    tool_required: false,
    expected_reply_mode: "partial_success",
  }),
  createManualUsageLayerEval({
    id: "usage-043",
    source_anchor: "normalizer:mixed-email-banner-send",
    user_text: "幫我寫招募 email、做一張 banner 再寄給客戶",
    expected_lane: "personal_assistant",
    expected_planner_action: "general_assistant_action",
    expected_agent_or_tool: "reply:default",
    tool_required: false,
    expected_reply_mode: "partial_success",
  }),
  createManualUsageLayerEval({
    id: "usage-044",
    source_anchor: "normalizer:mixed-product-email-banner",
    user_text: "幫我寫產品發表 email、做一張 banner 給客戶",
    expected_lane: "personal_assistant",
    expected_planner_action: "general_assistant_action",
    expected_agent_or_tool: "reply:default",
    tool_required: false,
    expected_reply_mode: "partial_success",
  }),
  createManualUsageLayerEval({
    id: "usage-045",
    source_anchor: "normalizer:mixed-reply-send-group",
    user_text: "幫我寫一段回覆草稿並直接寄給群組",
    expected_lane: "personal_assistant",
    expected_planner_action: "general_assistant_action",
    expected_agent_or_tool: "reply:default",
    tool_required: false,
    expected_reply_mode: "partial_success",
  }),
  createManualUsageLayerEval({
    id: "usage-046",
    source_anchor: "normalizer:mixed-copy-poster-publish",
    user_text: "幫我寫新品公告文案、做一張海報再發布出去",
    expected_lane: "personal_assistant",
    expected_planner_action: "general_assistant_action",
    expected_agent_or_tool: "reply:default",
    tool_required: false,
    expected_reply_mode: "partial_success",
  }),
  createUsageLayerEvalFromRouting({
    id: "usage-047",
    source_anchor: "routing-eval:doc-038",
    should_fail_if_generic: true,
  }),
  createUsageLayerEvalFromRouting({
    id: "usage-048",
    source_anchor: "routing-eval:doc-039",
    should_fail_if_generic: true,
  }),
  createManualUsageLayerEval({
    id: "usage-049",
    source_anchor: "full-flow:image-send-unavailable",
    user_text: "幫我做一張圖片並直接發送給客戶",
    expected_lane: "personal_assistant",
    expected_planner_action: "general_assistant_action",
    expected_agent_or_tool: "reply:default",
    tool_required: false,
    expected_reply_mode: "fail_soft",
  }),
  createManualUsageLayerEval({
    id: "usage-050",
    source_anchor: "normalizer:image-banner-send-only",
    user_text: "幫我做一張 banner 並直接寄給客戶",
    expected_lane: "personal_assistant",
    expected_planner_action: "general_assistant_action",
    expected_agent_or_tool: "reply:default",
    tool_required: false,
    expected_reply_mode: "fail_soft",
  }),
];

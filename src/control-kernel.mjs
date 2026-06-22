import { parseRegisteredAgentCommand } from "./agent-registry.mjs";
import {
  CLOUD_DOC_WORKFLOW,
  matchesCloudDocWorkflowScope,
} from "./cloud-doc-organization-workflow.mjs";
import {
  looksLikeExecutiveExit,
  looksLikeExecutiveStart,
} from "./executive-planner.mjs";
import { cleanText } from "./message-intent-utils.mjs";

const PERSONAL_DEICTIC_REVIEW_FOLLOW_UP_PATTERN = /(這個|这个|這段|这段|這份|这份|上面|前面|剛剛|刚刚|上一段|上一條|上一条|上一則|上一则|上述|這裡|这里|這版|这版|延續|延续|接著|接着|繼續|继续)/i;
const PERSONAL_DEICTIC_REVIEW_ACTION_PATTERN = /(有沒有問題|有没有问题|對嗎|对吗|哪裡不對|哪里不对|哪裡要改|哪里要改|幫我看|帮我看|幫我改|帮我改|壓力測試|压力测试|挑問題|挑问题|風險|风险|還缺什麼|还缺什么|主要講的是什麼|主要讲的是什么|重點是什麼|重点是什么|有什麼需要修改的地方|有什么需要修改的地方|怎麼修改|怎么修改|告訴我這是什麼|告诉我这是什么)/i;

function looksLikePersonalDeicticReviewFollowUp(text = "") {
  const normalized = cleanText(text);
  if (!normalized) {
    return false;
  }
  return PERSONAL_DEICTIC_REVIEW_FOLLOW_UP_PATTERN.test(normalized)
    && PERSONAL_DEICTIC_REVIEW_ACTION_PATTERN.test(normalized);
}

function preferActiveExecutiveTask({
  text = "",
  activeTask = null,
  lane = "",
  wantsCloudOrganizationFollowUp = false,
} = {}) {
  if (!activeTask?.id || activeTask?.status !== "active") {
    return false;
  }
  const workflow = cleanText(activeTask.workflow);
  if (workflow === "meeting") {
    return true;
  }
  if (workflow !== "executive") {
    return false;
  }
  if (lane === "personal-assistant" && looksLikePersonalDeicticReviewFollowUp(text)) {
    return false;
  }
  if (wantsCloudOrganizationFollowUp && lane === "personal-assistant") {
    return true;
  }
  return true;
}

function buildDecision({
  decision = "lane_default",
  matchedTaskId = null,
  precedenceSource = "lane_default",
  routingReason = "",
  guard = {},
  finalOwner = "personal-assistant",
} = {}) {
  return {
    decision,
    matched_task_id: cleanText(matchedTaskId) || null,
    precedence_source: cleanText(precedenceSource) || "lane_default",
    routing_reason: cleanText(routingReason) || null,
    guard: {
      active_task_present: guard.active_task_present === true,
      explicit_executive_intent: guard.explicit_executive_intent === true,
      same_session: guard.same_session === true,
      same_workflow: guard.same_workflow === true,
      same_scope_required: guard.same_scope_required === true,
      same_scope: typeof guard.same_scope === "boolean" ? guard.same_scope : null,
      wants_cloud_doc_follow_up: guard.wants_cloud_doc_follow_up === true,
      executive_fallback_eligible: guard.executive_fallback_eligible === true,
    },
    final_owner: cleanText(finalOwner) || "personal-assistant",
  };
}

export function decideIntent({
  text = "",
  lane = "personal-assistant",
  activeTask = null,
  wantsCloudOrganizationFollowUp = false,
  cloudDocScopeKey = "",
} = {}) {
  const normalizedLane = cleanText(lane) || "personal-assistant";
  const normalizedText = cleanText(text);
  const workflow = cleanText(activeTask?.workflow);
  const explicitExecutiveIntent = Boolean(
    normalizedText && (
      looksLikeExecutiveExit(normalizedText)
      || looksLikeExecutiveStart(normalizedText)
      || parseRegisteredAgentCommand(normalizedText)
    )
  );
  const sameSession = Boolean(activeTask?.id);
  const cloudDocSameScope = matchesCloudDocWorkflowScope(activeTask, cloudDocScopeKey);
  const executiveFallbackEligible = preferActiveExecutiveTask({
    text: normalizedText,
    activeTask,
    lane: normalizedLane,
    wantsCloudOrganizationFollowUp,
  });

  const baseGuard = {
    active_task_present: sameSession,
    explicit_executive_intent: explicitExecutiveIntent,
    same_session: sameSession,
    wants_cloud_doc_follow_up: wantsCloudOrganizationFollowUp,
    executive_fallback_eligible: executiveFallbackEligible,
  };

  if (explicitExecutiveIntent) {
    return buildDecision({
      decision: "explicit_executive_intent",
      matchedTaskId: activeTask?.id,
      precedenceSource: "explicit_intent",
      routingReason: "explicit executive start/exit or registered-agent slash command takes control.",
      guard: {
        ...baseGuard,
        same_workflow: workflow === "executive",
        same_scope_required: false,
        same_scope: null,
      },
      finalOwner: "executive",
    });
  }

  if (workflow === CLOUD_DOC_WORKFLOW && cloudDocSameScope) {
    return buildDecision({
      decision: "continue_active_workflow",
      matchedTaskId: activeTask?.id,
      precedenceSource: "same_session_same_workflow_same_scope",
      routingReason: "active cloud-doc follow-up stays on the original workflow only when scope_key still matches.",
      guard: {
        ...baseGuard,
        same_workflow: true,
        same_scope_required: true,
        same_scope: true,
      },
      finalOwner: "personal-assistant",
    });
  }

  if (workflow === "doc_rewrite") {
    return buildDecision({
      decision: "continue_active_workflow",
      matchedTaskId: activeTask?.id,
      precedenceSource: "same_session_same_workflow",
      routingReason: "active doc-rewrite follow-up keeps the doc-editor owner in the same session.",
      guard: {
        ...baseGuard,
        same_workflow: true,
        same_scope_required: false,
        same_scope: null,
      },
      finalOwner: "doc-editor",
    });
  }

  if (workflow === "executive" && executiveFallbackEligible) {
    return buildDecision({
      decision: "continue_active_workflow",
      matchedTaskId: activeTask?.id,
      precedenceSource: "same_session_same_workflow",
      routingReason: "active executive task retains routing ownership for same-session follow-up.",
      guard: {
        ...baseGuard,
        same_workflow: true,
        same_scope_required: false,
        same_scope: null,
      },
      finalOwner: "executive",
    });
  }

  if (normalizedLane === "personal-assistant" && wantsCloudOrganizationFollowUp) {
    return buildDecision({
      decision: "lane_guard",
      matchedTaskId: null,
      precedenceSource: "lane_intent_guard",
      routingReason: "cloud-doc organization intent stays on the personal lane follow-up path.",
      guard: {
        ...baseGuard,
        same_workflow: workflow === CLOUD_DOC_WORKFLOW,
        same_scope_required: workflow === CLOUD_DOC_WORKFLOW,
        same_scope: workflow === CLOUD_DOC_WORKFLOW ? cloudDocSameScope : null,
      },
      finalOwner: "personal-assistant",
    });
  }

  return buildDecision({
    decision: "lane_default",
    matchedTaskId: null,
    precedenceSource: "lane_default",
    routingReason: executiveFallbackEligible
      ? "no higher-precedence workflow matched, so routing falls back to the current capability lane instead of preemptively overriding with executive."
      : "no active workflow follow-up matched, so routing stays on the current capability lane.",
    guard: {
      ...baseGuard,
      same_workflow: false,
      same_scope_required: workflow === CLOUD_DOC_WORKFLOW,
      same_scope: workflow === CLOUD_DOC_WORKFLOW ? cloudDocSameScope : null,
    },
    finalOwner: normalizedLane,
  });
}

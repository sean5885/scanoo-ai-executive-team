import { cleanText } from "./message-intent-utils.mjs";

const CONTINUATION_REASON_PATTERNS = [
  /^working_memory_/i,
  /^decision_engine_promotion_(retry|reroute|ask_user)/i,
];

const TOPIC_SWITCH_PATTERN = /(換個題目|换个题目|換題|换题|改問|改问|另一題|另一题|new topic|different question)/i;
const SHORT_FOLLOW_UP_PATTERN = /^(繼續|继续|接著|接着|下一步|再來|再来|好|好的|ok|okay|retry|重試|重试|第一份|第一個|第一个|第二份|第二個|第二个|這個|这个|就這個|就这个|選這個|选这个)$/i;
const ASK_USER_COPY_PATTERN = /(請|请).{0,8}(補|提供|確認|确认|說|说)|please\s+(share|provide|confirm)|(?:補|提供|confirm).{0,10}(資訊|信息|資料|资料|detail)/i;
const CONTINUITY_COPY_PATTERN = /(接著|接着|延續|延续|上一輪|上一轮|剛剛|刚刚|繼續|继续|改由|reroute|retry)/i;

export const USAGE_LAYER_ISSUE_CODES = Object.freeze([
  "mistaken_new_task",
  "missed_continuation",
  "redundant_slot_ask",
  "unnecessary_owner_switch",
  "reroute_without_user_visible_context",
  "retry_without_contextual_response",
  "slot_fill_not_resumed",
  "over_reset_response",
]);

function normalizeList(value = []) {
  return Array.isArray(value)
    ? value.map((item) => cleanText(item)).filter(Boolean)
    : [];
}

function normalizeTextForSimilarity(value = "") {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectSimilarityTokens(input = "") {
  const normalized = normalizeTextForSimilarity(input);
  if (!normalized) {
    return [];
  }
  return Array.from(new Set(normalized.split(" ").map((token) => cleanText(token)).filter((token) => token.length >= 2)));
}

function hasAnyMissingSlots(slotState = [], unresolvedSlots = []) {
  const unresolved = normalizeList(unresolvedSlots);
  if (unresolved.length > 0) {
    return true;
  }
  const normalizedSlotState = Array.isArray(slotState)
    ? slotState
      .map((slot) => ({
        slot_key: cleanText(slot?.slot_key || ""),
        status: cleanText(slot?.status || ""),
      }))
      .filter((slot) => slot.slot_key && slot.status)
    : [];
  return normalizedSlotState.some((slot) => slot.status === "missing" || slot.status === "invalid");
}

function hasContextualContinuityInResponse(userResponse = null) {
  const answer = cleanText(userResponse?.answer || "");
  const sources = normalizeList(userResponse?.sources || []);
  const limitations = normalizeList(userResponse?.limitations || []);
  return CONTINUITY_COPY_PATTERN.test(answer)
    || sources.some((line) => CONTINUITY_COPY_PATTERN.test(line))
    || limitations.some((line) => CONTINUITY_COPY_PATTERN.test(line));
}

function resolveOwnerConsistency({
  observability = null,
  workingMemory = null,
  currentPlanStep = null,
} = {}) {
  const handoff = observability?.agent_handoff && typeof observability.agent_handoff === "object" && !Array.isArray(observability.agent_handoff)
    ? observability.agent_handoff
    : null;
  const fromOwner = cleanText(handoff?.from || observability?.previous_owner_agent || workingMemory?.previous_owner_agent || "") || null;
  const toOwner = cleanText(handoff?.to || observability?.current_owner_agent || workingMemory?.current_owner_agent || "") || null;
  const currentStepOwner = cleanText(currentPlanStep?.owner_agent || "") || null;
  if (!handoff) {
    return {
      feelsConsistent: true,
      unnecessarySwitch: false,
      fromOwner,
      toOwner,
    };
  }
  if (!fromOwner || !toOwner || fromOwner === toOwner) {
    return {
      feelsConsistent: false,
      unnecessarySwitch: true,
      fromOwner,
      toOwner,
    };
  }
  const recoveryAction = cleanText(observability?.recovery_action || "");
  const failureClass = cleanText(observability?.failure_class || "");
  const promotionAction = cleanText(observability?.decision_promotion?.promoted_action || "");
  const switchExpected = recoveryAction === "reroute_owner"
    || failureClass === "capability_gap"
    || promotionAction === "reroute";
  if (!switchExpected) {
    return {
      feelsConsistent: false,
      unnecessarySwitch: true,
      fromOwner,
      toOwner,
    };
  }
  if (currentStepOwner && toOwner !== currentStepOwner && failureClass !== "capability_gap") {
    return {
      feelsConsistent: false,
      unnecessarySwitch: true,
      fromOwner,
      toOwner,
    };
  }
  return {
    feelsConsistent: true,
    unnecessarySwitch: false,
    fromOwner,
    toOwner,
  };
}

function deriveContinuationSignal({
  requestText = "",
  taskType = "",
  workingMemory = null,
  unresolvedSlots = [],
  currentPlanStep = null,
  semantics = null,
  routingReason = "",
  selectedAction = "",
  observability = null,
  candidateActions = [],
} = {}) {
  const normalizedText = cleanText(requestText);
  const normalizedTaskType = cleanText(taskType || "");
  const normalizedRoutingReason = cleanText(routingReason);
  const normalizedSelectedAction = cleanText(selectedAction);
  const taskPhase = cleanText(workingMemory?.task_phase || "");
  const taskStatus = cleanText(workingMemory?.task_status || "");
  const unresolved = normalizeList(unresolvedSlots);
  const currentGoal = cleanText(workingMemory?.current_goal || "");
  const nextBestAction = cleanText(workingMemory?.next_best_action || "");
  const currentStepAction = cleanText(currentPlanStep?.intended_action || "");
  const explicitSameTask = semantics?.explicit_same_task === true;
  const resumedFromWaitingUser = observability?.resumed_from_waiting_user === true;
  const resumedFromRetry = observability?.resumed_from_retry === true;
  const topicSwitch = TOPIC_SWITCH_PATTERN.test(normalizedText)
    || Boolean(normalizedTaskType && cleanText(workingMemory?.task_type || "") && normalizedTaskType !== cleanText(workingMemory?.task_type || ""));

  const requestLength = normalizeTextForSimilarity(normalizedText).length;
  const shortInput = requestLength > 0 && requestLength <= 24;
  const contextTokens = collectSimilarityTokens([
    currentGoal,
    currentStepAction,
    nextBestAction,
    ...unresolved,
  ].join(" "));
  const requestTokens = collectSimilarityTokens(normalizedText);
  const overlap = requestTokens.filter((token) => contextTokens.includes(token));
  const highRelated = overlap.length > 0
    || SHORT_FOLLOW_UP_PATTERN.test(normalizedText)
    || (/^(第\s*\d+|第[一二三四五六七八九十])[份个個]?$/i.test(normalizedText));

  const reasonSuggestsContinuation = CONTINUATION_REASON_PATTERNS.some((pattern) => pattern.test(normalizedRoutingReason));
  const hasActiveTask = Boolean(cleanText(workingMemory?.task_id || "") && ["running", "blocked", "failed"].includes(taskStatus || "running"));

  const shouldPreferContinuation = !topicSwitch && (
    explicitSameTask
    || resumedFromWaitingUser
    || resumedFromRetry
    || reasonSuggestsContinuation
    || (taskPhase === "waiting_user" && unresolved.length > 0 && Boolean(normalizedText))
    || (hasActiveTask && shortInput && highRelated)
  );

  const interpretedAsContinuation = Boolean(
    !topicSwitch
    && (
      reasonSuggestsContinuation
      || resumedFromWaitingUser
      || resumedFromRetry
      || (shouldPreferContinuation && Boolean(normalizedSelectedAction || currentStepAction || nextBestAction))
    )
  );

  const interpretedAsNewTask = !interpretedAsContinuation;

  const normalizedCandidates = Array.from(new Set([
    ...normalizeList(candidateActions),
    currentStepAction,
    nextBestAction,
    cleanText(workingMemory?.last_selected_skill || ""),
  ].filter(Boolean)));

  return {
    topicSwitch,
    shortInput,
    highRelated,
    overlap_tokens: overlap,
    shouldPreferContinuation,
    interpretedAsContinuation,
    interpretedAsNewTask,
    continuationCandidates: normalizedCandidates,
    unresolvedSlots: unresolved,
  };
}

function resolveRedundantAsk({
  userResponse = null,
  observability = null,
  workingMemory = null,
  unresolvedSlots = [],
} = {}) {
  const hasMissing = hasAnyMissingSlots(
    workingMemory?.slot_state,
    unresolvedSlots,
  );
  const recoveryAction = cleanText(observability?.recovery_action || "");
  const recommendedAction = cleanText(observability?.recommended_action || observability?.readiness?.recommended_action || "");
  const askLikeAction = recoveryAction === "ask_user" || recommendedAction === "ask_user";
  if (!hasMissing && askLikeAction) {
    return true;
  }
  if (hasMissing) {
    return false;
  }
  const answer = cleanText(userResponse?.answer || "");
  const limitations = normalizeList(userResponse?.limitations || []);
  if (ASK_USER_COPY_PATTERN.test(answer)) {
    return true;
  }
  return limitations.some((line) => ASK_USER_COPY_PATTERN.test(line));
}

function resolveResponseContinuityScore({
  interpretedAsContinuation = false,
  ownerSelectionFeelsConsistent = true,
  redundantQuestionDetected = false,
  hasContextualContinuity = false,
} = {}) {
  let score = 0;
  if (interpretedAsContinuation) {
    score += 1;
  }
  if (ownerSelectionFeelsConsistent) {
    score += 1;
  }
  if (!redundantQuestionDetected) {
    score += 1;
  }
  if (hasContextualContinuity) {
    score += 1;
  }
  if (score >= 3) {
    return "high";
  }
  if (score >= 2) {
    return "medium";
  }
  return "low";
}

function dedupeIssueCodes(issueCodes = []) {
  return Array.from(new Set(
    normalizeList(issueCodes)
      .filter((code) => USAGE_LAYER_ISSUE_CODES.includes(code)),
  ));
}

function buildUsageLayerSummary(diagnostics = null) {
  if (!diagnostics || typeof diagnostics !== "object") {
    return "usage_layer=unavailable";
  }
  return [
    `continuation=${diagnostics.interpreted_as_continuation ? "true" : "false"}`,
    `new_task=${diagnostics.interpreted_as_new_task ? "true" : "false"}`,
    `redundant_ask=${diagnostics.redundant_question_detected ? "true" : "false"}`,
    `owner_consistent=${diagnostics.owner_selection_feels_consistent ? "true" : "false"}`,
    `response_continuity=${diagnostics.response_continuity_score}`,
    `issues=${diagnostics.usage_issue_codes.length > 0 ? diagnostics.usage_issue_codes.join("|") : "none"}`,
  ].join(" ");
}

export function evaluateUsageLayerIntelligencePass(input = {}) {
  const normalizedInput = input && typeof input === "object" && !Array.isArray(input)
    ? input
    : null;
  if (!normalizedInput) {
    const diagnostics = {
      interpreted_as_continuation: false,
      interpreted_as_new_task: true,
      redundant_question_detected: false,
      owner_selection_feels_consistent: true,
      response_continuity_score: "low",
      usage_issue_codes: [],
    };
    return {
      ok: false,
      fail_closed: true,
      diagnostics,
      summary: buildUsageLayerSummary(diagnostics),
      behavior: {
        prefer_continuation: false,
        continuation_action_candidates: [],
      },
    };
  }

  const requestText = cleanText(normalizedInput.requestText || normalizedInput.userIntent || "");
  const workingMemory = normalizedInput.workingMemory && typeof normalizedInput.workingMemory === "object" && !Array.isArray(normalizedInput.workingMemory)
    ? normalizedInput.workingMemory
    : null;
  const observability = normalizedInput.observability && typeof normalizedInput.observability === "object" && !Array.isArray(normalizedInput.observability)
    ? normalizedInput.observability
    : null;
  const userResponse = normalizedInput.userResponse && typeof normalizedInput.userResponse === "object" && !Array.isArray(normalizedInput.userResponse)
    ? normalizedInput.userResponse
    : null;
  const unresolvedSlots = normalizeList(
    normalizedInput.unresolvedSlots
    || observability?.missing_slots
    || workingMemory?.unresolved_slots
    || [],
  );
  const currentPlanStep = normalizedInput.currentPlanStep && typeof normalizedInput.currentPlanStep === "object" && !Array.isArray(normalizedInput.currentPlanStep)
    ? normalizedInput.currentPlanStep
    : null;
  const candidateActions = normalizeList(normalizedInput.candidateActions || []);
  const continuationSignal = deriveContinuationSignal({
    requestText,
    taskType: normalizedInput.taskType || "",
    workingMemory,
    unresolvedSlots,
    currentPlanStep,
    semantics: normalizedInput.semantics || null,
    routingReason: normalizedInput.routingReason || cleanText(observability?.routing_reason || ""),
    selectedAction: normalizedInput.selectedAction || cleanText(normalizedInput?.plannerEnvelope?.action || ""),
    observability,
    candidateActions,
  });

  const ownerConsistency = resolveOwnerConsistency({
    observability,
    workingMemory,
    currentPlanStep,
  });

  const redundantQuestionDetected = resolveRedundantAsk({
    userResponse,
    observability,
    workingMemory,
    unresolvedSlots,
  });

  const hasContextualContinuity = hasContextualContinuityInResponse(userResponse);
  const canJudgeResponseContext = Boolean(userResponse && typeof userResponse === "object" && !Array.isArray(userResponse));

  const issueCodes = [];
  if (continuationSignal.shouldPreferContinuation && continuationSignal.interpretedAsNewTask) {
    issueCodes.push("mistaken_new_task", "missed_continuation");
  }
  if (redundantQuestionDetected) {
    issueCodes.push("redundant_slot_ask");
  }
  if (ownerConsistency.unnecessarySwitch) {
    issueCodes.push("unnecessary_owner_switch");
  }
  const rerouteInProgress = cleanText(observability?.recovery_action || "") === "reroute_owner"
    || cleanText(observability?.decision_promotion?.promoted_action || "") === "reroute";
  const retryInProgress = cleanText(observability?.recovery_action || "") === "retry_same_step"
    || observability?.resumed_from_retry === true;
  const waitingResumeExpected = cleanText(workingMemory?.task_phase || "") === "waiting_user"
    && unresolvedSlots.length === 0;

  if (canJudgeResponseContext && rerouteInProgress && !hasContextualContinuity) {
    issueCodes.push("reroute_without_user_visible_context");
  }
  if (canJudgeResponseContext && retryInProgress && !hasContextualContinuity) {
    issueCodes.push("retry_without_contextual_response");
  }
  if (waitingResumeExpected && !continuationSignal.interpretedAsContinuation) {
    issueCodes.push("slot_fill_not_resumed");
  }

  const responseContinuityScore = resolveResponseContinuityScore({
    interpretedAsContinuation: continuationSignal.interpretedAsContinuation,
    ownerSelectionFeelsConsistent: ownerConsistency.feelsConsistent,
    redundantQuestionDetected,
    hasContextualContinuity,
  });

  if (canJudgeResponseContext && continuationSignal.shouldPreferContinuation && responseContinuityScore === "low") {
    issueCodes.push("over_reset_response");
  }

  const diagnostics = {
    interpreted_as_continuation: continuationSignal.interpretedAsContinuation,
    interpreted_as_new_task: continuationSignal.interpretedAsNewTask,
    redundant_question_detected: redundantQuestionDetected,
    owner_selection_feels_consistent: ownerConsistency.feelsConsistent,
    response_continuity_score: responseContinuityScore,
    usage_issue_codes: dedupeIssueCodes(issueCodes),
  };

  return {
    ok: true,
    fail_closed: false,
    diagnostics,
    summary: buildUsageLayerSummary(diagnostics),
    behavior: {
      prefer_continuation: continuationSignal.shouldPreferContinuation,
      continuation_action_candidates: continuationSignal.continuationCandidates,
      short_follow_up: continuationSignal.shortInput,
      high_related: continuationSignal.highRelated,
      overlap_tokens: continuationSignal.overlap_tokens,
    },
  };
}

export function applyUsageLayerContinuityCopy({
  userResponse = null,
  diagnostics = null,
  observability = null,
} = {}) {
  if (!userResponse || typeof userResponse !== "object" || Array.isArray(userResponse)) {
    return userResponse;
  }
  if (diagnostics?.interpreted_as_continuation !== true) {
    return userResponse;
  }
  const recoveryAction = cleanText(observability?.recovery_action || "");
  const issueCodes = normalizeList(diagnostics?.usage_issue_codes || []);
  const hasResumeContext = observability?.resumed_from_waiting_user === true
    || observability?.resumed_from_retry === true
    || recoveryAction === "reroute_owner"
    || recoveryAction === "retry_same_step"
    || issueCodes.includes("slot_fill_not_resumed")
    || issueCodes.includes("reroute_without_user_visible_context")
    || issueCodes.includes("retry_without_contextual_response");
  if (!hasResumeContext) {
    return userResponse;
  }
  const normalizedSources = normalizeList(userResponse.sources || []);
  const hasContinuitySource = normalizedSources.some((line) => CONTINUITY_COPY_PATTERN.test(line));
  if (hasContinuitySource) {
    return userResponse;
  }

  let continuityLine = "接著上一輪，我先沿著原本路徑繼續處理。";
  if (observability?.resumed_from_waiting_user === true) {
    continuityLine = "接著你剛補的資訊，我已恢復原本那一步繼續處理。";
  } else if (recoveryAction === "reroute_owner") {
    const rerouteTarget = cleanText(observability?.agent_handoff?.to || observability?.reroute_target || "");
    continuityLine = rerouteTarget
      ? `接著上一輪，我已改由 ${rerouteTarget} 這條路徑續處理。`
      : "接著上一輪，我已改由更合適的路徑續處理。";
  } else if (observability?.resumed_from_retry === true || recoveryAction === "retry_same_step") {
    continuityLine = "接著上一輪失敗的步驟，我已在同一路徑重試並繼續處理。";
  }

  return {
    ...userResponse,
    sources: [
      continuityLine,
      ...normalizedSources,
    ],
  };
}

export function extractUsageLayerDiagnostics(passResult = null) {
  if (!passResult || typeof passResult !== "object" || Array.isArray(passResult)) {
    return {
      interpreted_as_continuation: false,
      interpreted_as_new_task: true,
      redundant_question_detected: false,
      owner_selection_feels_consistent: true,
      response_continuity_score: "low",
      usage_issue_codes: [],
    };
  }
  return passResult.diagnostics && typeof passResult.diagnostics === "object" && !Array.isArray(passResult.diagnostics)
    ? passResult.diagnostics
    : {
        interpreted_as_continuation: false,
        interpreted_as_new_task: true,
        redundant_question_detected: false,
        owner_selection_feels_consistent: true,
        response_continuity_score: "low",
        usage_issue_codes: [],
      };
}

import { cleanText } from "./message-intent-utils.mjs";
import {
  hasAnyTrulyMissingRequiredSlot,
  isSlotActuallyMissing,
} from "./truly-missing-slot.mjs";
import { buildRetryContextPack } from "./retry-context-pack.mjs";

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

function normalizeSlotStateEntries(slotState = []) {
  if (!Array.isArray(slotState)) {
    return [];
  }
  return slotState
    .map((slot) => ({
      slot_key: cleanText(slot?.slot_key || ""),
      status: cleanText(slot?.status || ""),
      actually_missing: isSlotActuallyMissing(slot),
    }))
    .filter((slot) => slot.slot_key && slot.status);
}

function deriveSlotCoverage(slotState = [], unresolvedSlots = []) {
  const normalizedSlots = normalizeSlotStateEntries(slotState);
  const unresolved = normalizeList(unresolvedSlots);
  const trulyMissingCheck = hasAnyTrulyMissingRequiredSlot({
    required_slots: unresolved,
    unresolved_slots: unresolved,
    slot_state: slotState,
  });
  const reusableFilledSlotKeys = normalizedSlots
    .filter((slot) => slot.actually_missing !== true)
    .map((slot) => slot.slot_key);
  const filledSlotKeys = new Set(reusableFilledSlotKeys);
  const unresolvedSlotsCovered = trulyMissingCheck.all_required_slots_filled === true;
  const hasStateMissing = normalizedSlots.some((slot) => slot.actually_missing === true);
  const hasUnresolvedGap = trulyMissingCheck.has_any_truly_missing_required_slot === true;
  return {
    has_missing_slots: hasStateMissing || hasUnresolvedGap,
    has_reusable_filled_slot: filledSlotKeys.size > 0,
    unresolved_slots_covered: unresolvedSlotsCovered,
    filled_slot_keys: Array.from(filledSlotKeys),
    unresolved_slots: unresolved,
  };
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
  const currentOwnerFromObservability = cleanText(observability?.current_owner_agent || "");
  const previousOwnerFromObservability = cleanText(observability?.previous_owner_agent || "");
  const currentOwnerFromMemory = cleanText(workingMemory?.current_owner_agent || "");
  const previousOwnerFromMemory = cleanText(workingMemory?.previous_owner_agent || "");
  const effectiveFromOwner = fromOwner
    || previousOwnerFromObservability
    || previousOwnerFromMemory
    || currentOwnerFromMemory
    || null;
  const effectiveToOwner = toOwner
    || currentOwnerFromObservability
    || currentOwnerFromMemory
    || null;
  const currentStepOwner = cleanText(currentPlanStep?.owner_agent || "") || null;
  const hasOwnerSwitch = Boolean(effectiveFromOwner && effectiveToOwner && effectiveFromOwner !== effectiveToOwner);

  if (!hasOwnerSwitch && !handoff) {
    return {
      feelsConsistent: true,
      unnecessarySwitch: false,
      fromOwner: effectiveFromOwner,
      toOwner: effectiveToOwner,
    };
  }

  if (!effectiveFromOwner || !effectiveToOwner || effectiveFromOwner === effectiveToOwner) {
    return {
      feelsConsistent: true,
      unnecessarySwitch: false,
      fromOwner: effectiveFromOwner,
      toOwner: effectiveToOwner,
    };
  }

  const recoveryAction = cleanText(observability?.recovery_action || "");
  const recoveryPolicy = cleanText(observability?.recovery_policy || "");
  const failureClass = cleanText(observability?.failure_class || "");
  const promotionAction = cleanText(observability?.decision_promotion?.promoted_action || "");
  const readinessReasons = normalizeList(observability?.readiness?.blocking_reason_codes || observability?.blocking_reason_codes || []);
  const rerouteReason = cleanText(observability?.reroute_reason || observability?.agent_handoff?.reason || "");
  const explicitOwnerMismatch = failureClass === "owner_mismatch"
    || rerouteReason === "owner_mismatch"
    || readinessReasons.includes("owner_mismatch");
  const explicitCapabilityGap = failureClass === "capability_gap"
    || rerouteReason === "capability_gap";
  const explicitStepOwnerSwitch = Boolean(currentStepOwner && effectiveToOwner === currentStepOwner && effectiveFromOwner !== currentStepOwner);
  const switchExpected = promotionAction === "reroute"
    || recoveryAction === "reroute_owner"
    || recoveryPolicy === "reroute_owner"
    || explicitCapabilityGap
    || explicitOwnerMismatch
    || explicitStepOwnerSwitch;

  if (!switchExpected) {
    return {
      feelsConsistent: false,
      unnecessarySwitch: true,
      fromOwner: effectiveFromOwner,
      toOwner: effectiveToOwner,
    };
  }

  if (currentStepOwner && effectiveToOwner !== currentStepOwner && !explicitCapabilityGap && !explicitOwnerMismatch) {
    return {
      feelsConsistent: false,
      unnecessarySwitch: true,
      fromOwner: effectiveFromOwner,
      toOwner: effectiveToOwner,
    };
  }

  return {
    feelsConsistent: true,
    unnecessarySwitch: false,
    fromOwner: effectiveFromOwner,
    toOwner: effectiveToOwner,
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
  const recoveryAction = cleanText(observability?.recovery_action || "");
  const recoveryPolicy = cleanText(observability?.recovery_policy || "");
  const retryContextForced = taskPhase === "retrying"
    || resumedFromRetry
    || recoveryAction === "retry_same_step"
    || recoveryPolicy === "retry_same_step";
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
    || retryContextForced
    || reasonSuggestsContinuation
    || (taskPhase === "waiting_user" && unresolved.length > 0 && Boolean(normalizedText))
    || (hasActiveTask && shortInput && highRelated)
  );

  const interpretedAsContinuation = Boolean(
    !topicSwitch
    && (
      retryContextForced
      || reasonSuggestsContinuation
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
    retryContextForced,
    continuationCandidates: normalizedCandidates,
    unresolvedSlots: unresolved,
  };
}

function resolveAskSuppression({
  userResponse = null,
  observability = null,
  slotCoverage = null,
} = {}) {
  const recoveryAction = cleanText(observability?.recovery_action || "");
  const recoveryPolicy = cleanText(observability?.recovery_policy || "");
  const recommendedAction = cleanText(observability?.recommended_action || observability?.readiness?.recommended_action || "");
  const promotedAction = cleanText(observability?.decision_promotion?.promoted_action || "");
  const askLikeAction = recoveryAction === "ask_user"
    || recoveryPolicy === "ask_user"
    || recommendedAction === "ask_user"
    || promotedAction === "ask_user";
  const hasMissing = slotCoverage?.has_missing_slots === true;
  const hasReusableFilled = slotCoverage?.has_reusable_filled_slot === true;

  if (askLikeAction && !hasMissing && hasReusableFilled) {
    return {
      redundantQuestionDetected: true,
      slotSuppressedAsk: true,
      askLikeAction: true,
    };
  }

  if (hasMissing) {
    return {
      redundantQuestionDetected: false,
      slotSuppressedAsk: false,
      askLikeAction,
    };
  }

  const answer = cleanText(userResponse?.answer || "");
  const limitations = normalizeList(userResponse?.limitations || []);
  const askCopyDetected = ASK_USER_COPY_PATTERN.test(answer)
    || limitations.some((line) => ASK_USER_COPY_PATTERN.test(line));
  return {
    redundantQuestionDetected: askCopyDetected,
    slotSuppressedAsk: askCopyDetected && hasReusableFilled,
    askLikeAction,
  };
}

function resolveRetryContextApplied({
  retryContextForced = false,
  canJudgeResponseContext = false,
  hasContextualContinuity = false,
} = {}) {
  if (!retryContextForced || !canJudgeResponseContext) {
    return false;
  }
  return hasContextualContinuity;
}

function resolveResponseContinuityScore({
  interpretedAsContinuation = false,
  ownerSelectionFeelsConsistent = true,
  redundantQuestionDetected = false,
  hasContextualContinuity = false,
  retryOrRerouteInProgress = false,
  retryContextApplied = false,
  issueCount = 0,
} = {}) {
  if (issueCount >= 2) {
    return "low";
  }
  if (issueCount >= 1) {
    return "medium";
  }
  const retryRerouteContextOk = !retryOrRerouteInProgress
    || retryContextApplied
    || hasContextualContinuity;
  if (interpretedAsContinuation && ownerSelectionFeelsConsistent && !redundantQuestionDetected && retryRerouteContextOk) {
    return "high";
  }
  if (interpretedAsContinuation || hasContextualContinuity) {
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
    `slot_suppressed_ask=${diagnostics.slot_suppressed_ask ? "true" : "false"}`,
    `retry_context_applied=${diagnostics.retry_context_applied ? "true" : "false"}`,
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
      slot_suppressed_ask: false,
      retry_context_applied: false,
      retry_context_quality: null,
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
        slot_suppressed_ask: false,
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
  const slotCoverage = deriveSlotCoverage(
    workingMemory?.slot_state,
    unresolvedSlots,
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

  const askSuppression = resolveAskSuppression({
    userResponse,
    observability,
    slotCoverage,
  });
  const redundantQuestionDetected = askSuppression.redundantQuestionDetected;
  const slotSuppressedAsk = askSuppression.slotSuppressedAsk || observability?.slot_suppressed_ask === true;

  const hasContextualContinuity = hasContextualContinuityInResponse(userResponse);
  const canJudgeResponseContext = Boolean(userResponse && typeof userResponse === "object" && !Array.isArray(userResponse));
  const retryContextApplied = resolveRetryContextApplied({
    retryContextForced: continuationSignal.retryContextForced,
    canJudgeResponseContext,
    hasContextualContinuity,
  });

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
    || cleanText(observability?.recovery_policy || "") === "reroute_owner"
    || cleanText(observability?.decision_promotion?.promoted_action || "") === "reroute";
  const retryInProgress = continuationSignal.retryContextForced;
  const waitingResumeExpected = cleanText(workingMemory?.task_phase || "") === "waiting_user"
    && !slotCoverage.has_missing_slots;

  if (canJudgeResponseContext && rerouteInProgress && !hasContextualContinuity) {
    issueCodes.push("reroute_without_user_visible_context");
  }
  if (canJudgeResponseContext && retryInProgress && !retryContextApplied) {
    issueCodes.push("retry_without_contextual_response");
  }
  if (waitingResumeExpected && (!continuationSignal.interpretedAsContinuation || askSuppression.askLikeAction)) {
    issueCodes.push("slot_fill_not_resumed");
  }

  const dedupedIssues = dedupeIssueCodes(issueCodes);
  const responseContinuityScore = resolveResponseContinuityScore({
    interpretedAsContinuation: continuationSignal.interpretedAsContinuation,
    ownerSelectionFeelsConsistent: ownerConsistency.feelsConsistent,
    redundantQuestionDetected,
    hasContextualContinuity,
    retryOrRerouteInProgress: retryInProgress || rerouteInProgress,
    retryContextApplied,
    issueCount: dedupedIssues.length,
  });

  if (canJudgeResponseContext && continuationSignal.shouldPreferContinuation && responseContinuityScore === "low") {
    dedupedIssues.push("over_reset_response");
  }

  const retrySlots = {};
  for (const slotEntry of Array.isArray(workingMemory?.slot_state) ? workingMemory.slot_state : []) {
    const slotKey = cleanText(slotEntry?.slot_key || slotEntry?.key || "");
    if (!slotKey) {
      continue;
    }
    const slotFilled = isSlotActuallyMissing(slotEntry) !== true;
    retrySlots[slotKey] = slotFilled ? true : null;
  }
  const retryPack = buildRetryContextPack({
    intent: cleanText(workingMemory?.task_type || normalizedInput.taskType || "") || null,
    slots: retrySlots,
    required_slots: unresolvedSlots,
    waiting_user: cleanText(workingMemory?.task_phase || "") === "waiting_user",
    last_failure: {
      class: cleanText(observability?.failure_class || "") || null,
    },
    last_action: cleanText(
      normalizedInput.selectedAction
      || normalizedInput?.plannerEnvelope?.action
      || currentPlanStep?.intended_action
      || workingMemory?.next_best_action
      || "",
    ),
    user_input_delta: requestText,
  });
  let retryContextQuality = null;
  if (retryPack.degraded_retry) {
    retryContextQuality = "low";
  } else if (retryPack.resume_instead_of_retry) {
    retryContextQuality = "high";
  }

  const diagnostics = {
    interpreted_as_continuation: continuationSignal.interpretedAsContinuation,
    interpreted_as_new_task: continuationSignal.interpretedAsNewTask,
    redundant_question_detected: redundantQuestionDetected,
    owner_selection_feels_consistent: ownerConsistency.feelsConsistent,
    slot_suppressed_ask: slotSuppressedAsk,
    retry_context_applied: retryContextApplied,
    retry_context_quality: retryContextQuality,
    response_continuity_score: responseContinuityScore,
    usage_issue_codes: dedupeIssueCodes(dedupedIssues),
  };

  const continuationActionCandidates = continuationSignal.continuationCandidates;
  const preferredContinuationAction = continuationActionCandidates.find(Boolean) || null;

  return {
    ok: true,
    fail_closed: false,
    diagnostics,
    summary: buildUsageLayerSummary(diagnostics),
    behavior: {
      prefer_continuation: continuationSignal.shouldPreferContinuation,
      continuation_action_candidates: continuationActionCandidates,
      short_follow_up: continuationSignal.shortInput,
      high_related: continuationSignal.highRelated,
      overlap_tokens: continuationSignal.overlap_tokens,
      slot_suppressed_ask: slotSuppressedAsk,
      ask_user_suppressed: slotSuppressedAsk,
      suppression_target_action: slotSuppressedAsk ? preferredContinuationAction : null,
      retry_context_forced: continuationSignal.retryContextForced,
      waiting_user_all_required_slots_filled: waitingResumeExpected,
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

  const fromOwner = cleanText(observability?.agent_handoff?.from || observability?.previous_owner_agent || "");
  const toOwner = cleanText(observability?.agent_handoff?.to || observability?.current_owner_agent || observability?.reroute_target || "");
  const ownerChanged = Boolean(fromOwner && toOwner && fromOwner !== toOwner);

  let continuityLine = "我先沿著上一個步驟接著處理。";
  if (observability?.resumed_from_waiting_user === true) {
    continuityLine = "我接著你剛補的資訊，把原本那一步續上。";
  } else if (recoveryAction === "reroute_owner" && (ownerChanged || toOwner)) {
    continuityLine = toOwner
      ? `這一步我改由 ${toOwner} 處理，接著往下完成。`
      : "這一步我改由更合適的 owner 處理，接著往下完成。";
  } else if (observability?.resumed_from_retry === true || recoveryAction === "retry_same_step") {
    const cueSeed = (cleanText(userResponse?.answer || "").length + normalizeList(userResponse?.limitations || []).length) % 2;
    continuityLine = cueSeed === 0
      ? "我剛剛那一步再幫你確認一下，現在接著處理。"
      : "上一個步驟我再核對了一次，接著往下做。";
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
      slot_suppressed_ask: false,
      retry_context_applied: false,
      retry_context_quality: null,
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
        slot_suppressed_ask: false,
        retry_context_applied: false,
        retry_context_quality: null,
        response_continuity_score: "low",
        usage_issue_codes: [],
      };
}

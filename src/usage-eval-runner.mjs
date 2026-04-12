import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { cleanText } from "./message-intent-utils.mjs";
import {
  applyUsageLayerContinuityCopy,
  evaluateUsageLayerIntelligencePass,
} from "./usage-layer-intelligence-pass.mjs";
import { scoreExecutionOutcome } from "./execution-outcome-scorer.mjs";
import { evaluateAdvisorAlignment } from "./advisor-alignment-evaluator.mjs";
import {
  evaluateDecisionEnginePromotion,
  buildDecisionPromotionAuditRecord,
  applyDecisionPromotionAuditSafety,
  createDecisionPromotionAuditState,
  listDecisionPromotionRollbackDisabledActions,
} from "./decision-engine-promotion.mjs";
import { resolvePromotionControlSurface } from "./promotion-control-surface.mjs";

export const USAGE_EVAL_RUNNER_VERSION = "usage_eval_runner_v2";
export const DEFAULT_USAGE_EVAL_CASE_COUNT_MIN = 30;
export const DEFAULT_USAGE_EVAL_CASE_COUNT_MAX = 50;
export const DEFAULT_USAGE_EVAL_TOP_N = 5;
export const DEFAULT_USAGE_EVAL_FIXTURE_PATH = new URL("../tests/fixtures/usage-eval-cases.json", import.meta.url);

const PROMOTION_ACTIONS = Object.freeze([
  "ask_user",
  "retry",
  "reroute",
  "fail",
]);

const CONTINUITY_SCORES = Object.freeze([
  "high",
  "medium",
  "low",
]);

const ADVISOR_ACTIONS = new Set([
  "proceed",
  "ask_user",
  "retry",
  "reroute",
  "rollback",
  "skip",
  "fail",
]);

const TURN_MODE = Object.freeze({
  START: "start",
  CONTINUATION: "continuation",
  CONTINUATION_MISSED: "continuation_missed",
  SLOT_MISSING: "slot_missing",
  SLOT_FILLED_RESUME: "slot_filled_resume",
  RETRY: "retry",
  REROUTE: "reroute",
  TOPIC_SWITCH: "topic_switch",
  FAIL: "fail",
});

const TOPIC_SWITCH_PATTERN = /(換個題目|换个题目|換題|换题|改問|改问|另一題|另一题|new topic|different question)/i;
const CONTINUATION_PATTERN = /^(繼續|继续|接著|接着|下一步|再來|再来|好|好的|ok|okay|第一份|第二份|這份|这份|這個|这个)$/i;
const RETRY_PATTERN = /(重試|重试|retry|再試|再试|再跑一次)/i;
const REROUTE_PATTERN = /(改由|換人|换人|轉給|转给|reroute|交給別的|交给别的)/i;
const SLOT_FILL_PATTERN = /(補上|补上|提供|給你|给你|編號是|编号是|doc[-_\s]?\d+)/i;
const CONTINUITY_TONE_PATTERN = /(接著|接着|延續|延续|上一輪|上一轮|剛補|刚补|繼續|继续|續上|续上|沿用|改由|重試|重试|retry|reroute)/i;
const LONG_RESET_PATTERN = /(先從頭|先从头|重新開始|重新开始|重頭開始|重头开始|完整重述|完整說明|完整说明|先重述|先說明背景|先说明背景)/i;
const NEW_TASK_OPENING_PATTERN = /^(我先|先|收到|好|好的).{0,20}(新任務|新任务|當作新任務|当作新任务|切到新題目|切到新题目|重新開始|重新开始|第一版答案)/i;
const FIRST_SENTENCE_BACKGROUND_RESET_PATTERN = /^(我先|先).{0,24}(重新|重述|說明|说明|背景|從頭|从头)/i;

function toObject(value = null) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function toArray(value = null) {
  return Array.isArray(value)
    ? value
    : [];
}

function ratio(numerator = 0, denominator = 0, precision = 4) {
  if (!Number.isFinite(Number(denominator)) || Number(denominator) <= 0) {
    return 0;
  }
  return Number((Number(numerator) / Number(denominator)).toFixed(precision));
}

function incrementCounter(counter = {}, key = "") {
  const normalizedKey = cleanText(key);
  if (!normalizedKey) {
    return counter;
  }
  return {
    ...counter,
    [normalizedKey]: Number(counter[normalizedKey] || 0) + 1,
  };
}

function topDistribution(counter = {}, topN = DEFAULT_USAGE_EVAL_TOP_N) {
  return Object.entries(toObject(counter) || {})
    .map(([key, count]) => ({
      key,
      count: Number(count || 0),
    }))
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }
      return left.key.localeCompare(right.key);
    })
    .slice(0, Math.max(1, Number(topN) || DEFAULT_USAGE_EVAL_TOP_N));
}

function normalizeIssueCodes(value = null) {
  const normalized = Array.isArray(value)
    ? value
    : [];
  return Array.from(new Set(
    normalized
      .map((code) => cleanText(code))
      .filter(Boolean),
  ));
}

function normalizeUserResponseForTurn(user_response = null) {
  const normalized = toObject(user_response);
  if (!normalized) {
    return null;
  }
  return {
    answer: cleanText(normalized.answer || ""),
    sources: toArray(normalized.sources).map((line) => cleanText(line)).filter(Boolean),
    limitations: toArray(normalized.limitations).map((line) => cleanText(line)).filter(Boolean),
  };
}

function extractFirstSentence(input = "") {
  const normalized = cleanText(input || "");
  if (!normalized) {
    return "";
  }
  const first = normalized
    .split(/[。！？!?]/)
    .map((part) => cleanText(part))
    .find(Boolean);
  return cleanText(first || "");
}

function slotSnapshotEntryIsValid(slot = null) {
  const normalized = toObject(slot);
  if (!normalized) {
    return false;
  }
  const status = cleanText(normalized.status || "");
  if (status !== "filled") {
    return false;
  }
  const invalid = normalized.invalid === true
    || normalized.is_invalid === true
    || normalized.invalidated === true
    || normalized.is_invalidated === true;
  if (invalid) {
    return false;
  }
  const validityStatus = cleanText(normalized.validity_status || normalized.validity || "");
  if (validityStatus === "invalid" || validityStatus === "invalidated") {
    return false;
  }
  const ttl = cleanText(normalized.ttl || "");
  if (!ttl) {
    return true;
  }
  const ttlDate = Date.parse(ttl);
  return Number.isFinite(ttlDate) && ttlDate > Date.now();
}

function hasValidFilledSlotSnapshot(slot_state_snapshot = null) {
  return toArray(slot_state_snapshot).some((slot) => slotSnapshotEntryIsValid(slot));
}

function responseLooksLikeLongReset(user_response = null) {
  const normalized = normalizeUserResponseForTurn(user_response);
  if (!normalized) {
    return false;
  }
  const answer = cleanText(normalized.answer || "");
  if (!answer) {
    return false;
  }
  if (LONG_RESET_PATTERN.test(answer)) {
    return true;
  }
  const firstSentence = extractFirstSentence(answer);
  return FIRST_SENTENCE_BACKGROUND_RESET_PATTERN.test(firstSentence);
}

function responseHasNewTaskOpening(user_response = null) {
  const normalized = normalizeUserResponseForTurn(user_response);
  if (!normalized) {
    return false;
  }
  const firstSentence = extractFirstSentence(normalized.answer || "");
  return NEW_TASK_OPENING_PATTERN.test(firstSentence);
}

function responseHasContinuationTone(user_response = null) {
  const normalized = normalizeUserResponseForTurn(user_response);
  if (!normalized) {
    return false;
  }
  if (responseHasNewTaskOpening(normalized)) {
    return false;
  }
  const segments = [
    cleanText(normalized.answer || ""),
    ...toArray(normalized.sources),
    ...toArray(normalized.limitations),
  ].map((segment) => cleanText(segment)).filter(Boolean);
  return segments.some((segment) => CONTINUITY_TONE_PATTERN.test(segment));
}

function isAskUserPromotionExecuted(decision_promotion = null) {
  const normalized = toObject(decision_promotion);
  if (!normalized) {
    return false;
  }
  return normalized.promotion_applied === true
    && cleanText(normalized.promoted_action || "") === "ask_user";
}

export function classifyUsageIssueVisibilityForTurn({
  usage_layer = null,
  decision_promotion = null,
  slot_state_snapshot = [],
  user_response = null,
} = {}) {
  const normalizedUsageLayer = toObject(usage_layer) || {};
  const rawDetectedCodes = normalizeIssueCodes(normalizedUsageLayer.usage_issue_codes);
  const askUserGate = toObject(decision_promotion?.ask_user_gate) || {};
  const askUserGateBlockedReasons = toArray(askUserGate.blocked_reason_codes).map((code) => cleanText(code)).filter(Boolean);
  const askUserGateSuppressed = askUserGate.resume_instead_of_ask === true
    || askUserGateBlockedReasons.includes("ask_user_no_truly_missing_slot")
    || askUserGateBlockedReasons.includes("ask_user_waiting_user_slots_filled")
    || askUserGateBlockedReasons.includes("ask_user_resume_action_available")
    || askUserGateBlockedReasons.includes("ask_user_slot_suppressed")
    || askUserGateBlockedReasons.includes("ask_user_continuation_ready");
  const slotSuppressedAsk = normalizedUsageLayer.slot_suppressed_ask === true
    || askUserGateSuppressed;
  const retryContextApplied = normalizedUsageLayer.retry_context_applied === true;

  const validFilledSlot = hasValidFilledSlotSnapshot(slot_state_snapshot);
  const noAskUserExecuted = !isAskUserPromotionExecuted(decision_promotion);

  const transformedDetected = [];
  const suppressedCodes = [];
  for (const code of rawDetectedCodes) {
    if (
      code === "redundant_slot_ask"
      && slotSuppressedAsk
      && validFilledSlot
      && noAskUserExecuted
    ) {
      transformedDetected.push("redundant_slot_ask_suppressed");
      suppressedCodes.push("redundant_slot_ask_suppressed");
      continue;
    }
    transformedDetected.push(code);
  }
  const detectedCodes = Array.from(new Set(transformedDetected));

  const exposedSet = new Set(detectedCodes);
  if (suppressedCodes.includes("redundant_slot_ask_suppressed")) {
    exposedSet.delete("redundant_slot_ask");
    exposedSet.delete("redundant_slot_ask_suppressed");
  }

  const retrySuppressionEligible = detectedCodes.includes("retry_without_contextual_response")
    && retryContextApplied
    && !responseLooksLikeLongReset(user_response)
    && responseHasContinuationTone(user_response);
  if (retrySuppressionEligible) {
    exposedSet.delete("retry_without_contextual_response");
    suppressedCodes.push("retry_without_contextual_response");
  }

  const exposedCodes = Array.from(exposedSet);
  const slotSuppressionSuccessful = slotSuppressedAsk
    && !exposedCodes.includes("redundant_slot_ask")
    && !exposedCodes.includes("redundant_slot_ask_suppressed");
  const retrySuppressionSuccessful = retryContextApplied
    && !exposedCodes.includes("retry_without_contextual_response");

  return {
    issue_detected: detectedCodes.length > 0,
    issue_exposed_to_user: exposedCodes.length > 0,
    issue_detected_codes: detectedCodes,
    issue_exposed_codes: exposedCodes,
    issue_suppressed_codes: Array.from(new Set(suppressedCodes)),
    suppression_flags: {
      slot: {
        applied: slotSuppressedAsk,
        successful: slotSuppressionSuccessful,
      },
      retry: {
        applied: retryContextApplied,
        successful: retrySuppressionSuccessful,
      },
    },
  };
}

function ensureTurnIssueVisibility(turn = null) {
  const normalizedTurn = toObject(turn) || {};
  const existingDetected = normalizeIssueCodes(normalizedTurn.issue_detected_codes);
  const existingExposed = normalizeIssueCodes(normalizedTurn.issue_exposed_codes);
  const existingSuppressed = normalizeIssueCodes(normalizedTurn.issue_suppressed_codes);
  const existingFlags = toObject(normalizedTurn.suppression_flags);
  if (existingDetected.length > 0 || existingExposed.length > 0 || existingSuppressed.length > 0 || existingFlags) {
    return {
      issue_detected: existingDetected.length > 0,
      issue_exposed_to_user: existingExposed.length > 0,
      issue_detected_codes: existingDetected,
      issue_exposed_codes: existingExposed,
      issue_suppressed_codes: existingSuppressed,
      suppression_flags: {
        slot: {
          applied: existingFlags?.slot?.applied === true,
          successful: existingFlags?.slot?.successful === true,
        },
        retry: {
          applied: existingFlags?.retry?.applied === true,
          successful: existingFlags?.retry?.successful === true,
        },
      },
    };
  }
  return classifyUsageIssueVisibilityForTurn({
    usage_layer: normalizedTurn.usage_layer,
    decision_promotion: normalizedTurn.decision_promotion,
    slot_state_snapshot: normalizedTurn.slot_state_snapshot,
    user_response: normalizedTurn.user_response,
  });
}

function normalizeHintTags(value = "") {
  const normalized = cleanText(value || "").toLowerCase();
  if (!normalized) {
    return new Set();
  }
  const tokens = normalized
    .split(/[^a-z0-9_]+/)
    .map((token) => cleanText(token))
    .filter(Boolean);
  return new Set(tokens);
}

function inferTurnMode({
  turn = null,
  state = null,
  hintTags = new Set(),
} = {}) {
  const userInput = cleanText(turn?.user_input || "");
  const hasActiveTask = state?.task_active === true;
  if (hintTags.has("topic_switch") || TOPIC_SWITCH_PATTERN.test(userInput)) {
    return TURN_MODE.TOPIC_SWITCH;
  }
  if (hintTags.has("promote_fail") || hintTags.has("fail")) {
    return TURN_MODE.FAIL;
  }
  if (hintTags.has("slot_missing")) {
    return TURN_MODE.SLOT_MISSING;
  }
  if (hintTags.has("slot_filled_resume")) {
    return TURN_MODE.SLOT_FILLED_RESUME;
  }
  if (hintTags.has("retry") || hintTags.has("retry_effective") || hintTags.has("retry_ineffective") || RETRY_PATTERN.test(userInput)) {
    return TURN_MODE.RETRY;
  }
  if (hintTags.has("reroute") || hintTags.has("reroute_effective") || hintTags.has("reroute_ineffective") || REROUTE_PATTERN.test(userInput)) {
    return TURN_MODE.REROUTE;
  }
  if (hintTags.has("continuation_missed")) {
    return TURN_MODE.CONTINUATION_MISSED;
  }
  if (hintTags.has("continuation") || (hasActiveTask && (CONTINUATION_PATTERN.test(userInput) || SLOT_FILL_PATTERN.test(userInput)))) {
    return TURN_MODE.CONTINUATION;
  }
  return hasActiveTask
    ? TURN_MODE.CONTINUATION
    : TURN_MODE.START;
}

function buildHealthyRerouteScoreboard() {
  return {
    actions: [
      { action_name: "ask_user", maturity_signal: "medium" },
      { action_name: "retry", maturity_signal: "medium" },
      { action_name: "fail", maturity_signal: "medium" },
      { action_name: "reroute", maturity_signal: "low" },
    ],
  };
}

function buildDefaultReadiness({
  recommended_action = "proceed",
  is_ready = true,
  blocking_reason_codes = [],
  missing_slots = [],
  owner_ready = true,
  recovery_ready = true,
} = {}) {
  return {
    is_ready: is_ready === true,
    blocking_reason_codes: toArray(blocking_reason_codes).map((code) => cleanText(code)).filter(Boolean),
    missing_slots: toArray(missing_slots).map((slot) => cleanText(slot)).filter(Boolean),
    invalid_artifacts: [],
    blocked_dependencies: [],
    owner_ready: owner_ready === true,
    recovery_ready: recovery_ready === true,
    recommended_action: cleanText(recommended_action || "") || "proceed",
  };
}

function buildDefaultRecovery({
  mode = TURN_MODE.START,
  retry_count = 0,
  retry_budget_max = 3,
  retry_budget_remaining = null,
} = {}) {
  if (mode === TURN_MODE.RETRY) {
    const hasExplicitRemaining = retry_budget_remaining !== null
      && retry_budget_remaining !== undefined
      && retry_budget_remaining !== ""
      && Number.isFinite(Number(retry_budget_remaining));
    const remaining = hasExplicitRemaining
      ? Math.max(0, Number(retry_budget_remaining))
      : Math.max(0, retry_budget_max - retry_count);
    return {
      recovery_policy: "retry_same_step",
      recovery_action: "retry_same_step",
      recovery_attempt_count: Math.max(0, Number(retry_count || 0)),
      retry_allowed: true,
      retry_budget_max: Math.max(1, Number(retry_budget_max || 3)),
      retry_budget_remaining: remaining,
      retry_budget_exhausted: remaining <= 0,
    };
  }
  if (mode === TURN_MODE.REROUTE) {
    return {
      recovery_policy: "reroute_owner",
      recovery_action: "reroute_owner",
      recovery_attempt_count: 1,
      retry_allowed: true,
      retry_budget_max: Math.max(1, Number(retry_budget_max || 3)),
      retry_budget_remaining: Math.max(0, Math.max(1, Number(retry_budget_max || 3)) - 1),
      retry_budget_exhausted: false,
    };
  }
  if (mode === TURN_MODE.SLOT_MISSING) {
    return {
      recovery_policy: "ask_user",
      recovery_action: "ask_user",
      recovery_attempt_count: 0,
      retry_allowed: true,
      retry_budget_max: Math.max(1, Number(retry_budget_max || 3)),
      retry_budget_remaining: Math.max(1, Number(retry_budget_max || 3)),
      retry_budget_exhausted: false,
    };
  }
  if (mode === TURN_MODE.FAIL) {
    return {
      recovery_policy: "failed",
      recovery_action: "failed",
      recovery_attempt_count: Math.max(0, Number(retry_count || 0)),
      retry_allowed: false,
      retry_budget_max: Math.max(1, Number(retry_budget_max || 3)),
      retry_budget_remaining: 0,
      retry_budget_exhausted: true,
    };
  }
  return {
    recovery_policy: "none",
    recovery_action: "none",
    recovery_attempt_count: Math.max(0, Number(retry_count || 0)),
    retry_allowed: true,
    retry_budget_max: Math.max(1, Number(retry_budget_max || 3)),
    retry_budget_remaining: Math.max(1, Number(retry_budget_max || 3)),
    retry_budget_exhausted: false,
  };
}

function buildDefaultArtifact() {
  return {
    artifact_id: "artifact-eval",
    validity_status: "valid",
    invalid_artifact_count: 0,
    blocked_dependency_count: 0,
    dependency_blocked_step: null,
  };
}

function buildDefaultTaskPlan({
  case_id = "",
  turn_index = 0,
  mode = TURN_MODE.START,
  owner_agent = "doc_agent",
  hint_tags = new Set(),
} = {}) {
  const taskType = hint_tags.has("runtime")
    ? "runtime_info"
    : "document_lookup";
  return {
    task_id: `task-${case_id || "usage-eval"}`,
    plan_id: `plan-${case_id || "usage-eval"}-${turn_index + 1}`,
    plan_status: mode === TURN_MODE.FAIL ? "invalidated" : "active",
    current_step_id: `step-${turn_index + 1}`,
    current_step_status: mode === TURN_MODE.FAIL ? "failed" : "running",
    failure_class: mode === TURN_MODE.REROUTE ? "capability_gap" : mode === TURN_MODE.FAIL ? "plan_invalidated" : null,
    step_retryable: mode !== TURN_MODE.FAIL,
    owner_agent: cleanText(owner_agent || "") || "doc_agent",
    task_type: taskType,
    malformed_input: false,
  };
}

function buildUserResponse({
  mode = TURN_MODE.START,
  hint_tags = new Set(),
  owner_agent = "doc_agent",
  reroute_target = "runtime_agent",
  user_input = "",
} = {}) {
  const includeContinuity = hint_tags.has("with_context")
    || hint_tags.has("continuity")
    || hint_tags.has("slot_filled_resume")
    || hint_tags.has("retry_effective")
    || hint_tags.has("reroute_effective");
  if (mode === TURN_MODE.SLOT_MISSING || hint_tags.has("redundant_ask")) {
    return {
      ok: false,
      answer: "請補上文件編號或關鍵字，我才能繼續。",
      sources: [],
      limitations: ["目前缺少必要槽位資訊"],
      failure_class: "missing_slot",
    };
  }
  if (mode === TURN_MODE.FAIL) {
    return {
      ok: false,
      answer: "這條路徑目前不安全，先停在 fail-closed 邊界。",
      sources: [],
      limitations: ["plan_invalidated"],
      failure_class: "fail_closed",
    };
  }
  if (mode === TURN_MODE.RETRY) {
    if (hint_tags.has("retry_ineffective")) {
      return {
        ok: true,
        answer: "已重新嘗試，但結果仍不穩定，需要你確認是否改走別條路徑。",
        sources: includeContinuity ? ["接著上一輪失敗步驟，我先重試一次。"] : [],
        limitations: ["重試未達到成功結果"],
      };
    }
    return {
      ok: true,
      answer: "接著上一輪，我已完成重試並拿到可用結果。",
      sources: includeContinuity ? ["接著上一輪，我沿用原路徑完成重試。"] : [],
      limitations: [],
    };
  }
  if (mode === TURN_MODE.REROUTE) {
    if (hint_tags.has("reroute_ineffective")) {
      return {
        ok: true,
        answer: "已嘗試改由其他 owner 接手，但這輪仍未明顯改善。",
        sources: includeContinuity ? [`接著上一輪，我先改由 ${reroute_target} 處理。`] : [],
        limitations: ["reroute 無顯著改善"],
      };
    }
    return {
      ok: true,
      answer: `接著上一輪，我已改由 ${reroute_target} 接手並完成這一步。`,
      sources: includeContinuity ? [`接著上一輪，owner 已由 ${owner_agent} 切到 ${reroute_target}。`] : [],
      limitations: [],
    };
  }
  if (mode === TURN_MODE.TOPIC_SWITCH) {
    return {
      ok: true,
      answer: "收到，已切到新題目並先給你第一版答案。",
      sources: ["已重置為新任務上下文"],
      limitations: [],
    };
  }
  if (mode === TURN_MODE.SLOT_FILLED_RESUME) {
    return {
      ok: true,
      answer: "接著你剛補的資訊，我已恢復原步驟並完成處理。",
      sources: includeContinuity ? ["接著上一輪 slot 補齊後，我沿原路徑往下執行。"] : [],
      limitations: [],
    };
  }
  if (mode === TURN_MODE.CONTINUATION_MISSED) {
    return {
      ok: true,
      answer: "我先當作新任務重新開始處理。",
      sources: [],
      limitations: [],
    };
  }
  if (mode === TURN_MODE.CONTINUATION) {
    return {
      ok: true,
      answer: "接著上一輪，我已沿同一目標繼續推進。",
      sources: includeContinuity ? ["接著上一輪處理，延續既有上下文。"] : [],
      limitations: [],
    };
  }
  return {
    ok: true,
    answer: `已開始處理：${cleanText(user_input || "") || "這個需求"}`,
    sources: [],
    limitations: [],
  };
}

function resolveAdvisorAction({
  mode = TURN_MODE.START,
} = {}) {
  if (mode === TURN_MODE.SLOT_MISSING) {
    return "ask_user";
  }
  if (mode === TURN_MODE.RETRY) {
    return "retry";
  }
  if (mode === TURN_MODE.REROUTE) {
    return "reroute";
  }
  if (mode === TURN_MODE.FAIL) {
    return "fail";
  }
  return "proceed";
}

function resolveActualAction({
  mode = TURN_MODE.START,
  hint_tags = new Set(),
  advisor_action = "proceed",
} = {}) {
  if (hint_tags.has("actual_ask_user")) {
    return "ask_user";
  }
  if (hint_tags.has("actual_fail")) {
    return "fail";
  }
  if (hint_tags.has("actual_retry")) {
    return "retry";
  }
  if (hint_tags.has("actual_reroute")) {
    return "reroute";
  }
  if (hint_tags.has("actual_proceed")) {
    return "proceed";
  }
  if (mode === TURN_MODE.CONTINUATION_MISSED) {
    return "proceed";
  }
  return advisor_action;
}

function buildOutcomeInput({
  mode = TURN_MODE.START,
  readiness = null,
  recovery = null,
  userResponse = null,
  hint_tags = new Set(),
} = {}) {
  const requiredSlots = mode === TURN_MODE.SLOT_MISSING
    ? ["doc_id"]
    : [];
  const missingSlots = mode === TURN_MODE.SLOT_MISSING
    ? ["doc_id"]
    : [];
  const stepStatus = mode === TURN_MODE.SLOT_MISSING
    ? "blocked"
    : mode === TURN_MODE.FAIL
      ? "failed"
      : mode === TURN_MODE.SLOT_FILLED_RESUME
        ? "completed"
        : "running";
  const error = mode === TURN_MODE.RETRY
    ? "tool_error"
    : mode === TURN_MODE.FAIL
      ? "plan_invalidated"
      : "";
  const failureClass = mode === TURN_MODE.REROUTE
    ? "capability_gap"
    : mode === TURN_MODE.FAIL
      ? "plan_invalidated"
      : "";
  const artifactsProducedCount = mode === TURN_MODE.FAIL
    ? 0
    : mode === TURN_MODE.SLOT_MISSING
      ? 0
      : 1;
  const limitations = toArray(userResponse?.limitations);
  const hasOutput = userResponse?.ok === true || limitations.length > 0;
  return scoreExecutionOutcome({
    stepStatus,
    requiredSlots,
    missingSlots,
    artifactsProducedCount,
    error,
    failureClass,
    readiness,
    recoveryAction: cleanText(recovery?.recovery_action || ""),
    recoveryPolicy: cleanText(recovery?.recovery_policy || ""),
    artifactQualityHint: "valid",
    artifactValidityStatus: "valid",
    hasUserVisibleOutputFlag: hasOutput,
    userVisibleAnswer: cleanText(userResponse?.answer || ""),
    userVisibleSources: toArray(userResponse?.sources),
    userVisibleLimitations: limitations,
  });
}

function resolveFinalAuditOutcome({
  mode = TURN_MODE.START,
  hint_tags = new Set(),
  promotion_decision = null,
  base_outcome = null,
} = {}) {
  const baseOutcomeStatus = cleanText(base_outcome?.outcome_status || "") || "partial";
  const baseCompleteness = cleanText(base_outcome?.user_visible_completeness || "") || "partial";
  const promotedAction = cleanText(promotion_decision?.promoted_action || "");
  const promotionApplied = promotion_decision?.promotion_applied === true;
  if (!promotionApplied) {
    return {
      final_step_status: baseOutcomeStatus === "success"
        ? "completed"
        : baseOutcomeStatus === "failed"
          ? "failed"
          : baseOutcomeStatus === "blocked"
            ? "blocked"
            : "running",
      outcome_status: baseOutcomeStatus,
      user_visible_completeness: baseCompleteness,
    };
  }
  if (promotedAction === "retry") {
    if (hint_tags.has("retry_ineffective")) {
      return {
        final_step_status: "blocked",
        outcome_status: "blocked",
        user_visible_completeness: "partial",
      };
    }
    return {
      final_step_status: "completed",
      outcome_status: "success",
      user_visible_completeness: "complete",
    };
  }
  if (promotedAction === "reroute") {
    if (hint_tags.has("reroute_ineffective")) {
      return {
        final_step_status: "running",
        outcome_status: "partial",
        user_visible_completeness: "partial",
      };
    }
    return {
      final_step_status: "completed",
      outcome_status: "success",
      user_visible_completeness: "complete",
    };
  }
  if (promotedAction === "ask_user") {
    if (hint_tags.has("ask_user_effective")) {
      return {
        final_step_status: "completed",
        outcome_status: "success",
        user_visible_completeness: "complete",
      };
    }
    return {
      final_step_status: "blocked",
      outcome_status: "blocked",
      user_visible_completeness: "none",
    };
  }
  if (promotedAction === "fail") {
    return {
      final_step_status: "failed",
      outcome_status: "failed",
      user_visible_completeness: "none",
    };
  }
  return {
    final_step_status: "running",
    outcome_status: baseOutcomeStatus,
    user_visible_completeness: baseCompleteness,
  };
}

function buildTraceSnapshot({
  case_id = "",
  turn_index = 0,
  actual_action = null,
  promoted_action = null,
  usage_layer = null,
  outcome = null,
  issue_detected_codes = [],
  issue_exposed_codes = [],
  suppression_flags = null,
} = {}) {
  return {
    case_id: cleanText(case_id || ""),
    turn_index: Number(turn_index || 0),
    action: {
      actual: cleanText(actual_action || "") || null,
      promoted: cleanText(promoted_action || "") || null,
    },
    usage_issue_codes: toArray(usage_layer?.usage_issue_codes).map((code) => cleanText(code)).filter(Boolean),
    issue_detected_codes: normalizeIssueCodes(issue_detected_codes),
    issue_exposed_codes: normalizeIssueCodes(issue_exposed_codes),
    suppression_flags: {
      slot: {
        applied: suppression_flags?.slot?.applied === true,
        successful: suppression_flags?.slot?.successful === true,
      },
      retry: {
        applied: suppression_flags?.retry?.applied === true,
        successful: suppression_flags?.retry?.successful === true,
      },
    },
    response_continuity_score: cleanText(usage_layer?.response_continuity_score || "") || "low",
    outcome_status: cleanText(outcome?.outcome_status || "") || null,
  };
}

function createInitialCaseState() {
  return {
    task_active: false,
    task_type: "document_lookup",
    task_phase: "init",
    task_status: "running",
    current_owner_agent: "doc_agent",
    previous_owner_agent: null,
    next_best_action: "search_company_brain_docs",
    unresolved_slots: [],
    slot_state: [],
    retry_count: 0,
    promotion_audit_state: createDecisionPromotionAuditState(),
  };
}

function buildWorkingMemoryForUsage({
  state = null,
  mode = TURN_MODE.START,
  hint_tags = new Set(),
} = {}) {
  const slotState = toArray(state?.slot_state);
  const unresolved = toArray(state?.unresolved_slots);
  const waitingUser = mode === TURN_MODE.SLOT_MISSING || mode === TURN_MODE.SLOT_FILLED_RESUME;
  const nextBestAction = mode === TURN_MODE.CONTINUATION_MISSED
    ? ""
    : cleanText(state?.next_best_action || "search_company_brain_docs");
  const taskType = mode === TURN_MODE.TOPIC_SWITCH
    ? "runtime_info"
    : cleanText(state?.task_type || "document_lookup");
  return {
    task_id: `task-${cleanText(state?.task_type || "usage-eval") || "usage-eval"}`,
    task_type: taskType,
    task_phase: waitingUser ? "waiting_user" : cleanText(state?.task_phase || "executing"),
    task_status: cleanText(state?.task_status || "running"),
    current_goal: hint_tags.has("runtime")
      ? "查詢 runtime 健康資訊"
      : "整理文件並完成下一步",
    next_best_action: nextBestAction || null,
    unresolved_slots: unresolved,
    slot_state: slotState,
    current_owner_agent: cleanText(state?.current_owner_agent || "") || null,
    previous_owner_agent: cleanText(state?.previous_owner_agent || "") || null,
  };
}

function buildCurrentPlanStep({
  state = null,
  mode = TURN_MODE.START,
} = {}) {
  const intendedAction = mode === TURN_MODE.CONTINUATION_MISSED
    ? ""
    : cleanText(state?.next_best_action || "search_company_brain_docs");
  return {
    step_id: "step-eval",
    owner_agent: cleanText(state?.current_owner_agent || "doc_agent"),
    intended_action: intendedAction || null,
  };
}

function normalizeAction(value = "") {
  const normalized = cleanText(value || "");
  return ADVISOR_ACTIONS.has(normalized)
    ? normalized
    : null;
}

function resolveModeReadiness({
  mode = TURN_MODE.START,
  hint_tags = new Set(),
} = {}) {
  if (mode === TURN_MODE.SLOT_MISSING || hint_tags.has("redundant_ask")) {
    const missingSlots = hint_tags.has("redundant_ask")
      ? []
      : ["doc_id"];
    return buildDefaultReadiness({
      recommended_action: "ask_user",
      is_ready: false,
      blocking_reason_codes: missingSlots.length > 0 ? ["missing_slot"] : [],
      missing_slots: missingSlots,
      owner_ready: true,
      recovery_ready: true,
    });
  }
  if (mode === TURN_MODE.RETRY) {
    return buildDefaultReadiness({
      recommended_action: "retry",
      is_ready: true,
      blocking_reason_codes: [],
      missing_slots: [],
      owner_ready: true,
      recovery_ready: true,
    });
  }
  if (mode === TURN_MODE.REROUTE) {
    return buildDefaultReadiness({
      recommended_action: "reroute",
      is_ready: false,
      blocking_reason_codes: ["owner_mismatch"],
      missing_slots: [],
      owner_ready: false,
      recovery_ready: true,
    });
  }
  if (mode === TURN_MODE.FAIL) {
    return buildDefaultReadiness({
      recommended_action: "fail",
      is_ready: false,
      blocking_reason_codes: ["plan_invalidated"],
      missing_slots: [],
      owner_ready: true,
      recovery_ready: false,
    });
  }
  return buildDefaultReadiness({
    recommended_action: "proceed",
    is_ready: true,
    blocking_reason_codes: [],
    missing_slots: [],
    owner_ready: true,
    recovery_ready: true,
  });
}

function resolveExpectedContinuation({
  mode = TURN_MODE.START,
} = {}) {
  return mode === TURN_MODE.CONTINUATION
    || mode === TURN_MODE.CONTINUATION_MISSED
    || mode === TURN_MODE.SLOT_FILLED_RESUME
    || mode === TURN_MODE.RETRY
    || mode === TURN_MODE.REROUTE;
}

function resolveSlotResumeAttempt({
  mode = TURN_MODE.START,
  hint_tags = new Set(),
} = {}) {
  return mode === TURN_MODE.SLOT_FILLED_RESUME
    || hint_tags.has("slot_filled_resume");
}

function resolveRerouteContext({
  mode = TURN_MODE.START,
  state = null,
  hint_tags = new Set(),
} = {}) {
  if (mode !== TURN_MODE.REROUTE) {
    return null;
  }
  const previousOwner = cleanText(state?.current_owner_agent || "doc_agent") || "doc_agent";
  const targetOwner = hint_tags.has("target_doc")
    ? "doc_agent"
    : "runtime_agent";
  return {
    previous_owner_agent: previousOwner,
    current_owner_agent: targetOwner,
    reroute_target: targetOwner,
    reroute_reason: "owner_mismatch",
    reroute_source: "usage_eval_runner",
    reroute_target_verified: !hint_tags.has("reroute_ineffective"),
  };
}

function applyStateTransition({
  state = null,
  mode = TURN_MODE.START,
  hint_tags = new Set(),
  promoted_action = null,
  promotion_applied = false,
} = {}) {
  const nextState = {
    ...state,
    task_active: true,
  };
  if (mode === TURN_MODE.TOPIC_SWITCH) {
    nextState.task_type = "runtime_info";
    nextState.task_phase = "executing";
    nextState.task_status = "running";
    nextState.unresolved_slots = [];
    nextState.slot_state = [];
    nextState.next_best_action = "get_runtime_info";
    return nextState;
  }
  if (mode === TURN_MODE.SLOT_MISSING) {
    nextState.task_phase = "waiting_user";
    nextState.task_status = "blocked";
    if (hint_tags.has("redundant_ask")) {
      nextState.unresolved_slots = [];
      nextState.slot_state = [{ slot_key: "doc_id", status: "filled" }];
    } else {
      nextState.unresolved_slots = ["doc_id"];
      nextState.slot_state = [{ slot_key: "doc_id", status: "missing" }];
    }
    nextState.next_best_action = "get_company_brain_doc_detail";
    return nextState;
  }
  if (mode === TURN_MODE.SLOT_FILLED_RESUME) {
    nextState.task_phase = "executing";
    nextState.task_status = "running";
    nextState.unresolved_slots = [];
    nextState.slot_state = [{ slot_key: "doc_id", status: "filled" }];
    nextState.next_best_action = "get_company_brain_doc_detail";
    return nextState;
  }
  if (mode === TURN_MODE.RETRY) {
    nextState.task_phase = "retrying";
    nextState.retry_count = Number(nextState.retry_count || 0) + 1;
    nextState.task_status = hint_tags.has("retry_ineffective")
      ? "failed"
      : "running";
    nextState.next_best_action = "retry";
    return nextState;
  }
  if (mode === TURN_MODE.REROUTE) {
    nextState.task_phase = "executing";
    nextState.previous_owner_agent = cleanText(nextState.current_owner_agent || "");
    if (promotion_applied && cleanText(promoted_action || "") === "reroute") {
      nextState.current_owner_agent = hint_tags.has("target_doc")
        ? "doc_agent"
        : "runtime_agent";
    }
    nextState.task_status = hint_tags.has("reroute_ineffective")
      ? "blocked"
      : "running";
    nextState.next_best_action = "reroute";
    return nextState;
  }
  if (mode === TURN_MODE.FAIL) {
    nextState.task_phase = "failed";
    nextState.task_status = "failed";
    nextState.next_best_action = "fail";
    return nextState;
  }
  if (mode === TURN_MODE.CONTINUATION_MISSED) {
    nextState.task_phase = "executing";
    nextState.task_status = "running";
    nextState.next_best_action = "search_company_brain_docs";
    return nextState;
  }
  if (mode === TURN_MODE.CONTINUATION) {
    nextState.task_phase = "executing";
    nextState.task_status = "running";
    return nextState;
  }
  nextState.task_phase = "executing";
  nextState.task_status = "running";
  nextState.task_type = hint_tags.has("runtime")
    ? "runtime_info"
    : "document_lookup";
  nextState.next_best_action = nextState.task_type === "runtime_info"
    ? "get_runtime_info"
    : "search_company_brain_docs";
  return nextState;
}

function buildTurnResult({
  case_id = "",
  turn_index = 0,
  user_input = "",
  expected_behavior_hint = "",
  mode = TURN_MODE.START,
  expected_continuation = false,
  slot_resume_attempt = false,
  advisor_action = null,
  actual_action = null,
  usage_pass = null,
  readiness = null,
  outcome = null,
  advisor_alignment = null,
  decision_promotion = null,
  promotion_audit = null,
  user_response = null,
  slot_state_snapshot = [],
  unresolved_slots_snapshot = [],
} = {}) {
  const usageLayer = toObject(usage_pass?.diagnostics) || {
    interpreted_as_continuation: false,
    interpreted_as_new_task: true,
    redundant_question_detected: false,
    owner_selection_feels_consistent: true,
    slot_suppressed_ask: false,
    retry_context_applied: false,
    response_continuity_score: "low",
    usage_issue_codes: [],
  };
  const normalizedUserResponse = normalizeUserResponseForTurn(user_response);
  const issueVisibility = classifyUsageIssueVisibilityForTurn({
    usage_layer: usageLayer,
    decision_promotion,
    slot_state_snapshot,
    user_response: normalizedUserResponse,
  });
  const trace_snapshot = buildTraceSnapshot({
    case_id,
    turn_index,
    actual_action,
    promoted_action: cleanText(decision_promotion?.promoted_action || "") || null,
    usage_layer: usageLayer,
    outcome,
    issue_detected_codes: issueVisibility.issue_detected_codes,
    issue_exposed_codes: issueVisibility.issue_exposed_codes,
    suppression_flags: issueVisibility.suppression_flags,
  });
  return {
    turn_index,
    user_input: cleanText(user_input || ""),
    expected_behavior_hint: cleanText(expected_behavior_hint || "") || null,
    mode,
    turn_intent: {
      expected_continuation: expected_continuation === true,
      slot_resume_attempt: slot_resume_attempt === true,
    },
    advisor_action: cleanText(advisor_action || "") || null,
    actual_action: cleanText(actual_action || "") || null,
    usage_layer: usageLayer,
    decision_promotion: toObject(decision_promotion) || null,
    advisor_alignment: toObject(advisor_alignment) || null,
    outcome: toObject(outcome) || null,
    readiness: toObject(readiness) || null,
    promotion_audit: toObject(promotion_audit) || null,
    slot_state_snapshot: toArray(slot_state_snapshot).map((slot) => toObject(slot)).filter(Boolean),
    unresolved_slots_snapshot: toArray(unresolved_slots_snapshot).map((slot) => cleanText(slot)).filter(Boolean),
    user_response: normalizedUserResponse,
    issue_detected: issueVisibility.issue_detected,
    issue_exposed_to_user: issueVisibility.issue_exposed_to_user,
    issue_detected_codes: issueVisibility.issue_detected_codes,
    issue_exposed_codes: issueVisibility.issue_exposed_codes,
    issue_suppressed_codes: issueVisibility.issue_suppressed_codes,
    suppression_flags: issueVisibility.suppression_flags,
    trace_snapshot,
  };
}

function summarizeCaseTurnResults(caseResult = null) {
  const turns = toArray(caseResult?.turns);
  const continuationTurns = turns.filter((turn) => turn?.turn_intent?.expected_continuation === true);
  const continuationHits = continuationTurns.filter((turn) => turn?.usage_layer?.interpreted_as_continuation === true);
  const mistakenNewTask = continuationTurns.filter((turn) =>
    toArray(turn?.usage_layer?.usage_issue_codes).includes("mistaken_new_task"));
  const redundantAsks = turns.filter((turn) => turn?.usage_layer?.redundant_question_detected === true);
  const slotResumeAttempts = turns.filter((turn) => turn?.turn_intent?.slot_resume_attempt === true);
  const slotResumeSuccesses = slotResumeAttempts.filter((turn) =>
    turn?.usage_layer?.interpreted_as_continuation === true
    && turn?.readiness?.is_ready === true
    && cleanText(turn?.actual_action || "") !== "ask_user");
  const promotedTurns = turns.filter((turn) => turn?.decision_promotion?.promotion_applied === true);
  const detectedIssueCounter = {};
  const exposedIssueCounter = {};
  const outcomeCounter = {};
  let issueDetectedCount = 0;
  let issueExposedCount = 0;
  let redundantDetectedCount = 0;
  let redundantExposedCount = 0;
  for (const turn of turns) {
    const issueVisibility = ensureTurnIssueVisibility(turn);
    if (issueVisibility.issue_detected === true) {
      issueDetectedCount += 1;
    }
    if (issueVisibility.issue_exposed_to_user === true) {
      issueExposedCount += 1;
    }
    for (const code of issueVisibility.issue_detected_codes) {
      detectedIssueCounter[code] = Number(detectedIssueCounter[code] || 0) + 1;
      if (code === "redundant_slot_ask" || code === "redundant_slot_ask_suppressed") {
        redundantDetectedCount += 1;
      }
    }
    for (const code of issueVisibility.issue_exposed_codes) {
      exposedIssueCounter[code] = Number(exposedIssueCounter[code] || 0) + 1;
      if (code === "redundant_slot_ask" || code === "redundant_slot_ask_suppressed") {
        redundantExposedCount += 1;
      }
    }
    const outcomeStatus = cleanText(turn?.outcome?.outcome_status || "");
    if (outcomeStatus) {
      outcomeCounter[outcomeStatus] = Number(outcomeCounter[outcomeStatus] || 0) + 1;
    }
  }
  return {
    case_id: cleanText(caseResult?.case_id || ""),
    description: cleanText(caseResult?.description || ""),
    total_turns: turns.length,
    continuation_intent_turns: continuationTurns.length,
    continuation_hits: continuationHits.length,
    continuation_rate: ratio(continuationHits.length, continuationTurns.length),
    mistaken_new_task_count: mistakenNewTask.length,
    issue_detected_count: issueDetectedCount,
    issue_exposed_count: issueExposedCount,
    redundant_question_detected_count: Math.max(redundantAsks.length, redundantDetectedCount),
    redundant_question_exposed_count: redundantExposedCount,
    redundant_question_count: redundantExposedCount,
    slot_fill_resume_attempts: slotResumeAttempts.length,
    slot_fill_resume_successes: slotResumeSuccesses.length,
    slot_fill_resume_success_rate: ratio(slotResumeSuccesses.length, slotResumeAttempts.length),
    promotions_applied_count: promotedTurns.length,
    top_detected_issue_codes: topDistribution(detectedIssueCounter, 3).map((item) => ({
      issue_code: item.key,
      count: item.count,
    })),
    top_user_visible_issue_codes: topDistribution(exposedIssueCounter, 3).map((item) => ({
      issue_code: item.key,
      count: item.count,
    })),
    top_usage_issue_codes: topDistribution(exposedIssueCounter, 3).map((item) => ({
      issue_code: item.key,
      count: item.count,
    })),
    outcome_status_distribution: outcomeCounter,
  };
}

function initializeAggregates() {
  return {
    total_turns: 0,
    continuation_intent_turns: 0,
    continuation_hits: 0,
    mistaken_new_task_count: 0,
    issue_detected_turn_count: 0,
    issue_exposed_turn_count: 0,
    redundant_question_detected_count: 0,
    redundant_question_exposed_count: 0,
    redundant_question_count: 0,
    slot_fill_resume_attempts: 0,
    slot_fill_resume_successes: 0,
    slot_ask_suppressed_turn_count: 0,
    slot_ask_suppression_success_turn_count: 0,
    retry_context_applied_turn_count: 0,
    retry_context_success_turn_count: 0,
    suppressible_issue_detected_count: 0,
    suppressible_issue_suppressed_count: 0,
    promotion_applied_count_by_action: Object.fromEntries(PROMOTION_ACTIONS.map((action) => [action, 0])),
    promotion_effective_count_by_action: Object.fromEntries(PROMOTION_ACTIONS.map((action) => [action, 0])),
    promotion_ineffective_count_by_action: Object.fromEntries(PROMOTION_ACTIONS.map((action) => [action, 0])),
    rollback_flag_count_by_action: Object.fromEntries(PROMOTION_ACTIONS.map((action) => [action, 0])),
    reroute_applied_count: 0,
    reroute_effective_count: 0,
    reroute_ineffective_count: 0,
    issue_detected_code_distribution: {},
    issue_exposed_code_distribution: {},
    usage_issue_code_distribution: {},
    response_continuity_score_distribution: Object.fromEntries(CONTINUITY_SCORES.map((score) => [score, 0])),
    divergence_pattern_distribution: {},
  };
}

function resolveDivergencePattern(alignment = null) {
  const alignmentType = cleanText(alignment?.alignment_type || "");
  if (!alignmentType || alignmentType === "exact_match") {
    return null;
  }
  const reasons = toArray(alignment?.divergence_reason_codes)
    .map((item) => cleanText(item))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  return `${alignmentType}:${reasons.length > 0 ? reasons.join("|") : "none"}`;
}

function accumulateTurnMetrics(aggregates = null, turn = null) {
  const next = toObject(aggregates) || initializeAggregates();
  next.total_turns += 1;
  const expectedContinuation = turn?.turn_intent?.expected_continuation === true;
  const interpretedContinuation = turn?.usage_layer?.interpreted_as_continuation === true;
  if (expectedContinuation) {
    next.continuation_intent_turns += 1;
    if (interpretedContinuation) {
      next.continuation_hits += 1;
    }
  }
  const issueVisibility = ensureTurnIssueVisibility(turn);
  const detectedIssueCodes = issueVisibility.issue_detected_codes;
  const exposedIssueCodes = issueVisibility.issue_exposed_codes;
  const suppressedIssueCodes = issueVisibility.issue_suppressed_codes;
  if (issueVisibility.issue_detected === true) {
    next.issue_detected_turn_count += 1;
  }
  if (issueVisibility.issue_exposed_to_user === true) {
    next.issue_exposed_turn_count += 1;
  }
  if (detectedIssueCodes.includes("mistaken_new_task")) {
    next.mistaken_new_task_count += 1;
  }
  const redundantDetected = detectedIssueCodes.includes("redundant_slot_ask")
    || detectedIssueCodes.includes("redundant_slot_ask_suppressed")
    || turn?.usage_layer?.redundant_question_detected === true;
  const redundantExposed = exposedIssueCodes.includes("redundant_slot_ask")
    || exposedIssueCodes.includes("redundant_slot_ask_suppressed");
  if (redundantDetected) {
    next.redundant_question_detected_count += 1;
  }
  if (redundantExposed) {
    next.redundant_question_exposed_count += 1;
    next.redundant_question_count += 1;
  }
  if (turn?.turn_intent?.slot_resume_attempt === true) {
    next.slot_fill_resume_attempts += 1;
    const slotResumeSuccess = interpretedContinuation
      && turn?.readiness?.is_ready === true
      && cleanText(turn?.actual_action || "") !== "ask_user";
    if (slotResumeSuccess) {
      next.slot_fill_resume_successes += 1;
    }
  }
  for (const issueCode of detectedIssueCodes) {
    next.issue_detected_code_distribution[issueCode] = Number(next.issue_detected_code_distribution[issueCode] || 0) + 1;
    if (issueCode === "redundant_slot_ask" || issueCode === "redundant_slot_ask_suppressed" || issueCode === "retry_without_contextual_response") {
      next.suppressible_issue_detected_count += 1;
    }
  }
  for (const issueCode of exposedIssueCodes) {
    next.issue_exposed_code_distribution[issueCode] = Number(next.issue_exposed_code_distribution[issueCode] || 0) + 1;
  }
  next.usage_issue_code_distribution = { ...next.issue_exposed_code_distribution };
  for (const issueCode of suppressedIssueCodes) {
    if (issueCode === "redundant_slot_ask_suppressed" || issueCode === "retry_without_contextual_response") {
      next.suppressible_issue_suppressed_count += 1;
    }
  }
  if (issueVisibility.suppression_flags?.slot?.applied === true) {
    next.slot_ask_suppressed_turn_count += 1;
    if (issueVisibility.suppression_flags?.slot?.successful === true) {
      next.slot_ask_suppression_success_turn_count += 1;
    }
  }
  if (issueVisibility.suppression_flags?.retry?.applied === true) {
    next.retry_context_applied_turn_count += 1;
    if (issueVisibility.suppression_flags?.retry?.successful === true) {
      next.retry_context_success_turn_count += 1;
    }
  }

  const continuityScore = cleanText(turn?.usage_layer?.response_continuity_score || "");
  if (continuityScore && Object.prototype.hasOwnProperty.call(next.response_continuity_score_distribution, continuityScore)) {
    next.response_continuity_score_distribution[continuityScore] += 1;
  }

  const promotedAction = cleanText(turn?.decision_promotion?.promoted_action || "");
  if (turn?.decision_promotion?.promotion_applied === true && PROMOTION_ACTIONS.includes(promotedAction)) {
    next.promotion_applied_count_by_action[promotedAction] += 1;
    if (promotedAction === "reroute") {
      next.reroute_applied_count += 1;
    }
  }
  const auditAction = cleanText(turn?.promotion_audit?.promoted_action || "");
  const effectiveness = cleanText(turn?.promotion_audit?.promotion_effectiveness || "");
  if (PROMOTION_ACTIONS.includes(auditAction)) {
    if (effectiveness === "effective") {
      next.promotion_effective_count_by_action[auditAction] += 1;
      if (auditAction === "reroute") {
        next.reroute_effective_count += 1;
      }
    } else if (effectiveness === "ineffective") {
      next.promotion_ineffective_count_by_action[auditAction] += 1;
      if (auditAction === "reroute") {
        next.reroute_ineffective_count += 1;
      }
    }
    if (turn?.promotion_audit?.rollback_flag === true) {
      next.rollback_flag_count_by_action[auditAction] += 1;
    }
  }
  const divergencePattern = resolveDivergencePattern(turn?.advisor_alignment);
  if (divergencePattern) {
    next.divergence_pattern_distribution[divergencePattern] = Number(next.divergence_pattern_distribution[divergencePattern] || 0) + 1;
  }
  return next;
}

function buildActionPerformance(aggregates = null) {
  const applied = toObject(aggregates?.promotion_applied_count_by_action) || {};
  const effective = toObject(aggregates?.promotion_effective_count_by_action) || {};
  const ineffective = toObject(aggregates?.promotion_ineffective_count_by_action) || {};
  const rollback = toObject(aggregates?.rollback_flag_count_by_action) || {};
  return PROMOTION_ACTIONS.map((action) => {
    const effectiveCount = Number(effective[action] || 0);
    const ineffectiveCount = Number(ineffective[action] || 0);
    return {
      action,
      promotion_applied_count: Number(applied[action] || 0),
      effective_count: effectiveCount,
      ineffective_count: ineffectiveCount,
      rollback_flag_count: Number(rollback[action] || 0),
      effectiveness_rate: ratio(
        effectiveCount,
        effectiveCount + ineffectiveCount,
      ),
    };
  });
}

function resolveBestWorstPromotionAction(actionPerformance = []) {
  const candidates = toArray(actionPerformance).filter((entry) =>
    Number(entry?.effective_count || 0) + Number(entry?.ineffective_count || 0) > 0);
  if (candidates.length === 0) {
    return {
      best_action: null,
      worst_action: null,
    };
  }
  const sorted = [...candidates].sort((left, right) => {
    if (right.effectiveness_rate !== left.effectiveness_rate) {
      return right.effectiveness_rate - left.effectiveness_rate;
    }
    const rightSamples = Number(right.effective_count || 0) + Number(right.ineffective_count || 0);
    const leftSamples = Number(left.effective_count || 0) + Number(left.ineffective_count || 0);
    if (rightSamples !== leftSamples) {
      return rightSamples - leftSamples;
    }
    return cleanText(left.action || "").localeCompare(cleanText(right.action || ""));
  });
  return {
    best_action: sorted[0]?.action || null,
    worst_action: sorted[sorted.length - 1]?.action || null,
  };
}

function buildPromotionPauseRecommendations(actionPerformance = []) {
  return toArray(actionPerformance)
    .filter((entry) => {
      const ineffectiveCount = Number(entry?.ineffective_count || 0);
      const samples = Number(entry?.effective_count || 0) + ineffectiveCount;
      const rollbackFlagCount = Number(entry?.rollback_flag_count || 0);
      return rollbackFlagCount > 0 || (samples >= 3 && entry.effectiveness_rate <= 0.4);
    })
    .map((entry) => {
      const ineffectiveCount = Number(entry?.ineffective_count || 0);
      const samples = Number(entry?.effective_count || 0) + ineffectiveCount;
      const rollbackFlagCount = Number(entry?.rollback_flag_count || 0);
      return {
        action: cleanText(entry.action || ""),
        ineffective_rate: ratio(ineffectiveCount, samples),
        rollback_flag_count: rollbackFlagCount,
        recommendation: rollbackFlagCount > 0
          ? "pause_promotion_due_to_rollback_flag"
          : "pause_promotion_due_to_low_effectiveness",
      };
    })
    .sort((left, right) => {
      if (right.rollback_flag_count !== left.rollback_flag_count) {
        return right.rollback_flag_count - left.rollback_flag_count;
      }
      if (right.ineffective_rate !== left.ineffective_rate) {
        return right.ineffective_rate - left.ineffective_rate;
      }
      return left.action.localeCompare(right.action);
    });
}

function resolveOverallIntelligenceSignal(metrics = null) {
  const continuationRate = Number(metrics?.continuation_quality?.continuation_rate || 0);
  const mistakenRate = Number(metrics?.continuation_quality?.mistaken_new_task_rate || 0);
  const redundantRate = Number(metrics?.redundant_ask?.redundant_question_exposed_rate || metrics?.redundant_ask?.redundant_question_rate || 0);
  const promotionRate = Number(metrics?.decision_engine?.promotion_effectiveness_rate || 0);
  const rerouteRate = Number(metrics?.reroute_quality?.reroute_effective_rate || 0);
  const detectedIssueRate = Number(
    metrics?.issue_visibility?.detected_issue_event_rate
    || metrics?.issue_visibility?.detected_issue_rate
    || 0,
  );
  const exposedIssueRate = Number(
    metrics?.issue_visibility?.exposed_issue_event_rate
    || metrics?.issue_visibility?.exposed_issue_rate
    || detectedIssueRate,
  );
  const issueDrop = detectedIssueRate - exposedIssueRate;
  const hasMeaningfulIssueDrop = issueDrop >= 0.08
    && exposedIssueRate <= detectedIssueRate * 0.75;

  let baseSignal = "low";
  if (
    continuationRate >= 0.85
    && mistakenRate <= 0.1
    && redundantRate <= 0.15
    && promotionRate >= 0.6
    && rerouteRate >= 0.55
  ) {
    baseSignal = "high";
  } else if (
    continuationRate >= 0.65
    && mistakenRate <= 0.25
    && redundantRate <= 0.3
    && promotionRate >= 0.35
  ) {
    baseSignal = "medium";
  }

  if (!hasMeaningfulIssueDrop) {
    return baseSignal;
  }
  if (baseSignal === "low") {
    return "medium";
  }
  if (baseSignal === "medium") {
    return "high";
  }
  return baseSignal;
}

function buildAggregatedMetrics(aggregates = null) {
  const normalized = toObject(aggregates) || initializeAggregates();
  const effectiveTotal = PROMOTION_ACTIONS.reduce((sum, action) =>
    sum + Number(normalized.promotion_effective_count_by_action[action] || 0), 0);
  const ineffectiveTotal = PROMOTION_ACTIONS.reduce((sum, action) =>
    sum + Number(normalized.promotion_ineffective_count_by_action[action] || 0), 0);
  const redundantDetectedCount = Number(normalized.redundant_question_detected_count || 0);
  const redundantExposedCount = Number(normalized.redundant_question_exposed_count || 0);
  const totalTurns = Number(normalized.total_turns || 0);
  const issueDetectedCount = Number(normalized.issue_detected_turn_count || 0);
  const issueExposedCount = Number(normalized.issue_exposed_turn_count || 0);
  const slotSuppressedTurnCount = Number(normalized.slot_ask_suppressed_turn_count || 0);
  const slotSuppressionSuccessTurnCount = Number(normalized.slot_ask_suppression_success_turn_count || 0);
  const retryContextAppliedTurnCount = Number(normalized.retry_context_applied_turn_count || 0);
  const retryContextSuccessTurnCount = Number(normalized.retry_context_success_turn_count || 0);
  const suppressibleDetectedCount = Number(normalized.suppressible_issue_detected_count || 0);
  const suppressibleSuppressedCount = Number(normalized.suppressible_issue_suppressed_count || 0);
  const detectedIssueEventCount = Object.values(toObject(normalized.issue_detected_code_distribution) || {})
    .reduce((sum, count) => sum + Number(count || 0), 0);
  const exposedIssueEventCount = Object.values(toObject(normalized.issue_exposed_code_distribution) || {})
    .reduce((sum, count) => sum + Number(count || 0), 0);
  const retryContextSuccessRate = ratio(retryContextSuccessTurnCount, retryContextAppliedTurnCount);
  const slotAskSuppressionSuccessRate = ratio(slotSuppressionSuccessTurnCount, slotSuppressedTurnCount);
  return {
    continuation_quality: {
      continuation_rate: ratio(normalized.continuation_hits, normalized.continuation_intent_turns),
      mistaken_new_task_rate: ratio(normalized.mistaken_new_task_count, normalized.continuation_intent_turns),
      continuation_intent_turns: normalized.continuation_intent_turns,
      continuation_hits: normalized.continuation_hits,
      mistaken_new_task_count: normalized.mistaken_new_task_count,
    },
    issue_visibility: {
      issue_detected_turn_count: issueDetectedCount,
      issue_exposed_turn_count: issueExposedCount,
      issue_detected_event_count: detectedIssueEventCount,
      issue_exposed_event_count: exposedIssueEventCount,
      detected_issue_rate: ratio(issueDetectedCount, totalTurns),
      exposed_issue_rate: ratio(issueExposedCount, totalTurns),
      detected_issue_event_rate: ratio(detectedIssueEventCount, totalTurns),
      exposed_issue_event_rate: ratio(exposedIssueEventCount, totalTurns),
      detected_minus_exposed_rate: ratio(issueDetectedCount - issueExposedCount, totalTurns),
      detected_minus_exposed_event_rate: ratio(detectedIssueEventCount - exposedIssueEventCount, totalTurns),
    },
    redundant_ask: {
      redundant_question_detected_rate: ratio(redundantDetectedCount, totalTurns),
      redundant_question_exposed_rate: ratio(redundantExposedCount, totalTurns),
      redundant_question_rate: ratio(redundantExposedCount, totalTurns),
      redundant_question_detected_count: redundantDetectedCount,
      redundant_question_exposed_count: redundantExposedCount,
      redundant_question_count: redundantExposedCount,
      total_turns: totalTurns,
    },
    slot_resume_quality: {
      slot_fill_resume_success_rate: ratio(normalized.slot_fill_resume_successes, normalized.slot_fill_resume_attempts),
      slot_fill_resume_attempts: normalized.slot_fill_resume_attempts,
      slot_fill_resume_successes: normalized.slot_fill_resume_successes,
    },
    retry_context_quality: {
      retry_context_applied_turn_count: retryContextAppliedTurnCount,
      retry_context_success_turn_count: retryContextSuccessTurnCount,
      retry_context_success_rate: retryContextSuccessRate,
    },
    slot_ask_suppression_quality: {
      slot_ask_suppressed_turn_count: slotSuppressedTurnCount,
      slot_ask_suppression_success_turn_count: slotSuppressionSuccessTurnCount,
      slot_ask_suppression_success_rate: slotAskSuppressionSuccessRate,
    },
    suppression_effectiveness: {
      suppressed_count: suppressibleSuppressedCount,
      detected_count: suppressibleDetectedCount,
      suppressed_ratio: ratio(suppressibleSuppressedCount, suppressibleDetectedCount),
    },
    retry_context_success_rate: retryContextSuccessRate,
    slot_ask_suppression_success_rate: slotAskSuppressionSuccessRate,
    decision_engine: {
      promotion_applied_count_by_action: normalized.promotion_applied_count_by_action,
      promotion_effectiveness_rate: ratio(effectiveTotal, effectiveTotal + ineffectiveTotal),
      promotion_effective_count: effectiveTotal,
      promotion_ineffective_count: ineffectiveTotal,
    },
    reroute_quality: {
      reroute_applied_count: normalized.reroute_applied_count,
      reroute_effective_rate: ratio(normalized.reroute_effective_count, normalized.reroute_applied_count),
      reroute_ineffective_rate: ratio(normalized.reroute_ineffective_count, normalized.reroute_applied_count),
      reroute_effective_count: normalized.reroute_effective_count,
      reroute_ineffective_count: normalized.reroute_ineffective_count,
    },
    usage_layer: {
      issue_detected_count_by_code: normalized.issue_detected_code_distribution,
      issue_exposed_count_by_code: normalized.issue_exposed_code_distribution,
      raw_issue_distribution: normalized.issue_detected_code_distribution,
      user_visible_issue_distribution: normalized.issue_exposed_code_distribution,
      usage_issue_code_distribution: normalized.issue_exposed_code_distribution,
      response_continuity_score_distribution: normalized.response_continuity_score_distribution,
    },
  };
}

function buildGlobalSummary({
  aggregates = null,
  aggregated_metrics = null,
  final_promotion_state = null,
} = {}) {
  const normalizedAggregates = toObject(aggregates) || initializeAggregates();
  const metrics = toObject(aggregated_metrics) || buildAggregatedMetrics(normalizedAggregates);
  const actionPerformance = buildActionPerformance(normalizedAggregates);
  const bestWorst = resolveBestWorstPromotionAction(actionPerformance);
  const pauseRecommendations = buildPromotionPauseRecommendations(actionPerformance);
  const topDetectedIssues = topDistribution(normalizedAggregates.issue_detected_code_distribution, DEFAULT_USAGE_EVAL_TOP_N)
    .map((item) => ({
      issue_code: item.key,
      count: item.count,
      rate: ratio(item.count, normalizedAggregates.total_turns),
    }));
  const topUserVisibleIssues = topDistribution(normalizedAggregates.issue_exposed_code_distribution, DEFAULT_USAGE_EVAL_TOP_N)
    .map((item) => ({
      issue_code: item.key,
      count: item.count,
      rate: ratio(item.count, normalizedAggregates.total_turns),
    }));
  const divergencePatterns = topDistribution(normalizedAggregates.divergence_pattern_distribution, DEFAULT_USAGE_EVAL_TOP_N)
    .map((item) => ({
      pattern: item.key,
      count: item.count,
      rate: ratio(item.count, normalizedAggregates.total_turns),
    }));
  const rollbackDisabledActions = listDecisionPromotionRollbackDisabledActions({
    state: final_promotion_state,
    promotion_policy: resolvePromotionControlSurface(),
  });
  const suppressionEffectiveness = toObject(metrics?.suppression_effectiveness) || {
    suppressed_count: Number(normalizedAggregates.suppressible_issue_suppressed_count || 0),
    detected_count: Number(normalizedAggregates.suppressible_issue_detected_count || 0),
    suppressed_ratio: ratio(
      Number(normalizedAggregates.suppressible_issue_suppressed_count || 0),
      Number(normalizedAggregates.suppressible_issue_detected_count || 0),
    ),
  };
  return {
    raw_issue_distribution: normalizedAggregates.issue_detected_code_distribution,
    user_visible_issue_distribution: normalizedAggregates.issue_exposed_code_distribution,
    top_detected_issues: topDetectedIssues,
    top_user_visible_issues: topUserVisibleIssues,
    top_usage_issues: topUserVisibleIssues,
    most_common_divergence_pattern: divergencePatterns[0] || null,
    divergence_pattern_distribution: divergencePatterns,
    action_promotion_performance: {
      best_action: bestWorst.best_action,
      worst_action: bestWorst.worst_action,
      by_action: actionPerformance,
    },
    should_pause_promotion: pauseRecommendations.length > 0 || rollbackDisabledActions.length > 0,
    pause_promotion_actions: Array.from(new Set([
      ...pauseRecommendations.map((entry) => entry.action),
      ...rollbackDisabledActions,
    ])).sort((left, right) => left.localeCompare(right)),
    pause_promotion_recommendations: pauseRecommendations,
    rollback_disabled_actions: rollbackDisabledActions,
    suppression_effectiveness: suppressionEffectiveness,
    retry_context_success_rate: Number(metrics?.retry_context_quality?.retry_context_success_rate || 0),
    slot_ask_suppression_success_rate: Number(metrics?.slot_ask_suppression_quality?.slot_ask_suppression_success_rate || 0),
    overall_intelligence_signal: resolveOverallIntelligenceSignal(metrics),
  };
}

export function validateUsageEvalCases(cases = []) {
  const issues = [];
  if (!Array.isArray(cases)) {
    return [
      "cases_must_be_array",
    ];
  }
  const seenCaseIds = new Set();
  for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
    const testCase = cases[caseIndex];
    const normalizedCase = toObject(testCase);
    if (!normalizedCase) {
      issues.push(`case[${caseIndex}]_must_be_object`);
      continue;
    }
    const caseId = cleanText(normalizedCase.case_id || "");
    const description = cleanText(normalizedCase.description || "");
    if (!caseId) {
      issues.push(`case[${caseIndex}]_missing_case_id`);
    } else if (seenCaseIds.has(caseId)) {
      issues.push(`case_id_duplicate:${caseId}`);
    } else {
      seenCaseIds.add(caseId);
    }
    if (!description) {
      issues.push(`case[${caseIndex}]_missing_description`);
    }
    const turns = toArray(normalizedCase.turns);
    if (turns.length === 0) {
      issues.push(`case[${caseIndex}]_turns_required`);
      continue;
    }
    for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
      const turn = toObject(turns[turnIndex]);
      if (!turn) {
        issues.push(`case[${caseIndex}].turns[${turnIndex}]_must_be_object`);
        continue;
      }
      const userInput = cleanText(turn.user_input || "");
      if (!userInput) {
        issues.push(`case[${caseIndex}].turns[${turnIndex}]_missing_user_input`);
      }
      if (turn.expected_behavior_hint !== undefined && turn.expected_behavior_hint !== null) {
        const hint = cleanText(turn.expected_behavior_hint || "");
        if (!hint) {
          issues.push(`case[${caseIndex}].turns[${turnIndex}]_expected_behavior_hint_must_be_non_empty_string`);
        }
      }
    }
  }
  return issues;
}

export function loadUsageEvalCasesFromJson(filePath = DEFAULT_USAGE_EVAL_FIXTURE_PATH) {
  const resolvedPath = filePath instanceof URL
    ? filePath
    : path.isAbsolute(String(filePath || ""))
      ? path.resolve(String(filePath))
      : path.resolve(process.cwd(), String(filePath || ""));
  const raw = readFileSync(resolvedPath, "utf8");
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    return {
      source_path: resolvedPath instanceof URL ? resolvedPath.pathname : resolvedPath,
      cases: parsed,
    };
  }
  if (toObject(parsed)?.cases && Array.isArray(parsed.cases)) {
    return {
      source_path: resolvedPath instanceof URL ? resolvedPath.pathname : resolvedPath,
      cases: parsed.cases,
    };
  }
  return {
    source_path: resolvedPath instanceof URL ? resolvedPath.pathname : resolvedPath,
    cases: [],
  };
}

function runUsageEvalTurn({
  test_case = null,
  turn = null,
  turn_index = 0,
  state = null,
} = {}) {
  const hintTags = normalizeHintTags(turn?.expected_behavior_hint || "");
  const mode = inferTurnMode({
    turn,
    state,
    hintTags,
  });
  const expectedContinuation = resolveExpectedContinuation({
    mode,
  });
  const slotResumeAttempt = resolveSlotResumeAttempt({
    mode,
    hint_tags: hintTags,
  });
  const advisorAction = resolveAdvisorAction({
    mode,
  });
  const actualAction = resolveActualAction({
    mode,
    hint_tags: hintTags,
    advisor_action: advisorAction,
  });
  const readiness = resolveModeReadiness({
    mode,
    hint_tags: hintTags,
  });
  const recovery = buildDefaultRecovery({
    mode,
    retry_count: state.retry_count,
  });
  const rerouteContext = resolveRerouteContext({
    mode,
    state,
    hint_tags: hintTags,
  });
  let userResponse = buildUserResponse({
    mode,
    hint_tags: hintTags,
    owner_agent: state.current_owner_agent,
    reroute_target: rerouteContext?.reroute_target || "runtime_agent",
    user_input: turn?.user_input,
  });
  const taskPlan = buildDefaultTaskPlan({
    case_id: test_case?.case_id,
    turn_index,
    mode,
    owner_agent: mode === TURN_MODE.REROUTE
      ? rerouteContext?.reroute_target || "runtime_agent"
      : state.current_owner_agent,
    hint_tags: hintTags,
  });
  const artifact = buildDefaultArtifact();
  const baseOutcome = buildOutcomeInput({
    mode,
    readiness,
    recovery,
    userResponse,
    hint_tags: hintTags,
  });
  const advisor = {
    recommended_next_action: advisorAction,
    decision_reason_codes: mode === TURN_MODE.REROUTE
      ? ["owner_mismatch", "capability_gap"]
      : mode === TURN_MODE.FAIL
        ? ["plan_invalidated", "outcome_failed"]
        : mode === TURN_MODE.RETRY
          ? ["retry_worthy", "tool_error"]
          : mode === TURN_MODE.SLOT_MISSING || hintTags.has("redundant_ask")
            ? ["missing_slot"]
            : ["normal_progression"],
    decision_confidence: mode === TURN_MODE.START || mode === TURN_MODE.CONTINUATION ? "medium" : "high",
  };
  const advisorAlignment = evaluateAdvisorAlignment({
    advisor_action: advisorAction,
    actual_action: actualAction,
    readiness,
    outcome: baseOutcome,
    recovery,
    routing_overrode_advisor: hintTags.has("routing_override"),
    recovery_overrode_advisor: hintTags.has("recovery_override"),
  });
  const unresolvedSlotsForGate = mode === TURN_MODE.SLOT_FILLED_RESUME
    ? []
    : mode === TURN_MODE.SLOT_MISSING && !hintTags.has("redundant_ask")
      ? ["doc_id"]
      : toArray(state.unresolved_slots);
  const slotStateForGate = mode === TURN_MODE.SLOT_FILLED_RESUME
    ? [{ slot_key: "doc_id", status: "filled" }]
    : toArray(state?.slot_state);
  const currentStepActionForGate = mode === TURN_MODE.CONTINUATION_MISSED
    ? ""
    : cleanText(state?.next_best_action || "search_company_brain_docs");
  const nextBestActionForGate = mode === TURN_MODE.CONTINUATION_MISSED
    ? ""
    : cleanText(state?.next_best_action || "search_company_brain_docs");
  const decisionPromotion = evaluateDecisionEnginePromotion({
    advisor,
    advisor_alignment: advisorAlignment,
    readiness,
    outcome: baseOutcome,
    recovery,
    artifact,
    task_plan: taskPlan,
    evidence_complete: true,
    promotion_policy: resolvePromotionControlSurface(),
    decision_scoreboard: mode === TURN_MODE.REROUTE
      ? buildHealthyRerouteScoreboard()
      : null,
    reroute_context: rerouteContext,
    ask_user_gate: {
      task_phase: mode === TURN_MODE.SLOT_MISSING || mode === TURN_MODE.SLOT_FILLED_RESUME
        ? "waiting_user"
        : cleanText(state?.task_phase || "executing"),
      required_slots: toArray(readiness?.missing_slots),
      unresolved_slots: unresolvedSlotsForGate,
      slot_state: slotStateForGate,
      current_step_action: currentStepActionForGate || null,
      next_best_action: nextBestActionForGate || null,
      current_step_resume_available: Boolean(currentStepActionForGate),
      next_best_action_available: Boolean(nextBestActionForGate),
      resume_action_available: Boolean(currentStepActionForGate || nextBestActionForGate),
      slot_suppressed_ask: hintTags.has("redundant_ask"),
      waiting_user_all_required_slots_filled: mode === TURN_MODE.SLOT_FILLED_RESUME,
      continuation_ready: mode === TURN_MODE.SLOT_FILLED_RESUME || mode === TURN_MODE.CONTINUATION,
    },
  });
  const finalAuditOutcome = resolveFinalAuditOutcome({
    mode,
    hint_tags: hintTags,
    promotion_decision: decisionPromotion,
    base_outcome: baseOutcome,
  });
  const auditRecord = buildDecisionPromotionAuditRecord({
    promoted_action: cleanText(decisionPromotion?.promoted_action || ""),
    promotion_decision: decisionPromotion,
    advisor,
    advisor_alignment: advisorAlignment,
    readiness,
    outcome: baseOutcome,
    recovery,
    artifact,
    task_plan: taskPlan,
    final_step_status: finalAuditOutcome.final_step_status,
    outcome_status: finalAuditOutcome.outcome_status,
    user_visible_completeness: finalAuditOutcome.user_visible_completeness,
  });
  const auditSafety = applyDecisionPromotionAuditSafety({
    state: state.promotion_audit_state,
    audit_record: auditRecord,
    promotion_policy: resolvePromotionControlSurface(),
  });
  const updatedAuditRecord = toObject(auditSafety.audit_record) || auditRecord;
  const workingMemory = buildWorkingMemoryForUsage({
    state,
    mode,
    hint_tags: hintTags,
  });
  const unresolvedSlots = unresolvedSlotsForGate;
  const usageSlotState = mode === TURN_MODE.SLOT_FILLED_RESUME
    ? [{ slot_key: "doc_id", status: "filled" }]
    : mode === TURN_MODE.SLOT_MISSING && hintTags.has("redundant_ask")
      ? [{ slot_key: "doc_id", status: "filled" }]
      : toArray(workingMemory?.slot_state);
  const usageWorkingMemory = {
    ...workingMemory,
    task_phase: mode === TURN_MODE.SLOT_FILLED_RESUME
      ? "waiting_user"
      : workingMemory.task_phase,
    unresolved_slots: unresolvedSlots,
    slot_state: usageSlotState,
  };
  const selectedActionForUsage = mode === TURN_MODE.CONTINUATION_MISSED
    ? ""
    : actualAction;
  const usageObservability = {
    ...readiness,
    readiness,
    recovery_action: cleanText(recovery.recovery_action || ""),
    recommended_action: cleanText(readiness.recommended_action || ""),
    resumed_from_waiting_user: mode === TURN_MODE.SLOT_FILLED_RESUME,
    resumed_from_retry: mode === TURN_MODE.RETRY,
    agent_handoff: mode === TURN_MODE.REROUTE
      ? {
          from: state.current_owner_agent,
          to: rerouteContext?.reroute_target || "runtime_agent",
          reason: "owner_mismatch",
        }
      : null,
    decision_promotion: decisionPromotion,
  };
  const usagePassInput = {
    requestText: cleanText(turn?.user_input || ""),
    taskType: mode === TURN_MODE.TOPIC_SWITCH ? "runtime_info" : state.task_type,
    workingMemory: usageWorkingMemory,
    unresolvedSlots,
    currentPlanStep: buildCurrentPlanStep({
      state,
      mode,
    }),
    selectedAction: selectedActionForUsage,
    routingReason: mode === TURN_MODE.SLOT_FILLED_RESUME
      ? "working_memory_waiting_user_resume_plan_step"
      : mode === TURN_MODE.RETRY
        ? "decision_engine_promotion_retry"
        : mode === TURN_MODE.REROUTE
          ? "decision_engine_promotion_reroute"
          : mode === TURN_MODE.CONTINUATION
            ? "working_memory_follow_up"
            : "selector_new_task",
    observability: usageObservability,
    userResponse,
  };
  const preCopyUsagePass = evaluateUsageLayerIntelligencePass(usagePassInput);
  userResponse = applyUsageLayerContinuityCopy({
    userResponse,
    diagnostics: toObject(preCopyUsagePass?.diagnostics),
    observability: usageObservability,
  });
  const usagePass = evaluateUsageLayerIntelligencePass({
    ...usagePassInput,
    userResponse,
  });
  const turnResult = buildTurnResult({
    case_id: cleanText(test_case?.case_id || ""),
    turn_index,
    user_input: turn?.user_input || "",
    expected_behavior_hint: turn?.expected_behavior_hint || "",
    mode,
    expected_continuation: expectedContinuation,
    slot_resume_attempt: slotResumeAttempt,
    advisor_action: advisorAction,
    actual_action: actualAction,
    usage_pass: usagePass,
    readiness,
    outcome: baseOutcome,
    advisor_alignment: advisorAlignment,
    decision_promotion: decisionPromotion,
    promotion_audit: updatedAuditRecord,
    user_response: userResponse,
    slot_state_snapshot: usageSlotState,
    unresolved_slots_snapshot: toArray(unresolvedSlots),
  });
  const nextState = applyStateTransition({
    state: {
      ...state,
      promotion_audit_state: toObject(auditSafety.next_state) || state.promotion_audit_state,
    },
    mode,
    hint_tags: hintTags,
    promoted_action: decisionPromotion.promoted_action,
    promotion_applied: decisionPromotion.promotion_applied === true,
  });
  nextState.promotion_audit_state = toObject(auditSafety.next_state) || state.promotion_audit_state;
  return {
    turn_result: turnResult,
    next_state: nextState,
  };
}

export function runUsageEvalCase(testCase = null) {
  const normalizedCase = toObject(testCase);
  if (!normalizedCase) {
    return {
      ok: false,
      fail_closed: true,
      error_type: "contract_violation",
      validation_issues: ["case_must_be_object"],
      case_id: null,
      turns: [],
      summary: null,
      final_promotion_state: createDecisionPromotionAuditState(),
    };
  }
  const validationIssues = validateUsageEvalCases([normalizedCase]);
  if (validationIssues.length > 0) {
    return {
      ok: false,
      fail_closed: true,
      error_type: "contract_violation",
      validation_issues: validationIssues,
      case_id: cleanText(normalizedCase.case_id || "") || null,
      turns: [],
      summary: null,
      final_promotion_state: createDecisionPromotionAuditState(),
    };
  }
  let state = createInitialCaseState();
  const turns = [];
  const inputTurns = toArray(normalizedCase.turns);
  for (let turnIndex = 0; turnIndex < inputTurns.length; turnIndex += 1) {
    const turn = toObject(inputTurns[turnIndex]) || {};
    const turnExecution = runUsageEvalTurn({
      test_case: normalizedCase,
      turn,
      turn_index: turnIndex,
      state,
    });
    turns.push(turnExecution.turn_result);
    state = turnExecution.next_state;
  }
  const caseResult = {
    ok: true,
    fail_closed: false,
    case_id: cleanText(normalizedCase.case_id || ""),
    description: cleanText(normalizedCase.description || ""),
    turns,
    final_promotion_state: state.promotion_audit_state,
  };
  return {
    ...caseResult,
    summary: summarizeCaseTurnResults(caseResult),
  };
}

export function runUsageEvalRunner({
  cases = [],
  case_count_target = {
    min: DEFAULT_USAGE_EVAL_CASE_COUNT_MIN,
    max: DEFAULT_USAGE_EVAL_CASE_COUNT_MAX,
  },
} = {}) {
  const normalizedCases = toArray(cases);
  const validationIssues = validateUsageEvalCases(normalizedCases);
  if (validationIssues.length > 0) {
    return {
      ok: false,
      fail_closed: true,
      runner_version: USAGE_EVAL_RUNNER_VERSION,
      error_type: "contract_violation",
      validation_issues: validationIssues,
      case_count_target: {
        min: Number(case_count_target?.min || DEFAULT_USAGE_EVAL_CASE_COUNT_MIN),
        max: Number(case_count_target?.max || DEFAULT_USAGE_EVAL_CASE_COUNT_MAX),
      },
      total_cases: normalizedCases.length,
      total_turns: 0,
      cases: [],
      per_case_summary: [],
      aggregated_metrics: buildAggregatedMetrics(initializeAggregates()),
      summary: buildGlobalSummary({
        aggregates: initializeAggregates(),
        aggregated_metrics: buildAggregatedMetrics(initializeAggregates()),
        final_promotion_state: createDecisionPromotionAuditState(),
      }),
    };
  }
  const caseCountWarnings = [];
  const minCases = Number(case_count_target?.min || DEFAULT_USAGE_EVAL_CASE_COUNT_MIN);
  const maxCases = Number(case_count_target?.max || DEFAULT_USAGE_EVAL_CASE_COUNT_MAX);
  if (Number.isFinite(minCases) && normalizedCases.length < minCases) {
    caseCountWarnings.push(`case_count_below_target_min:${normalizedCases.length}<${minCases}`);
  }
  if (Number.isFinite(maxCases) && normalizedCases.length > maxCases) {
    caseCountWarnings.push(`case_count_above_target_max:${normalizedCases.length}>${maxCases}`);
  }
  let aggregates = initializeAggregates();
  const results = [];
  const perCaseSummary = [];
  let promotionState = createDecisionPromotionAuditState();
  for (const testCase of normalizedCases) {
    const result = runUsageEvalCase(testCase);
    if (result.ok !== true) {
      return {
        ok: false,
        fail_closed: true,
        runner_version: USAGE_EVAL_RUNNER_VERSION,
        error_type: "contract_violation",
        validation_issues: result.validation_issues || ["case_validation_failed"],
        total_cases: normalizedCases.length,
        total_turns: 0,
        cases: [],
        per_case_summary: [],
        aggregated_metrics: buildAggregatedMetrics(initializeAggregates()),
        summary: buildGlobalSummary({
          aggregates: initializeAggregates(),
          aggregated_metrics: buildAggregatedMetrics(initializeAggregates()),
          final_promotion_state: createDecisionPromotionAuditState(),
        }),
      };
    }
    results.push(result);
    perCaseSummary.push(result.summary);
    for (const turn of toArray(result.turns)) {
      aggregates = accumulateTurnMetrics(aggregates, turn);
      const auditRecord = toObject(turn?.promotion_audit);
      if (auditRecord) {
        const auditUpdate = applyDecisionPromotionAuditSafety({
          state: promotionState,
          audit_record: auditRecord,
          promotion_policy: resolvePromotionControlSurface(),
        });
        promotionState = toObject(auditUpdate?.next_state) || promotionState;
      }
    }
  }
  const aggregatedMetrics = buildAggregatedMetrics(aggregates);
  return {
    ok: true,
    fail_closed: false,
    runner_version: USAGE_EVAL_RUNNER_VERSION,
    generated_at: new Date().toISOString(),
    case_count_target: {
      min: minCases,
      max: maxCases,
    },
    case_count_warnings: caseCountWarnings,
    total_cases: results.length,
    total_turns: aggregates.total_turns,
    cases: results,
    per_case_summary: perCaseSummary,
    aggregated_metrics: aggregatedMetrics,
    summary: buildGlobalSummary({
      aggregates,
      aggregated_metrics: aggregatedMetrics,
      final_promotion_state: promotionState,
    }),
  };
}

function parseRunnerArgs(argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  const parsed = {
    fixtures: DEFAULT_USAGE_EVAL_FIXTURE_PATH,
    json: true,
    target_min: DEFAULT_USAGE_EVAL_CASE_COUNT_MIN,
    target_max: DEFAULT_USAGE_EVAL_CASE_COUNT_MAX,
  };
  for (let index = 0; index < args.length; index += 1) {
    const token = cleanText(args[index] || "");
    if (token === "--fixtures" && args[index + 1]) {
      parsed.fixtures = path.resolve(process.cwd(), String(args[index + 1]));
      index += 1;
      continue;
    }
    if (token === "--target-min" && args[index + 1]) {
      parsed.target_min = Math.max(1, Number(args[index + 1]) || DEFAULT_USAGE_EVAL_CASE_COUNT_MIN);
      index += 1;
      continue;
    }
    if (token === "--target-max" && args[index + 1]) {
      parsed.target_max = Math.max(1, Number(args[index + 1]) || DEFAULT_USAGE_EVAL_CASE_COUNT_MAX);
      index += 1;
      continue;
    }
    if (token === "--text") {
      parsed.json = false;
    }
  }
  return parsed;
}

function formatRunnerTextReport(run = null) {
  const report = toObject(run) || {};
  const lines = [
    "Usage Eval Runner",
    `status: ${report.ok ? "ok" : "fail_closed"}`,
    `runner_version: ${cleanText(report.runner_version || "") || USAGE_EVAL_RUNNER_VERSION}`,
    `cases: ${Number(report.total_cases || 0)} | turns: ${Number(report.total_turns || 0)}`,
  ];
  const continuation = toObject(report.aggregated_metrics?.continuation_quality) || {};
  const redundant = toObject(report.aggregated_metrics?.redundant_ask) || {};
  const slotResume = toObject(report.aggregated_metrics?.slot_resume_quality) || {};
  const decision = toObject(report.aggregated_metrics?.decision_engine) || {};
  const reroute = toObject(report.aggregated_metrics?.reroute_quality) || {};
  lines.push(`continuation_rate=${Number(continuation.continuation_rate || 0).toFixed(4)} | mistaken_new_task_rate=${Number(continuation.mistaken_new_task_rate || 0).toFixed(4)}`);
  lines.push(`redundant_question_rate=${Number(redundant.redundant_question_rate || 0).toFixed(4)} | slot_fill_resume_success_rate=${Number(slotResume.slot_fill_resume_success_rate || 0).toFixed(4)}`);
  lines.push(`promotion_effectiveness_rate=${Number(decision.promotion_effectiveness_rate || 0).toFixed(4)} | reroute_effective_rate=${Number(reroute.reroute_effective_rate || 0).toFixed(4)}`);
  lines.push(`retry_context_success_rate=${Number(report.summary?.retry_context_success_rate || 0).toFixed(4)} | slot_ask_suppression_success_rate=${Number(report.summary?.slot_ask_suppression_success_rate || 0).toFixed(4)}`);
  lines.push(`overall_intelligence_signal=${cleanText(report.summary?.overall_intelligence_signal || "") || "low"}`);
  const topDetectedIssue = toArray(report.summary?.top_detected_issues)[0];
  if (topDetectedIssue) {
    lines.push(`top_detected_issue=${cleanText(topDetectedIssue.issue_code || "")}:${Number(topDetectedIssue.count || 0)}`);
  }
  const topUserVisibleIssue = toArray(report.summary?.top_user_visible_issues)[0];
  if (topUserVisibleIssue) {
    lines.push(`top_user_visible_issue=${cleanText(topUserVisibleIssue.issue_code || "")}:${Number(topUserVisibleIssue.count || 0)}`);
  }
  const suppression = toObject(report.summary?.suppression_effectiveness);
  if (suppression) {
    lines.push(`suppression_effectiveness=${Number(suppression.suppressed_count || 0)}/${Number(suppression.detected_count || 0)} (${Number(suppression.suppressed_ratio || 0).toFixed(4)})`);
  }
  const divergence = toObject(report.summary?.most_common_divergence_pattern);
  if (divergence) {
    lines.push(`top_divergence=${cleanText(divergence.pattern || "")}:${Number(divergence.count || 0)}`);
  }
  const bestAction = cleanText(report.summary?.action_promotion_performance?.best_action || "");
  const worstAction = cleanText(report.summary?.action_promotion_performance?.worst_action || "");
  lines.push(`promotion_best=${bestAction || "none"} | promotion_worst=${worstAction || "none"}`);
  const pauseActions = toArray(report.summary?.pause_promotion_actions).map((action) => cleanText(action)).filter(Boolean);
  lines.push(`pause_promotion_actions=${pauseActions.length > 0 ? `[${pauseActions.join(", ")}]` : "[]"}`);
  if (Array.isArray(report.case_count_warnings) && report.case_count_warnings.length > 0) {
    lines.push(`case_count_warnings=${report.case_count_warnings.join(", ")}`);
  }
  if (!report.ok) {
    lines.push(`error_type=${cleanText(report.error_type || "") || "contract_violation"}`);
    if (Array.isArray(report.validation_issues) && report.validation_issues.length > 0) {
      lines.push(`validation_issues=${report.validation_issues.join(", ")}`);
    }
  }
  return lines.join("\n");
}

function isDirectRun() {
  if (!process.argv[1]) {
    return false;
  }
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectRun()) {
  const args = parseRunnerArgs(process.argv.slice(2));
  try {
    const loaded = loadUsageEvalCasesFromJson(args.fixtures);
    const run = runUsageEvalRunner({
      cases: loaded.cases,
      case_count_target: {
        min: args.target_min,
        max: args.target_max,
      },
    });
    const output = {
      ...run,
      fixture_source_path: cleanText(loaded.source_path || ""),
    };
    if (args.json) {
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log(formatRunnerTextReport(output));
    }
  } catch (error) {
    const failClosed = {
      ok: false,
      fail_closed: true,
      runner_version: USAGE_EVAL_RUNNER_VERSION,
      error_type: "runtime_exception",
      message: cleanText(error?.message || "usage_eval_runner_failed"),
    };
    if (args.json) {
      console.log(JSON.stringify(failClosed, null, 2));
    } else {
      console.log(formatRunnerTextReport(failClosed));
    }
    process.exitCode = 1;
  }
}

import { minimaxTextModel } from "../config.mjs";
import { generateText as defaultGenerateText } from "../llm/generate-text.mjs";
import { cleanText } from "../message-intent-utils.mjs";
import { parseOpenClawJson } from "../openclaw-text-service.mjs";

const VALID_SKILL_INTENTS = Object.freeze([
  "skill_find_request",
  "skill_install_request",
  "skill_verify_request",
  "not_skill_task",
]);

function normalizeSkillIntent(value = "") {
  const normalized = cleanText(value);
  return VALID_SKILL_INTENTS.includes(normalized)
    ? normalized
    : "not_skill_task";
}

function normalizeReason(value = "") {
  return cleanText(value) || null;
}

export function extractExplicitSkillQueryHint(text = "") {
  const normalized = cleanText(text);
  if (!normalized) {
    return "";
  }

  const explicitPatterns = [
    /`([^`]+)`/,
    /「([^」]+)」/,
    /『([^』]+)』/,
    /"([^"]+)"/,
  ];

  for (const pattern of explicitPatterns) {
    const match = normalized.match(pattern);
    const candidate = cleanText(match?.[1] || "");
    if (candidate) {
      return candidate;
    }
  }

  const suffixMatch = normalized.match(
    /(?:skill|技能|能力)\s*[:：]?\s*([a-z0-9._/-]{2,64}|[\u4e00-\u9fff_a-z0-9.-]{2,64})/iu,
  );
  if (cleanText(suffixMatch?.[1] || "")) {
    return cleanText(suffixMatch[1]);
  }

  return "";
}

function normalizePlannerDecision(raw = {}, fallbackText = "") {
  const intent = normalizeSkillIntent(raw?.intent);
  const delegatedTask = raw?.is_delegated_task === true;
  const fallbackSkillQuery = extractExplicitSkillQueryHint(fallbackText) || cleanText(fallbackText);
  const skillQuery = cleanText(raw?.skill_query || raw?.skill_name || fallbackSkillQuery);

  if (!delegatedTask || intent === "not_skill_task") {
    return {
      ok: true,
      model: minimaxTextModel,
      is_delegated_task: false,
      intent: "not_skill_task",
      skill_query: "",
      reason: normalizeReason(raw?.reason) || "not_skill_task",
    };
  }

  return {
    ok: true,
    model: minimaxTextModel,
    is_delegated_task: true,
    intent,
    skill_query: skillQuery,
    reason: normalizeReason(raw?.reason) || "delegated_local_skill_task",
  };
}

export async function planPersonalDMSkillIntent({
  text = "",
  generateText = defaultGenerateText,
  signal = null,
  logger = null,
} = {}) {
  const normalizedText = cleanText(text);
  if (!normalizedText) {
    return {
      ok: true,
      model: minimaxTextModel,
      is_delegated_task: false,
      intent: "not_skill_task",
      skill_query: "",
      reason: "empty_text",
    };
  }

  const systemPrompt = [
    "你是 Lobster personal DM skill task planner。",
    "你的工作是判斷這則私聊是否在委派本機 skill 任務。",
    "只能輸出一個 JSON object。",
    "intent 只能是 skill_find_request、skill_install_request、skill_verify_request、not_skill_task。",
    "只有在使用者明確要你找 skill、安裝 skill、驗證 skill 時，才可輸出 skill_*。",
    "任何一般聊天、問候、能力詢問、非 skill 任務、模糊請求，都必須輸出 not_skill_task。",
    "skill_query 要盡量提取 skill 名稱或查詢詞；沒有就給空字串。",
  ].join("\n");

  const prompt = [
    "請判斷下面這則 personal DM：",
    "",
    `使用者訊息：${normalizedText}`,
    "",
    "輸出格式：",
    '{"is_delegated_task":true,"intent":"skill_find_request","skill_query":"find-skills","reason":"..."}',
  ].join("\n");

  try {
    const rawText = await generateText({
      systemPrompt,
      prompt,
      sessionIdSuffix: "personal-dm-skill-intent",
      temperature: 0,
      signal,
    });
    const parsed = parseOpenClawJson(rawText);
    const decision = normalizePlannerDecision(parsed, normalizedText);
    logger?.info?.("personal_dm_skill_intent_classified", {
      model: decision.model,
      intent: decision.intent,
      is_delegated_task: decision.is_delegated_task,
      skill_query: decision.skill_query || null,
      reason: decision.reason,
    });
    return decision;
  } catch (error) {
    logger?.warn?.("personal_dm_skill_intent_failed_closed", {
      model: minimaxTextModel,
      error: cleanText(error?.code || error?.message) || "classification_failed",
    });
    return {
      ok: true,
      model: minimaxTextModel,
      is_delegated_task: false,
      intent: "not_skill_task",
      skill_query: "",
      reason: "classifier_failed_closed",
    };
  }
}

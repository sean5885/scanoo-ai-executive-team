import { generateText as defaultGenerateText } from "../llm/generate-text.mjs";
import { buildAnswer, buildNoResultAnswer, cleanSnippet } from "./answer-builder.mjs";

const SUMMARY_SYSTEM_PROMPT = [
  "你是企業知識助理。",
  "請根據提供的檢索片段整理 2 到 3 句自然語言摘要。",
  "可以合併重點，但不可捏造來源未提供的事實。",
  "不要輸出條列、不要逐條抄寫、不要加上前言或結語。",
].join("\n");

function buildSummaryContext(results = []) {
  return results.map((result, index) => (
    `${index + 1}. ${result.id}：${cleanSnippet(result.snippet)}`
  )).join("\n");
}

export function buildSummaryPrompt({ keyword, results } = {}) {
  const normalizedKeyword = typeof keyword === "string" ? keyword.trim() : "";
  const context = buildSummaryContext(results);

  return [
    `查詢主題：${normalizedKeyword || "未提供"}`,
    "",
    "請根據以下檢索結果整理重點摘要。",
    "",
    "要求：",
    "- 用自然語言，像人講話。",
    "- 可以合併重點，但不要照抄每一條。",
    "- 只根據提供內容回答，不要補未出現的事實。",
    "- 輸出 2 到 3 句，不要條列。",
    "",
    "資料：",
    context,
  ].join("\n");
}

function normalizeSummaryText(text) {
  return String(text || "").trim().replace(/\n{3,}/g, "\n\n");
}

export async function summarizeWithMinimax({
  keyword,
  results,
  generateText = defaultGenerateText,
  signal = null,
} = {}) {
  const normalizedKeyword = typeof keyword === "string" ? keyword.trim() : "";
  const rows = Array.isArray(results) ? results : [];

  if (!rows.length) {
    return buildNoResultAnswer(normalizedKeyword);
  }

  const fallbackAnswer = buildAnswer(normalizedKeyword, rows);
  const prompt = buildSummaryPrompt({ keyword: normalizedKeyword, results: rows });

  try {
    const request = {
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      prompt,
      sessionIdSuffix: `planner-summary-${normalizedKeyword || "default"}`,
      signal,
    };

    const text = await generateText(request);
    const normalizedText = normalizeSummaryText(text);
    if (!normalizedText) {
      return fallbackAnswer;
    }
    return normalizedText;
  } catch {
    return fallbackAnswer;
  }
}

import {
  llmApiKey,
  llmBaseUrl,
  llmModel,
  llmTemperature,
  llmTopP,
} from "../config.mjs";
import { callOpenClawTextGeneration, normalizeAbortSignal } from "../openclaw-text-service.mjs";
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

async function defaultGenerateSummaryText({
  systemPrompt,
  prompt,
  keyword,
  signal = null,
} = {}) {
  const abortSignal = normalizeAbortSignal(signal);

  if (!llmApiKey) {
    const request = {
      systemPrompt,
      prompt,
      sessionIdSuffix: `planner-summary-${keyword || "default"}`,
    };

    if (abortSignal) {
      request.signal = abortSignal;
    }

    return callOpenClawTextGeneration(request);
  }

  const requestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${llmApiKey}`,
    },
    body: JSON.stringify({
      model: llmModel,
      temperature: llmTemperature,
      top_p: llmTopP,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
    }),
  };

  if (abortSignal) {
    requestInit.signal = abortSignal;
  }

  const response = await fetch(`${llmBaseUrl}/chat/completions`, requestInit);

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || `planner_summary_llm_failed:${response.status}`);
  }

  return data?.choices?.[0]?.message?.content || "";
}

function normalizeSummaryText(text) {
  return String(text || "").trim().replace(/\n{3,}/g, "\n\n");
}

export async function summarizeWithMinimax({
  keyword,
  results,
  generateText = defaultGenerateSummaryText,
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
    console.log("[LLM] start summarize");
    const request = {
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      prompt,
      keyword: normalizedKeyword,
    };

    const abortSignal = normalizeAbortSignal(signal);

    if (abortSignal) {
      request.signal = abortSignal;
    }

    const text = await generateText(request);
    console.log("[LLM] raw result:", text);
    const normalizedText = normalizeSummaryText(text);
    if (!normalizedText) {
      console.log("[LLM] empty result -> fallback");
      return fallbackAnswer;
    }
    console.log("[LLM] success");
    return normalizedText;
  } catch (error) {
    console.log("[LLM] error during summarize:", error?.message || error);
    console.log("[LLM] provider/model debug:", {
      LLM_PROVIDER: process.env.LLM_PROVIDER,
      LLM_MODEL: process.env.LLM_MODEL,
      MINIMAX_TEXT_MODEL: process.env.MINIMAX_TEXT_MODEL,
      has_LLM_API_KEY: Boolean(process.env.LLM_API_KEY),
      has_MINIMAX_API_KEY: Boolean(process.env.MINIMAX_API_KEY),
    });
    return fallbackAnswer;
  }
}

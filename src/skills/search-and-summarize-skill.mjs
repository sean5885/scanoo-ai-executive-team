import { cleanText } from "../message-intent-utils.mjs";
import {
  getReadSourceSnippet,
  getReadSourceTitle,
  getReadSourceUrl,
} from "../read-source-schema.mjs";
import { runRead } from "../read-runtime.mjs";
import { createSkillDefinition } from "../skill-contract.mjs";

const DEFAULT_LIMIT = 5;
const DEFAULT_SOURCE_PREVIEW_LIMIT = 3;

function normalizePositiveInteger(value, fallback = DEFAULT_LIMIT) {
  const normalized = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : fallback;
}

function summarizeSnippet(text = "", maxLength = 120) {
  const normalized = cleanText(String(text || "").replace(/\s+/g, " "));
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength).trim()}...`;
}

function buildSourcePreview(item = {}) {
  return {
    id: cleanText(item.id) || null,
    title: getReadSourceTitle(item) || "未命名來源",
    url: getReadSourceUrl(item) || null,
    snippet: summarizeSnippet(getReadSourceSnippet(item)),
  };
}

function buildDeterministicSummary({ query = "", sources = [], totalHits = 0 } = {}) {
  const normalizedQuery = cleanText(query);
  if (!sources.length) {
    return normalizedQuery
      ? `目前找不到和「${normalizedQuery}」直接相關的知識內容。`
      : "目前找不到可摘要的知識內容。";
  }

  const sourceLines = sources
    .map((source, index) => `${index + 1}. ${source.title}: ${source.snippet || "沒有可用摘要片段。"}`)
    .join("\n");

  return normalizedQuery
    ? `找到 ${totalHits} 筆和「${normalizedQuery}」相關的知識片段。\n${sourceLines}`
    : `找到 ${totalHits} 筆相關知識片段。\n${sourceLines}`;
}

function buildLimitations({ totalHits = 0, previewCount = 0 } = {}) {
  const limitations = [];
  if (totalHits === 0) {
    limitations.push("目前索引結果為 0，無法提供來源摘要。");
  }
  if (totalHits > previewCount && previewCount > 0) {
    limitations.push(`僅摘要前 ${previewCount} 筆來源，其餘結果未展開。`);
  }
  return limitations;
}

function buildCanonicalReadRequest({
  accountId = "",
  query = "",
  limit = DEFAULT_LIMIT,
  pathname = "",
  readerOverrides = null,
} = {}) {
  return {
    action: "search_knowledge_base",
    account_id: cleanText(accountId) || "",
    payload: {
      q: cleanText(query) || "",
      limit,
      top_k: limit,
    },
    context: {
      pathname: cleanText(pathname) || "internal:skill/search_and_summarize",
      primary_authority: "index",
      ...(readerOverrides && typeof readerOverrides === "object" && !Array.isArray(readerOverrides)
        ? { reader_overrides: readerOverrides }
        : {}),
    },
  };
}

export const searchAndSummarizeSkill = createSkillDefinition({
  name: "search_and_summarize",
  input_schema: {
    type: "object",
    required: ["account_id", "query"],
    properties: {
      account_id: { type: "string" },
      query: { type: "string" },
      limit: { type: ["number", "null"] },
      pathname: { type: ["string", "null"] },
      reader_overrides: { type: ["object", "null"] },
    },
  },
  output_schema: {
    type: "object",
    required: ["query", "summary", "hits", "found", "sources", "limitations"],
    properties: {
      query: { type: "string" },
      summary: { type: "string" },
      hits: { type: "number" },
      found: { type: "boolean" },
      limitations: {
        type: "array",
        items: { type: "string" },
      },
      sources: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "title", "url", "snippet"],
          properties: {
            id: { type: ["string", "null"] },
            title: { type: "string" },
            url: { type: ["string", "null"] },
            snippet: { type: "string" },
          },
        },
      },
    },
  },
  allowed_side_effects: {
    read: ["search_knowledge_base"],
    write: [],
  },
  skill_class: "read_only",
  runtime_access: ["read_runtime"],
  failure_mode: "fail_closed",
  async run({ input, logger }) {
    const accountId = cleanText(input?.account_id);
    const query = cleanText(input?.query);
    const limit = normalizePositiveInteger(input?.limit, DEFAULT_LIMIT);

    if (!accountId || !query) {
      return {
        ok: false,
        error: "contract_violation",
        details: {
          phase: "input_validation",
          violations: [
            ...(!accountId
              ? [{
                type: "required",
                code: "missing_required",
                path: "$input.account_id",
                expected: "non_empty_string",
                actual: "empty",
                message: "Missing required field $input.account_id.",
              }]
              : []),
            ...(!query
              ? [{
                type: "required",
                code: "missing_required",
                path: "$input.query",
                expected: "non_empty_string",
                actual: "empty",
                message: "Missing required field $input.query.",
              }]
              : []),
          ],
        },
      };
    }

    const readExecution = await runRead({
      canonicalRequest: buildCanonicalReadRequest({
        accountId,
        query,
        limit,
        pathname: input?.pathname,
        readerOverrides: input?.reader_overrides,
      }),
      logger,
    });

    const sideEffects = [
      {
        mode: "read",
        action: "search_knowledge_base",
        runtime: "read-runtime",
        authority: cleanText(readExecution?.meta?.primary_authority) || null,
      },
    ];

    if (readExecution?.ok !== true) {
      return {
        ok: false,
        error: cleanText(readExecution?.error) || "runtime_exception",
        side_effects: sideEffects,
        details: {
          phase: "read_runtime",
          authorities_attempted: Array.isArray(readExecution?.authorities_attempted)
            ? readExecution.authorities_attempted
            : [],
        },
      };
    }

    const items = Array.isArray(readExecution?.result?.data?.items)
      ? readExecution.result.data.items
      : [];
    const sources = items
      .slice(0, DEFAULT_SOURCE_PREVIEW_LIMIT)
      .map((item) => buildSourcePreview(item));

    return {
      ok: true,
      side_effects: sideEffects,
      output: {
        query,
        summary: buildDeterministicSummary({
          query,
          sources,
          totalHits: items.length,
        }),
        hits: items.length,
        found: items.length > 0,
        sources,
        limitations: buildLimitations({
          totalHits: items.length,
          previewCount: sources.length,
        }),
      },
    };
  },
});

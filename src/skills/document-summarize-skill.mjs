export const SKILL_CONTRACT = Object.freeze({
  intent: "Summarize one company-brain document detail into deterministic read-only skill output.",
  success_criteria: "Return a fail-closed read-only result with doc_id, title, summary, hits, found, sources, and limitations after get_company_brain_doc_detail succeeds.",
  failure_criteria: "Return contract_violation when account_id or doc_id is missing, or fail closed when read-runtime cannot retrieve document detail.",
});

import { cleanText } from "../message-intent-utils.mjs";
import { runRead } from "../read-runtime.mjs";
import { createSkillDefinition } from "../skill-contract.mjs";

const DEFAULT_SOURCE_PREVIEW_LIMIT = 1;
const MAX_HEADING_PREVIEW = 3;
const MAX_HIGHLIGHT_PREVIEW = 2;

function buildCanonicalReadRequest({
  accountId = "",
  docId = "",
  pathname = "",
  readerOverrides = null,
} = {}) {
  return {
    action: "get_company_brain_doc_detail",
    account_id: cleanText(accountId) || "",
    payload: {
      doc_id: cleanText(docId) || "",
    },
    context: {
      pathname: cleanText(pathname) || "internal:skill/document_summarize",
      primary_authority: "mirror",
      ...(readerOverrides && typeof readerOverrides === "object" && !Array.isArray(readerOverrides)
        ? { reader_overrides: readerOverrides }
        : {}),
    },
  };
}

function summarizeText(text = "", fallback = "") {
  const normalized = cleanText(String(text || "").replace(/\s+/g, " "));
  return normalized || fallback;
}

function summarizeStringList(items = [], maxItems = 0) {
  if (!Array.isArray(items) || maxItems <= 0) {
    return [];
  }
  return items
    .map((item) => summarizeText(item))
    .filter(Boolean)
    .slice(0, maxItems);
}

function buildSourcePreview(detail = {}) {
  return {
    id: cleanText(detail?.doc?.doc_id) || null,
    title: summarizeText(detail?.doc?.title, "未命名文件"),
    url: cleanText(detail?.doc?.url) || null,
    snippet: summarizeText(
      detail?.summary?.snippet,
      summarizeText(detail?.summary?.overview, "目前沒有可用的摘要片段。"),
    ),
  };
}

function buildDeterministicSummary(detail = {}) {
  const title = summarizeText(detail?.doc?.title, "這份文件");
  const overview = summarizeText(detail?.summary?.overview, "");
  const headings = summarizeStringList(detail?.summary?.headings, MAX_HEADING_PREVIEW);
  const highlights = summarizeStringList(detail?.summary?.highlights, MAX_HIGHLIGHT_PREVIEW);
  const sections = [];

  sections.push(`文件「${title}」摘要：${overview || "已整理可用內容。"}`);
  if (headings.length > 0) {
    sections.push(`重點段落：${headings.join("、")}`);
  }
  if (highlights.length > 0) {
    sections.push(`關鍵資訊：${highlights.join("；")}`);
  }

  return sections.join("\n");
}

function buildLimitations(detail = {}) {
  const limitations = [];
  if (!summarizeText(detail?.summary?.overview) && !summarizeText(detail?.summary?.snippet)) {
    limitations.push("文件缺少可用的結構化摘要，只能回傳基本文件資訊。");
  }
  if (Array.isArray(detail?.summary?.headings) && detail.summary.headings.length > MAX_HEADING_PREVIEW) {
    limitations.push(`僅保留前 ${MAX_HEADING_PREVIEW} 個段落標題。`);
  }
  if (Array.isArray(detail?.summary?.highlights) && detail.summary.highlights.length > MAX_HIGHLIGHT_PREVIEW) {
    limitations.push(`僅保留前 ${MAX_HIGHLIGHT_PREVIEW} 個重點。`);
  }
  return limitations;
}

export const documentSummarizeSkill = createSkillDefinition({
  name: "document_summarize",
  input_schema: {
    type: "object",
    required: ["account_id", "doc_id"],
    properties: {
      account_id: { type: "string" },
      doc_id: { type: "string" },
      pathname: { type: ["string", "null"] },
      reader_overrides: { type: ["object", "null"] },
    },
  },
  output_schema: {
    type: "object",
    required: ["doc_id", "title", "summary", "hits", "found", "sources", "limitations"],
    properties: {
      doc_id: { type: "string" },
      title: { type: "string" },
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
    read: ["get_company_brain_doc_detail"],
    write: [],
  },
  skill_class: "read_only",
  runtime_access: ["read_runtime"],
  failure_mode: "fail_closed",
  async run({ input, logger }) {
    const accountId = cleanText(input?.account_id);
    const docId = cleanText(input?.doc_id);

    if (!accountId || !docId) {
      return {
        ok: false,
        error: "contract_violation",
        details: {
          phase: "input_validation",
          intent_unfulfilled: true,
          criteria_failed: "input_validation",
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
            ...(!docId
              ? [{
                type: "required",
                code: "missing_required",
                path: "$input.doc_id",
                expected: "non_empty_string",
                actual: "empty",
                message: "Missing required field $input.doc_id.",
              }]
              : []),
          ],
        },
      };
    }

    const readExecution = await runRead({
      canonicalRequest: buildCanonicalReadRequest({
        accountId,
        docId,
        pathname: input?.pathname,
        readerOverrides: input?.reader_overrides,
      }),
      logger,
    });

    const sideEffects = [
      {
        mode: "read",
        action: "get_company_brain_doc_detail",
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
          intent_unfulfilled: true,
          criteria_failed: "read_runtime",
          authorities_attempted: Array.isArray(readExecution?.meta?.authorities_attempted)
            ? readExecution.meta.authorities_attempted
            : [],
        },
      };
    }

    const detail = readExecution?.data?.data && typeof readExecution.data.data === "object"
      ? readExecution.data.data
      : {};
    const title = summarizeText(detail?.doc?.title, docId);
    const sources = [buildSourcePreview(detail)].slice(0, DEFAULT_SOURCE_PREVIEW_LIMIT);

    return {
      ok: true,
      side_effects: sideEffects,
      output: {
        doc_id: docId,
        title,
        summary: buildDeterministicSummary(detail),
        hits: detail?.doc?.doc_id ? 1 : 0,
        found: Boolean(detail?.doc?.doc_id),
        sources,
        limitations: buildLimitations(detail),
      },
    };
  },
});

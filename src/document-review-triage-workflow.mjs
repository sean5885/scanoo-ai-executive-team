import { cleanText } from "./message-intent-utils.mjs";
import { normalizeText } from "./text-utils.mjs";
import { renderUserResponseText } from "./user-response-normalizer.mjs";

const MAX_REFERENCED_DOCUMENTS = 4;
const MAX_REASON_COUNT = 6;
const MAX_NEXT_ACTIONS = 3;

const GENERIC_REQUEST_TERMS = new Set([
  "review",
  "triage",
  "document",
  "documents",
  "doc",
  "docs",
  "file",
  "files",
  "request",
  "please",
  "workflow",
  "help",
  "check",
  "整理",
  "檢視",
  "检视",
  "檢查",
  "检查",
  "文件",
  "文檔",
  "文档",
  "需求",
  "請",
  "帮我",
  "幫我",
  "看一下",
  "看看",
  "review一下",
]);

const CONFIRMATION_SIGNALS = [
  "待確認",
  "待确认",
  "需確認",
  "需确认",
  "需要確認",
  "需要确认",
  "pending review",
  "needs confirmation",
  "product confirm",
  "產品確認",
  "产品确认",
];

function toLowerCleanText(value = "") {
  return normalizeText(String(value || "")).toLowerCase();
}

function uniqueList(items = []) {
  return [...new Set((Array.isArray(items) ? items : []).filter(Boolean))];
}

function sliceText(value = "", maxChars = 180) {
  const normalized = normalizeText(String(value || ""));
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}…` : normalized;
}

function extractAsciiTerms(text = "") {
  return uniqueList(
    toLowerCleanText(text)
      .split(/[^a-z0-9_-]+/u)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2 && !GENERIC_REQUEST_TERMS.has(item)),
  ).slice(0, 12);
}

function extractHanTerms(text = "") {
  const matches = String(text || "").match(/[\p{Script=Han}]{2,16}/gu) || [];
  return uniqueList(
    matches
      .map((item) => cleanText(item))
      .filter((item) => item.length >= 2 && !GENERIC_REQUEST_TERMS.has(item.toLowerCase())),
  ).slice(0, 12);
}

function extractRequestTerms(requestText = "") {
  return uniqueList([
    ...extractAsciiTerms(requestText),
    ...extractHanTerms(requestText),
  ]);
}

function normalizeDocument(document = {}, index = 0) {
  const title = cleanText(
    document.title
      || document.name
      || document.document_title
      || document.doc_title
      || `文件 ${index + 1}`,
  ) || `文件 ${index + 1}`;
  const docId = cleanText(document.doc_id || document.document_id || document.doc_token || document.id || "");
  const url = cleanText(document.url || document.document_url || document.link || "");
  const tags = uniqueList(
    Array.isArray(document.tags)
      ? document.tags.map((item) => cleanText(item))
      : String(document.tags || "")
        .split(/[，,;；|/]/u)
        .map((item) => cleanText(item)),
  ).slice(0, 8);

  const summary = normalizeText(
    document.summary
    || document.content_summary
    || document.snippet
    || document.abstract
    || "",
  );
  const content = normalizeText(document.content || document.body || "");
  const owner = cleanText(document.owner || document.doc_owner || "");
  const status = cleanText(document.status || document.review_status || "");
  const searchableText = toLowerCleanText([
    title,
    tags.join(" "),
    owner,
    status,
    summary,
    content,
    docId,
  ].filter(Boolean).join("\n"));

  return {
    title,
    doc_id: docId,
    url,
    tags,
    owner,
    status,
    summary,
    content,
    searchable_text: searchableText,
    title_text: toLowerCleanText(title),
    raw_index: index,
  };
}

function collectMatchedTerms(document = {}, requestTerms = []) {
  const titleHits = [];
  const tagHits = [];
  const summaryHits = [];

  for (const term of requestTerms) {
    const normalizedTerm = toLowerCleanText(term);
    if (!normalizedTerm) {
      continue;
    }
    if (document.title_text.includes(normalizedTerm)) {
      titleHits.push(term);
      continue;
    }
    if (document.tags.some((tag) => toLowerCleanText(tag).includes(normalizedTerm) || normalizedTerm.includes(toLowerCleanText(tag)))) {
      tagHits.push(term);
      continue;
    }
    if (document.searchable_text.includes(normalizedTerm)) {
      summaryHits.push(term);
    }
  }

  return {
    titleHits: uniqueList(titleHits),
    tagHits: uniqueList(tagHits),
    summaryHits: uniqueList(summaryHits),
  };
}

function hasConfirmationSignal(document = {}) {
  const haystack = [
    document.title,
    document.summary,
    document.status,
    document.owner,
    ...(Array.isArray(document.tags) ? document.tags : []),
  ].join("\n");
  const normalized = toLowerCleanText(haystack);
  return CONFIRMATION_SIGNALS.some((signal) => normalized.includes(toLowerCleanText(signal)));
}

function buildDocumentReasons(document = {}, matchedTerms = {}, needsConfirmation = false) {
  const reasons = [];
  if (matchedTerms.titleHits.length) {
    reasons.push(`標題直接命中 ${matchedTerms.titleHits.join("、")}`);
  }
  if (matchedTerms.tagHits.length) {
    reasons.push(`標籤命中 ${matchedTerms.tagHits.join("、")}`);
  }
  if (matchedTerms.summaryHits.length) {
    reasons.push(`摘要/內容命中 ${matchedTerms.summaryHits.join("、")}`);
  }
  if (needsConfirmation) {
    reasons.push("文件本身帶有待確認/人工確認訊號");
  }
  if (!reasons.length && document.summary) {
    reasons.push(`目前可見摘要：${sliceText(document.summary, 90)}`);
  }
  return reasons.slice(0, 3);
}

function classifyDocumentMatch(document = {}, requestTerms = []) {
  const matchedTerms = collectMatchedTerms(document, requestTerms);
  const needsConfirmation = hasConfirmationSignal(document);
  const exactTitleMatch = requestTerms.some((term) => {
    const normalizedTerm = toLowerCleanText(term);
    return normalizedTerm && (
      document.title_text === normalizedTerm
      || document.title_text.includes(normalizedTerm)
      || normalizedTerm.includes(document.title_text)
    );
  });

  const score = (
    matchedTerms.titleHits.length * 6
    + matchedTerms.tagHits.length * 4
    + matchedTerms.summaryHits.length * 2
    + (exactTitleMatch ? 4 : 0)
    + (needsConfirmation ? 1 : 0)
  );

  let triage = "out_of_scope";
  if (score > 0 && needsConfirmation) {
    triage = "needs_confirmation";
  } else if (score >= 8 || (matchedTerms.titleHits.length > 0 && matchedTerms.summaryHits.length > 0)) {
    triage = "primary";
  } else if (score > 0) {
    triage = "supporting";
  }

  return {
    ...document,
    score,
    triage,
    matched_terms: uniqueList([
      ...matchedTerms.titleHits,
      ...matchedTerms.tagHits,
      ...matchedTerms.summaryHits,
    ]),
    reasons: buildDocumentReasons(document, matchedTerms, needsConfirmation),
  };
}

function triageWeight(triage = "") {
  if (triage === "primary") {
    return 3;
  }
  if (triage === "needs_confirmation") {
    return 2;
  }
  if (triage === "supporting") {
    return 1;
  }
  return 0;
}

function sortReviewedDocuments(items = []) {
  return [...items].sort((left, right) => (
    triageWeight(right.triage) - triageWeight(left.triage)
    || right.score - left.score
    || left.raw_index - right.raw_index
  ));
}

function buildReferencedDocuments(items = []) {
  return sortReviewedDocuments(items)
    .filter((item) => item.triage !== "out_of_scope")
    .slice(0, MAX_REFERENCED_DOCUMENTS)
    .map((item) => ({
      title: item.title,
      doc_id: item.doc_id || "",
      url: item.url || "",
      triage: item.triage,
      reasons: item.reasons.slice(0, 3),
      matched_terms: item.matched_terms.slice(0, 6),
      summary: sliceText(item.summary || item.content, 140),
      score: item.score,
    }));
}

function buildOverallReasons(requestText = "", referencedDocuments = [], reviewedDocuments = []) {
  const reasons = referencedDocuments.map((item) => (
    `${item.title}：${item.reasons.join("；") || "目前是這輪最接近需求的候選文件。"}`
  ));
  if (!reasons.length && reviewedDocuments.length > 0) {
    reasons.push(`這批 ${reviewedDocuments.length} 份文件都沒有直接命中「${cleanText(requestText) || "目前需求"}」的穩定關鍵詞。`);
  }
  return reasons.slice(0, MAX_REASON_COUNT);
}

function buildConclusion(requestText = "", referencedDocuments = [], reviewedDocuments = []) {
  const primary = referencedDocuments.filter((item) => item.triage === "primary");
  const needsConfirmation = referencedDocuments.filter((item) => item.triage === "needs_confirmation");
  const supporting = referencedDocuments.filter((item) => item.triage === "supporting");

  if (!reviewedDocuments.length) {
    return "目前沒有收到可執行 review/triage 的文件集合。";
  }

  if (!referencedDocuments.length) {
    return `目前這批文件裡，還沒有文件能直接支撐「${cleanText(requestText) || "這輪需求"}」這次 review/triage。`;
  }

  const parts = [];
  if (primary.length) {
    parts.push(`先聚焦 ${primary.length} 份直接相關文件`);
  }
  if (needsConfirmation.length) {
    parts.push(`另有 ${needsConfirmation.length} 份需要人工確認的文件`);
  }
  if (supporting.length) {
    parts.push(`還有 ${supporting.length} 份可作補充參考`);
  }

  const leadTitle = primary[0]?.title || referencedDocuments[0]?.title || "";
  return `${parts.join("，")}。${leadTitle ? `目前最值得先往下看的文件是「${leadTitle}」。` : ""}`;
}

function buildNextActions(requestText = "", referencedDocuments = [], reviewedDocuments = []) {
  const actions = [];
  const primary = referencedDocuments.filter((item) => item.triage === "primary");
  const needsConfirmation = referencedDocuments.filter((item) => item.triage === "needs_confirmation");
  const outOfScopeCount = reviewedDocuments.filter((item) => item.triage === "out_of_scope").length;

  if (!reviewedDocuments.length) {
    return ["先提供至少一份文件，再重新執行這輪 review/triage。"];
  }

  if (!referencedDocuments.length) {
    return [
      `補更明確的文件名、主題詞或 owner 範圍後，再重跑「${cleanText(requestText) || "這輪需求"}」的 triage。`,
      "如果這批文件理應命中，先補文件摘要、標籤或最近更新內容再試一次。",
    ].slice(0, MAX_NEXT_ACTIONS);
  }

  if (needsConfirmation.length) {
    actions.push(`先請人工確認 ${needsConfirmation.map((item) => `「${item.title}」`).join("、")} 是否要保留在這輪範圍內。`);
  }
  if (primary.length) {
    actions.push(`先從「${primary[0].title}」開始做深入 review 或整理摘錄。`);
  }
  if (outOfScopeCount > 0) {
    actions.push(`其餘 ${outOfScopeCount} 份未命中的文件可先留在本輪範圍外。`);
  }

  return uniqueList(actions).slice(0, MAX_NEXT_ACTIONS);
}

function buildSourceLine(document = {}) {
  const triageLabelMap = {
    primary: "直接相關",
    needs_confirmation: "待人工確認",
    supporting: "補充參考",
  };
  const triageLabel = triageLabelMap[document.triage] || "候選文件";
  const reasonText = document.reasons.join("；") || "目前是這輪最接近需求的候選文件。";
  if (document.url) {
    return `${document.title}：${triageLabel}；${reasonText} 連結：${document.url}`;
  }
  return `${document.title}：${triageLabel}；${reasonText}`;
}

export function buildDocumentReviewStructuredResult({
  requestText = "",
  documents = [],
} = {}) {
  const normalizedDocuments = (Array.isArray(documents) ? documents : []).map(normalizeDocument);
  const requestTerms = extractRequestTerms(requestText);
  const reviewedDocuments = normalizedDocuments.map((item) => classifyDocumentMatch(item, requestTerms));
  const referencedDocuments = buildReferencedDocuments(reviewedDocuments);
  const reasons = buildOverallReasons(requestText, referencedDocuments, reviewedDocuments);
  const nextActions = buildNextActions(requestText, referencedDocuments, reviewedDocuments);
  const conclusion = buildConclusion(requestText, referencedDocuments, reviewedDocuments);

  return {
    workflow: "document_review",
    request_text: cleanText(requestText),
    document_count: normalizedDocuments.length,
    referenced_documents: referencedDocuments,
    reasons,
    conclusion,
    next_actions: nextActions,
    review_status: !normalizedDocuments.length
      ? "blocked"
      : referencedDocuments.some((item) => item.triage === "needs_confirmation")
        ? "needs_confirmation"
        : referencedDocuments.length > 0
          ? "ready"
          : "insufficient_evidence",
    evidence_first_reply: {
      answer: conclusion,
      sources: referencedDocuments.map(buildSourceLine),
      limitations: nextActions,
    },
  };
}

export function runDocumentReviewTriageWorkflow({
  requestText = "",
  documents = [],
} = {}) {
  const structuredResult = buildDocumentReviewStructuredResult({
    requestText,
    documents,
  });
  const userResponse = {
    ok: structuredResult.review_status !== "blocked",
    ...structuredResult.evidence_first_reply,
  };

  return {
    ok: userResponse.ok,
    structured_result: structuredResult,
    user_response: userResponse,
    reply_text: renderUserResponseText(userResponse),
    extra_evidence: [
      {
        type: "tool_output",
        summary: `documents_considered:${structuredResult.document_count}`,
      },
      {
        type: "tool_output",
        summary: `referenced_documents:${structuredResult.referenced_documents.length}`,
      },
    ],
  };
}

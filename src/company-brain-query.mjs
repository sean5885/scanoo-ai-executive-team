import {
  getCompanyBrainDocQueryRecord,
  listCompanyBrainDocQueryRecords,
} from "./rag-repository.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import { cosineSimilarity, embedTextLocally } from "./semantic-embeddings.mjs";
import { normalizeText } from "./text-utils.mjs";

const SUMMARY_OVERVIEW_LIMIT = 220;
const SUMMARY_HIGHLIGHT_LIMIT = 3;
const SUMMARY_HEADING_LIMIT = 5;
const SEARCH_MATCH_THRESHOLD = 0.08;
const EN_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "this",
  "with",
  "from",
  "into",
  "your",
  "have",
  "has",
  "are",
  "was",
  "were",
  "will",
  "can",
  "not",
  "but",
  "use",
  "using",
  "how",
  "what",
  "when",
  "where",
  "why",
  "then",
  "than",
  "more",
  "less",
  "about",
  "through",
  "after",
  "before",
  "into",
  "onto",
  "over",
  "under",
  "our",
  "their",
  "they",
  "them",
  "you",
  "yes",
  "via",
]);

function normalizeCreator(row = {}) {
  let parsed = null;
  try {
    parsed = row?.creator_json ? JSON.parse(row.creator_json) : null;
  } catch {
    parsed = null;
  }

  return {
    account_id: cleanText(parsed?.account_id) || null,
    open_id: cleanText(parsed?.open_id) || null,
  };
}

function buildCompanyBrainDocMeta(row = {}) {
  return {
    doc_id: cleanText(row?.doc_id) || null,
    title: cleanText(row?.title) || null,
    source: cleanText(row?.source) || null,
    created_at: cleanText(row?.created_at) || null,
    creator: normalizeCreator(row),
  };
}

function normalizeRawText(text = "") {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .trim();
}

function normalizeInlineText(text = "") {
  return cleanText(normalizeRawText(text).replace(/\s+/g, " "));
}

function splitContentLines(rawText = "") {
  return normalizeRawText(rawText)
    .split("\n")
    .map((line) => cleanText(line.replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "").replace(/^#+\s*/, "")))
    .filter(Boolean);
}

function extractHeadings(rawText = "", limit = SUMMARY_HEADING_LIMIT) {
  return normalizeRawText(rawText)
    .split("\n")
    .map((line) => {
      const headingMatch = line.match(/^\s{0,3}#{1,6}\s+(.+)$/);
      if (headingMatch) {
        return cleanText(headingMatch[1]);
      }
      const numberedMatch = line.match(/^\s*(?:\d+[.)]|[一二三四五六七八九十]+[、.])\s+(.+)$/);
      if (numberedMatch) {
        return cleanText(numberedMatch[1]);
      }
      return null;
    })
    .filter(Boolean)
    .slice(0, limit);
}

function splitSentences(rawText = "") {
  return normalizeInlineText(rawText)
    .split(/(?<=[。！？!?;；.])\s+/)
    .map((item) => cleanText(item))
    .filter(Boolean);
}

function buildOverview(rawText = "", maxLength = SUMMARY_OVERVIEW_LIMIT) {
  const normalized = normalizeInlineText(rawText);
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength).trim()}...`;
}

function buildHighlights(rawText = "", limit = SUMMARY_HIGHLIGHT_LIMIT) {
  const headingLines = extractHeadings(rawText, limit);
  const contentLines = splitContentLines(rawText);
  const candidates = [];
  const seen = new Set();

  for (const item of headingLines) {
    const normalized = cleanText(item);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    candidates.push(normalized);
  }

  for (const item of contentLines) {
    if (candidates.length >= limit) {
      break;
    }
    const normalized = cleanText(item);
    if (!normalized || normalized.length < 6 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    candidates.push(normalized);
  }

  if (candidates.length >= limit) {
    return candidates.slice(0, limit);
  }

  for (const item of splitSentences(rawText)) {
    if (candidates.length >= limit) {
      break;
    }
    const normalized = cleanText(item);
    if (!normalized || normalized.length < 6 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    candidates.push(normalized);
  }

  return candidates.slice(0, limit);
}

function tokenizeQuery(text = "") {
  const normalized = normalizeText(text).toLowerCase();
  return normalized
    .split(/[\s,.;:!?()[\]{}"'`~@#$%^&*+=|\\/<>-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !EN_STOPWORDS.has(token));
}

function buildQuerySnippet(rawText = "", query = "", maxLength = 180) {
  const lines = splitContentLines(rawText);
  const normalizedQuery = cleanText(query).toLowerCase();
  if (!lines.length) {
    return buildOverview(rawText, maxLength);
  }

  const matched = lines.find((line) => line.toLowerCase().includes(normalizedQuery));
  if (matched) {
    return matched.length <= maxLength ? matched : `${matched.slice(0, maxLength).trim()}...`;
  }

  const tokens = tokenizeQuery(query);
  if (tokens.length) {
    const partial = lines.find((line) => tokens.some((token) => line.toLowerCase().includes(token)));
    if (partial) {
      return partial.length <= maxLength ? partial : `${partial.slice(0, maxLength).trim()}...`;
    }
  }

  return buildOverview(rawText, maxLength);
}

function buildStructuredSummary(row = {}, { query = "" } = {}) {
  const rawText = normalizeRawText(row?.raw_text);
  const headings = extractHeadings(rawText);
  const highlights = buildHighlights(rawText);
  const overview = buildOverview(rawText || row?.title || "");
  const snippet = cleanText(query) ? buildQuerySnippet(rawText || row?.title || "", query) : overview;

  return {
    overview: overview || cleanText(row?.title) || "",
    headings,
    highlights,
    snippet,
    content_length: rawText.length,
  };
}

function buildListItem(row = {}) {
  return {
    ...buildCompanyBrainDocMeta(row),
    summary: buildStructuredSummary(row),
  };
}

function buildDetailData(row = {}) {
  return {
    doc: buildCompanyBrainDocMeta(row),
    summary: buildStructuredSummary(row),
  };
}

function buildSearchText(row = {}) {
  return [
    cleanText(row?.title),
    cleanText(row?.doc_id),
    normalizeInlineText(row?.raw_text),
  ].filter(Boolean).join("\n");
}

function computeKeywordScore(row = {}, query = "", queryTokens = []) {
  const normalizedQuery = cleanText(query).toLowerCase();
  const title = cleanText(row?.title).toLowerCase();
  const docId = cleanText(row?.doc_id).toLowerCase();
  const rawText = normalizeInlineText(row?.raw_text).toLowerCase();

  let score = 0;
  if (normalizedQuery) {
    if (title.includes(normalizedQuery)) {
      score += 6;
    }
    if (docId.includes(normalizedQuery)) {
      score += 5;
    }
    if (rawText.includes(normalizedQuery)) {
      score += 4;
    }
  }

  for (const token of queryTokens) {
    if (title.includes(token)) {
      score += 2;
    }
    if (docId.includes(token)) {
      score += 1.5;
    }
    if (rawText.includes(token)) {
      score += 1;
    }
  }

  return Number(score.toFixed(4));
}

function computeSemanticScore(queryEmbedding = [], row = {}) {
  const corpusText = buildSearchText(row);
  if (!corpusText) {
    return 0;
  }
  return Number(cosineSimilarity(queryEmbedding, embedTextLocally(corpusText)).toFixed(6));
}

function buildSearchMatch(keywordScore = 0, semanticScore = 0) {
  const type = keywordScore > 0 && semanticScore >= SEARCH_MATCH_THRESHOLD
    ? "hybrid"
    : keywordScore > 0
      ? "keyword"
      : semanticScore >= SEARCH_MATCH_THRESHOLD
        ? "semantic"
        : "none";

  return {
    type,
    keyword_score: keywordScore,
    semantic_score: semanticScore,
    score: Number((keywordScore * 10 + semanticScore).toFixed(6)),
  };
}

function buildSearchItem(row = {}, query = "", match = {}) {
  return {
    ...buildCompanyBrainDocMeta(row),
    match,
    summary: buildStructuredSummary(row, { query }),
  };
}

function buildUnifiedResult(success, data, error = null) {
  return {
    success,
    data: data && typeof data === "object" && !Array.isArray(data) ? data : {},
    error: cleanText(error) || null,
  };
}

export function listCompanyBrainDocsAction({
  accountId = "",
  limit = 20,
} = {}) {
  if (!cleanText(accountId)) {
    return buildUnifiedResult(false, {}, "missing_account_id");
  }

  const items = listCompanyBrainDocQueryRecords(accountId, limit).map(buildListItem);
  return buildUnifiedResult(true, {
    total: items.length,
    items,
  });
}

export function searchCompanyBrainDocsAction({
  accountId = "",
  q = "",
  limit = 10,
} = {}) {
  const normalizedAccountId = cleanText(accountId);
  const normalizedQuery = cleanText(q);
  if (!normalizedAccountId) {
    return buildUnifiedResult(false, {}, "missing_account_id");
  }
  if (!normalizedQuery) {
    return buildUnifiedResult(false, {}, "invalid_query");
  }

  const queryTokens = tokenizeQuery(normalizedQuery);
  const queryEmbedding = embedTextLocally(normalizedQuery);
  const ranked = listCompanyBrainDocQueryRecords(normalizedAccountId).map((row) => {
    const keywordScore = computeKeywordScore(row, normalizedQuery, queryTokens);
    const semanticScore = computeSemanticScore(queryEmbedding, row);
    const match = buildSearchMatch(keywordScore, semanticScore);
    return {
      row,
      match,
    };
  }).filter(({ match }) => (
    match.type !== "none"
  )).sort((left, right) => (
    right.match.score - left.match.score
  )).slice(0, limit);

  const items = ranked.map(({ row, match }) => buildSearchItem(row, normalizedQuery, match));
  return buildUnifiedResult(true, {
    q: normalizedQuery,
    total: items.length,
    items,
  });
}

export function getCompanyBrainDocDetailAction({
  accountId = "",
  docId = "",
} = {}) {
  const normalizedAccountId = cleanText(accountId);
  const normalizedDocId = cleanText(docId);
  if (!normalizedAccountId) {
    return buildUnifiedResult(false, {}, "missing_account_id");
  }
  if (!normalizedDocId) {
    return buildUnifiedResult(false, {}, "missing_doc_id");
  }

  const row = getCompanyBrainDocQueryRecord(normalizedAccountId, normalizedDocId);
  if (!row) {
    return buildUnifiedResult(false, {}, "not_found");
  }

  return buildUnifiedResult(true, buildDetailData(row));
}

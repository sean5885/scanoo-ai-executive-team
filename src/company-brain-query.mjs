import {
  getCompanyBrainDocQueryRecord,
  listCompanyBrainDocQueryRecords,
} from "./rag-repository.mjs";
import {
  buildLearningSearchText,
  buildStructuredSummary as buildCompanyBrainStructuredSummary,
  parseLearningStateRow,
} from "./company-brain-learning.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import { cosineSimilarity, embedTextLocally } from "./semantic-embeddings.mjs";
import { normalizeText } from "./text-utils.mjs";

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

function tokenizeQuery(text = "") {
  const normalized = normalizeText(text).toLowerCase();
  return normalized
    .split(/[\s,.;:!?()[\]{}"'`~@#$%^&*+=|\\/<>-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !EN_STOPWORDS.has(token));
}

function buildStructuredSummary(row = {}, { query = "" } = {}) {
  return buildCompanyBrainStructuredSummary({
    rawText: row?.raw_text,
    title: row?.title,
    query,
  });
}

function buildListItem(row = {}) {
  return {
    ...buildCompanyBrainDocMeta(row),
    summary: buildStructuredSummary(row),
    learning_state: parseLearningStateRow(row),
  };
}

function buildDetailData(row = {}) {
  return {
    doc: buildCompanyBrainDocMeta(row),
    summary: buildStructuredSummary(row),
    learning_state: parseLearningStateRow(row),
  };
}

function buildSearchText(row = {}) {
  const learningState = parseLearningStateRow(row);
  return [
    cleanText(row?.title),
    cleanText(row?.doc_id),
    cleanText(row?.raw_text).replace(/\s+/g, " ").trim(),
    buildLearningSearchText(learningState),
  ].filter(Boolean).join("\n");
}

function computeKeywordScore(row = {}, query = "", queryTokens = []) {
  const normalizedQuery = cleanText(query).toLowerCase();
  const title = cleanText(row?.title).toLowerCase();
  const docId = cleanText(row?.doc_id).toLowerCase();
  const rawText = cleanText(row?.raw_text).replace(/\s+/g, " ").trim().toLowerCase();
  const learningText = buildLearningSearchText(parseLearningStateRow(row)).toLowerCase();

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
    if (learningText.includes(normalizedQuery)) {
      score += 5;
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
    if (learningText.includes(token)) {
      score += 1.5;
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
    learning_state: parseLearningStateRow(row),
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

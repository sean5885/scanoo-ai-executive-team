import {
  getApprovedCompanyBrainDocQueryRecord,
  getCompanyBrainDocQueryRecord,
  listApprovedCompanyBrainDocQueryRecords,
  listCompanyBrainDocQueryRecords,
} from "./rag-repository.mjs";
import {
  buildStructuredSummary as buildCompanyBrainStructuredSummary,
  parseLearningStateRow,
} from "./company-brain-learning.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import { cosineSimilarity, embedTextLocally } from "./semantic-embeddings.mjs";
import { normalizeText } from "./text-utils.mjs";

const SEARCH_MATCH_THRESHOLD = 0.08;
const DEFAULT_SEARCH_TOP_K = 5;
const MAX_SEARCH_TOP_K = 200;
const DEFAULT_RANKING_WEIGHTS = Object.freeze({
  keyword: 0.45,
  semantic_lite: 0.2,
  learning: 0.25,
  recency: 0.1,
});
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

function normalizeInlineText(text = "") {
  return String(cleanText(text) || "")
    .replace(/\s+/g, " ")
    .trim();
}

function compareNormalizedText(left = "", right = "") {
  const normalizedLeft = normalizeInlineText(left).toLowerCase();
  const normalizedRight = normalizeInlineText(right).toLowerCase();
  if (normalizedLeft === normalizedRight) {
    return 0;
  }
  return normalizedLeft < normalizedRight ? -1 : 1;
}

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

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

function buildApprovedKnowledgeState(row = {}) {
  return {
    stage: "approved",
    source_stage: cleanText(row?.approved_source_stage) || null,
    approved_by: cleanText(row?.approved_by) || null,
    approved_at: cleanText(row?.approved_at) || null,
  };
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
  return [
    cleanText(row?.title),
    cleanText(row?.doc_id),
    normalizeInlineText(row?.raw_text),
  ].filter(Boolean).join("\n");
}

function compareRankedSearchItems(left = {}, right = {}) {
  return (
    Number(right?.match?.score || 0) - Number(left?.match?.score || 0)
    || Number(right?.match?.keyword_score || 0) - Number(left?.match?.keyword_score || 0)
    || Number(right?.match?.learning_score || 0) - Number(left?.match?.learning_score || 0)
    || Number(right?.match?.semantic_score || 0) - Number(left?.match?.semantic_score || 0)
    || Number(right?.match?.recency_score || 0) - Number(left?.match?.recency_score || 0)
    || Number(right?.sort_timestamp || 0) - Number(left?.sort_timestamp || 0)
    || compareNormalizedText(left?.row?.doc_id, right?.row?.doc_id)
    || compareNormalizedText(left?.row?.title, right?.row?.title)
    || compareNormalizedText(left?.row?.created_at, right?.row?.created_at)
  );
}

function resolveSearchTopK(topK = null, limit = null, fallback = DEFAULT_SEARCH_TOP_K) {
  const candidates = [topK, limit, fallback];
  for (const candidate of candidates) {
    const value = Number.parseInt(String(candidate ?? "").trim(), 10);
    if (Number.isFinite(value)) {
      return clampNumber(value, 1, MAX_SEARCH_TOP_K);
    }
  }
  return fallback;
}

function normalizeRankingWeights(weights = null) {
  if (!weights || typeof weights !== "object" || Array.isArray(weights)) {
    return { ...DEFAULT_RANKING_WEIGHTS };
  }

  const raw = {
    keyword: Number(weights.keyword),
    semantic_lite: Number(weights.semantic_lite ?? weights.semanticLite),
    learning: Number(weights.learning),
    recency: Number(weights.recency),
  };

  const merged = {
    keyword: Number.isFinite(raw.keyword) && raw.keyword >= 0 ? raw.keyword : DEFAULT_RANKING_WEIGHTS.keyword,
    semantic_lite: Number.isFinite(raw.semantic_lite) && raw.semantic_lite >= 0
      ? raw.semantic_lite
      : DEFAULT_RANKING_WEIGHTS.semantic_lite,
    learning: Number.isFinite(raw.learning) && raw.learning >= 0 ? raw.learning : DEFAULT_RANKING_WEIGHTS.learning,
    recency: Number.isFinite(raw.recency) && raw.recency >= 0 ? raw.recency : DEFAULT_RANKING_WEIGHTS.recency,
  };

  const total = Object.values(merged).reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    return { ...DEFAULT_RANKING_WEIGHTS };
  }

  return Object.fromEntries(
    Object.entries(merged).map(([key, value]) => [key, Number((value / total).toFixed(6))]),
  );
}

function normalizeSaturatedScore(rawScore = 0, pivot = 8) {
  if (!Number.isFinite(rawScore) || rawScore <= 0) {
    return 0;
  }
  return Number((rawScore / (rawScore + pivot)).toFixed(6));
}

function computeKeywordSignal(row = {}, query = "", queryTokens = []) {
  const normalizedQuery = normalizeInlineText(query).toLowerCase();
  const title = normalizeInlineText(row?.title).toLowerCase();
  const docId = normalizeInlineText(row?.doc_id).toLowerCase();
  const rawText = normalizeInlineText(row?.raw_text).toLowerCase();
  const basis = new Set();

  let rawScore = 0;
  let titleTokenHits = 0;
  let docIdTokenHits = 0;
  let contentTokenHits = 0;

  if (normalizedQuery) {
    if (title.includes(normalizedQuery)) {
      rawScore += 9;
      basis.add("keyword:title_exact");
    }
    if (docId.includes(normalizedQuery)) {
      rawScore += 8;
      basis.add("keyword:doc_id_exact");
    }
    if (rawText.includes(normalizedQuery)) {
      rawScore += 6;
      basis.add("keyword:content_exact");
    }
  }

  for (const token of queryTokens) {
    if (title.includes(token)) {
      rawScore += 2.5;
      titleTokenHits += 1;
    }
    if (docId.includes(token)) {
      rawScore += 2;
      docIdTokenHits += 1;
    }
    if (rawText.includes(token)) {
      rawScore += 1.25;
      contentTokenHits += 1;
    }
  }

  if (titleTokenHits > 0) {
    basis.add(`keyword:title_tokens:${titleTokenHits}`);
  }
  if (docIdTokenHits > 0) {
    basis.add(`keyword:doc_id_tokens:${docIdTokenHits}`);
  }
  if (contentTokenHits > 0) {
    basis.add(`keyword:content_tokens:${contentTokenHits}`);
  }

  return {
    score: normalizeSaturatedScore(rawScore, 10),
    basis: Array.from(basis),
  };
}

function computeLearningSignal(row = {}, query = "", queryTokens = []) {
  const learningState = parseLearningStateRow(row);
  if (learningState.status === "not_learned") {
    return {
      score: 0,
      basis: [],
    };
  }

  const normalizedQuery = normalizeInlineText(query).toLowerCase();
  const tagText = learningState.tags.join("\n").toLowerCase();
  const conceptText = learningState.key_concepts.join("\n").toLowerCase();
  const basis = new Set();

  let rawScore = 0;
  let tagTokenHits = 0;
  let conceptTokenHits = 0;

  if (normalizedQuery) {
    if (tagText.includes(normalizedQuery)) {
      rawScore += 8;
      basis.add("learning:tags_exact");
    }
    if (conceptText.includes(normalizedQuery)) {
      rawScore += 7;
      basis.add("learning:key_concepts_exact");
    }
  }

  for (const token of queryTokens) {
    if (tagText.includes(token)) {
      rawScore += 3;
      tagTokenHits += 1;
    }
    if (conceptText.includes(token)) {
      rawScore += 2.5;
      conceptTokenHits += 1;
    }
  }

  if (tagTokenHits > 0) {
    basis.add(`learning:tags_tokens:${tagTokenHits}`);
  }
  if (conceptTokenHits > 0) {
    basis.add(`learning:key_concepts_tokens:${conceptTokenHits}`);
  }

  return {
    score: normalizeSaturatedScore(rawScore, 8),
    basis: Array.from(basis),
  };
}

function computeSemanticSignal(queryEmbedding = [], row = {}) {
  const corpusText = buildSearchText(row);
  if (!corpusText) {
    return {
      score: 0,
      basis: [],
    };
  }

  const rawCosine = Math.max(0, cosineSimilarity(queryEmbedding, embedTextLocally(corpusText)));
  if (rawCosine < SEARCH_MATCH_THRESHOLD) {
    return {
      score: 0,
      basis: [],
    };
  }

  return {
    score: Number((((rawCosine - SEARCH_MATCH_THRESHOLD) / (1 - SEARCH_MATCH_THRESHOLD))).toFixed(6)),
    basis: [`semantic_lite:${rawCosine.toFixed(3)}`],
  };
}

function parseDocTimestamp(row = {}) {
  const rawValue = cleanText(row?.updated_at) || cleanText(row?.created_at);
  if (!rawValue) {
    return null;
  }
  const timestamp = Date.parse(rawValue);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function buildDeterministicRecencyContext(rows = []) {
  const timestamps = Array.from(new Set(
    (Array.isArray(rows) ? rows : [])
      .map((row) => parseDocTimestamp(row))
      .filter((value) => Number.isFinite(value)),
  )).sort((left, right) => right - left);

  const maxRank = Math.max(0, timestamps.length - 1);
  const scoreByTimestamp = new Map(
    timestamps.map((timestamp, index) => [
      timestamp,
      maxRank === 0 ? 1 : Number((1 - (index / maxRank)).toFixed(6)),
    ]),
  );

  return {
    scoreByTimestamp,
  };
}

function computeRecencySignal(row = {}, recencyContext = {}) {
  const timestamp = parseDocTimestamp(row);
  if (!timestamp) {
    return {
      score: 0,
      basis: [],
      timestamp: null,
    };
  }

  const scoreByTimestamp = recencyContext?.scoreByTimestamp instanceof Map
    ? recencyContext.scoreByTimestamp
    : new Map();
  const score = Number(scoreByTimestamp.get(timestamp) ?? 0);
  let label = "stale";
  if (score >= 0.75) {
    label = "fresh";
  } else if (score >= 0.5) {
    label = "recent";
  } else if (score > 0) {
    label = "active";
  }

  return {
    score,
    basis: [`recency:${label}`],
    timestamp,
  };
}

function buildSearchMatch({
  keywordSignal = {},
  semanticSignal = {},
  learningSignal = {},
  recencySignal = {},
  rankingWeights = DEFAULT_RANKING_WEIGHTS,
} = {}) {
  const keywordScore = keywordSignal.score || 0;
  const semanticScore = semanticSignal.score || 0;
  const learningScore = learningSignal.score || 0;
  const recencyScore = recencySignal.score || 0;
  const activeSignals = [
    keywordScore > 0,
    semanticScore > 0,
    learningScore > 0,
  ].filter(Boolean).length;

  const type = activeSignals > 1
    ? "hybrid"
    : keywordScore > 0
      ? "keyword"
      : learningScore > 0
        ? "learning"
        : semanticScore > 0
          ? "semantic"
          : "none";

  const score = type === "none"
    ? 0
    : (
      keywordScore * rankingWeights.keyword
      + semanticScore * rankingWeights.semantic_lite
      + learningScore * rankingWeights.learning
      + recencyScore * rankingWeights.recency
    );

  return {
    type,
    keyword_score: keywordScore,
    semantic_score: semanticScore,
    learning_score: learningScore,
    recency_score: recencyScore,
    score: Number(score.toFixed(6)),
    ranking_basis: Array.from(new Set([
      ...(keywordSignal.basis || []),
      ...(learningSignal.basis || []),
      ...(semanticSignal.basis || []),
      ...(recencySignal.basis || []),
    ])).sort(compareNormalizedText).slice(0, 6),
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

function buildApprovedListItem(row = {}) {
  return {
    ...buildListItem(row),
    knowledge_state: buildApprovedKnowledgeState(row),
  };
}

function buildApprovedDetailData(row = {}) {
  return {
    ...buildDetailData(row),
    knowledge_state: buildApprovedKnowledgeState(row),
  };
}

function buildApprovedSearchItem(row = {}, query = "", match = {}) {
  return {
    ...buildSearchItem(row, query, match),
    knowledge_state: buildApprovedKnowledgeState(row),
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
  limit = null,
  top_k = null,
  ranking_weights = null,
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
  const topK = resolveSearchTopK(top_k, limit);
  const rankingWeights = normalizeRankingWeights(ranking_weights);
  const rows = listCompanyBrainDocQueryRecords(normalizedAccountId);
  const recencyContext = buildDeterministicRecencyContext(rows);
  const ranked = rows.map((row) => {
    const keywordSignal = computeKeywordSignal(row, normalizedQuery, queryTokens);
    const semanticSignal = computeSemanticSignal(queryEmbedding, row);
    const learningSignal = computeLearningSignal(row, normalizedQuery, queryTokens);
    const recencySignal = computeRecencySignal(row, recencyContext);
    const match = buildSearchMatch({
      keywordSignal,
      semanticSignal,
      learningSignal,
      recencySignal,
      rankingWeights,
    });
    return {
      row,
      match,
      sort_timestamp: recencySignal.timestamp || 0,
    };
  }).filter(({ match }) => (
      match.type !== "none"
  )).sort(compareRankedSearchItems).slice(0, topK);

  const items = ranked.map(({ row, match }) => buildSearchItem(row, normalizedQuery, match));
  return buildUnifiedResult(true, {
    q: normalizedQuery,
    top_k: topK,
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

export function listApprovedCompanyBrainKnowledgeAction({
  accountId = "",
  limit = 20,
} = {}) {
  if (!cleanText(accountId)) {
    return buildUnifiedResult(false, {}, "missing_account_id");
  }

  const items = listApprovedCompanyBrainDocQueryRecords(accountId, limit).map(buildApprovedListItem);
  return buildUnifiedResult(true, {
    total: items.length,
    items,
  });
}

export function searchApprovedCompanyBrainKnowledgeAction({
  accountId = "",
  q = "",
  limit = null,
  top_k = null,
  ranking_weights = null,
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
  const topK = resolveSearchTopK(top_k, limit);
  const rankingWeights = normalizeRankingWeights(ranking_weights);
  const rows = listApprovedCompanyBrainDocQueryRecords(normalizedAccountId);
  const recencyContext = buildDeterministicRecencyContext(rows);
  const ranked = rows.map((row) => {
    const keywordSignal = computeKeywordSignal(row, normalizedQuery, queryTokens);
    const semanticSignal = computeSemanticSignal(queryEmbedding, row);
    const learningSignal = computeLearningSignal(row, normalizedQuery, queryTokens);
    const recencySignal = computeRecencySignal(row, recencyContext);
    const match = buildSearchMatch({
      keywordSignal,
      semanticSignal,
      learningSignal,
      recencySignal,
      rankingWeights,
    });
    return {
      row,
      match,
      sort_timestamp: recencySignal.timestamp || 0,
    };
  }).filter(({ match }) => (
      match.type !== "none"
  )).sort(compareRankedSearchItems).slice(0, topK);

  const items = ranked.map(({ row, match }) => buildApprovedSearchItem(row, normalizedQuery, match));
  return buildUnifiedResult(true, {
    q: normalizedQuery,
    top_k: topK,
    total: items.length,
    items,
  });
}

export function getApprovedCompanyBrainKnowledgeDetailAction({
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

  const row = getApprovedCompanyBrainDocQueryRecord(normalizedAccountId, normalizedDocId);
  if (!row) {
    return buildUnifiedResult(false, {}, "not_found");
  }

  return buildUnifiedResult(true, buildApprovedDetailData(row));
}

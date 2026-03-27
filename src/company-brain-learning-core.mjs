import { cleanText } from "./message-intent-utils.mjs";

const SUMMARY_OVERVIEW_LIMIT = 220;
const SUMMARY_HIGHLIGHT_LIMIT = 3;
const SUMMARY_HEADING_LIMIT = 5;
const LEARNING_CONCEPT_LIMIT = 8;
const LEARNING_TAG_LIMIT = 8;
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

function splitLineSentences(line = "") {
  return normalizeInlineText(line)
    .split(/(?<=[。！？!?;；.])\s+/)
    .map((item) => cleanText(item))
    .filter(Boolean);
}

function buildOverview(rawText = "", title = "", maxLength = SUMMARY_OVERVIEW_LIMIT) {
  const normalized = normalizeInlineText(rawText || title);
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

function tokenizeSearchText(text = "") {
  return normalizeInlineText(text)
    .toLowerCase()
    .split(/[\s,.;:!?()[\]{}"'`~@#$%^&*+=|\\/<>-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !EN_STOPWORDS.has(token));
}

function buildQuerySnippet(rawText = "", title = "", query = "", maxLength = 180) {
  const normalizedQuery = cleanText(query).toLowerCase();
  const queryTokens = tokenizeSearchText(query);
  const lines = splitContentLines(rawText);
  if (!lines.length) {
    return buildOverview(rawText, title, maxLength);
  }

  const candidates = lines.flatMap((line, lineIndex) => {
    const sentences = splitLineSentences(line);
    if (!sentences.length) {
      return [];
    }
    return sentences.map((sentence, sentenceIndex) => ({
      text: sentence,
      lineIndex,
      sentenceIndex,
    }));
  });

  if (!candidates.length) {
    return buildOverview(rawText, title, maxLength);
  }

  const ranked = candidates.map((candidate) => {
    const normalizedText = normalizeInlineText(candidate.text).toLowerCase();
    let score = 0;

    if (normalizedQuery && normalizedText.includes(normalizedQuery)) {
      score += 100;
      if (normalizedText.startsWith(normalizedQuery)) {
        score += 8;
      }
    }

    let tokenHitCount = 0;
    for (const token of queryTokens) {
      if (!token || !normalizedText.includes(token)) {
        continue;
      }
      tokenHitCount += 1;
      score += 20;
      if (normalizedText.startsWith(token)) {
        score += 2;
      }
    }

    if (tokenHitCount > 1) {
      score += tokenHitCount;
    }
    if (/[。！？!?;；.]$/.test(candidate.text)) {
      score += 1;
    }

    return {
      ...candidate,
      score,
    };
  }).filter((candidate) => candidate.score > 0)
    .sort((left, right) => (
      right.score - left.score
      || left.lineIndex - right.lineIndex
      || left.sentenceIndex - right.sentenceIndex
      || left.text.length - right.text.length
    ));

  const matched = ranked[0]?.text || "";
  if (matched) {
    return matched.length <= maxLength ? matched : `${matched.slice(0, maxLength).trim()}...`;
  }

  return buildOverview(rawText, title, maxLength);
}

function normalizeConcepts(items = [], limit = LEARNING_CONCEPT_LIMIT) {
  const results = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const normalized = cleanText(item);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    results.push(normalized);
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}

function normalizeTags(items = [], limit = LEARNING_TAG_LIMIT) {
  const results = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const normalized = cleanText(String(item || "").toLowerCase())
      .replace(/[^\p{Letter}\p{Number}\s_-]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    results.push(normalized);
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}

function deriveTagCandidates({ title = "", headings = [], concepts = [], rawText = "" } = {}) {
  const titleTokens = tokenizeSearchText(title);
  const headingTokens = headings.flatMap((item) => tokenizeSearchText(item));
  const conceptTokens = concepts.flatMap((item) => tokenizeSearchText(item));
  const chineseMatches = normalizeRawText([title, ...headings, ...concepts, rawText].join("\n"))
    .match(/[\p{Script=Han}]{2,12}/gu) || [];
  return [
    ...titleTokens,
    ...headingTokens,
    ...conceptTokens,
    ...chineseMatches.map((item) => cleanText(item).toLowerCase()),
  ];
}

export function buildEmptyStructuredSummary() {
  return {
    overview: "",
    headings: [],
    highlights: [],
    snippet: "",
    content_length: 0,
  };
}

export function buildStructuredSummary({
  rawText = "",
  title = "",
  query = "",
} = {}) {
  const normalizedRawText = normalizeRawText(rawText);
  const overview = buildOverview(normalizedRawText, title);
  return {
    overview: overview || cleanText(title) || "",
    headings: extractHeadings(normalizedRawText),
    highlights: buildHighlights(normalizedRawText),
    snippet: cleanText(query)
      ? buildQuerySnippet(normalizedRawText, title, query)
      : overview || cleanText(title) || "",
    content_length: normalizedRawText.length,
  };
}

export function buildLearningDerivatives({
  title = "",
  rawText = "",
} = {}) {
  const structuredSummary = buildStructuredSummary({ rawText, title });
  const keyConcepts = normalizeConcepts([
    cleanText(title),
    ...structuredSummary.headings,
    ...structuredSummary.highlights,
    ...splitSentences(rawText).slice(0, 4),
  ]);
  const tags = normalizeTags(deriveTagCandidates({
    title,
    headings: structuredSummary.headings,
    concepts: keyConcepts,
    rawText,
  }));

  return {
    structured_summary: structuredSummary,
    key_concepts: keyConcepts,
    tags,
  };
}

export function buildEmptyLearningState() {
  return {
    status: "not_learned",
    structured_summary: buildEmptyStructuredSummary(),
    key_concepts: [],
    tags: [],
    notes: "",
    learned_at: null,
    updated_at: null,
  };
}

export function normalizeLearningState(state = {}) {
  const normalized = state && typeof state === "object" && !Array.isArray(state)
    ? state
    : {};
  return {
    status: cleanText(normalized.status) || "not_learned",
    structured_summary: normalized.structured_summary && typeof normalized.structured_summary === "object"
      ? {
          overview: cleanText(normalized.structured_summary.overview) || "",
          headings: normalizeConcepts(normalized.structured_summary.headings, SUMMARY_HEADING_LIMIT),
          highlights: normalizeConcepts(normalized.structured_summary.highlights, SUMMARY_HIGHLIGHT_LIMIT),
          snippet: cleanText(normalized.structured_summary.snippet)
            || cleanText(normalized.structured_summary.overview)
            || "",
          content_length: Number.isFinite(Number(normalized.structured_summary.content_length))
            ? Number(normalized.structured_summary.content_length)
            : 0,
        }
      : buildEmptyStructuredSummary(),
    key_concepts: normalizeConcepts(normalized.key_concepts),
    tags: normalizeTags(normalized.tags),
    notes: cleanText(normalized.notes) || "",
    learned_at: cleanText(normalized.learned_at) || null,
    updated_at: cleanText(normalized.updated_at) || null,
  };
}

export function parseLearningStateRow(row = {}) {
  if (!cleanText(row?.learning_status)) {
    return buildEmptyLearningState();
  }

  let structuredSummary = null;
  let keyConcepts = null;
  let tags = null;

  try {
    structuredSummary = row?.structured_summary_json
      ? JSON.parse(row.structured_summary_json)
      : null;
  } catch {
    structuredSummary = null;
  }

  try {
    keyConcepts = row?.key_concepts_json
      ? JSON.parse(row.key_concepts_json)
      : null;
  } catch {
    keyConcepts = null;
  }

  try {
    tags = row?.tags_json
      ? JSON.parse(row.tags_json)
      : null;
  } catch {
    tags = null;
  }

  return normalizeLearningState({
    status: row.learning_status,
    structured_summary: structuredSummary,
    key_concepts: keyConcepts,
    tags,
    notes: row.notes,
    learned_at: row.learned_at,
    updated_at: row.learning_updated_at || row.updated_at,
  });
}

export function buildLearningSearchText(state = {}) {
  const normalized = normalizeLearningState(state);
  if (normalized.status === "not_learned") {
    return "";
  }
  return [
    normalized.status,
    normalized.structured_summary.overview,
    normalized.structured_summary.snippet,
    ...normalized.structured_summary.headings,
    ...normalized.structured_summary.highlights,
    ...normalized.key_concepts,
    ...normalized.tags,
    normalized.notes,
  ].filter(Boolean).join("\n");
}

import {
  buildReadSourceItem,
  getReadSourceSnippet,
  getReadSourceTitle,
  getReadSourceUrl,
} from "./read-source-schema.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import { normalizeText } from "./text-utils.mjs";

const DEFAULT_PUBLIC_SOURCE_TYPE = "company_brain_doc";

function normalizeCompareText(text = "") {
  return normalizeText(String(text || ""))
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[「」"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildComparableBigrams(text = "") {
  const normalized = normalizeCompareText(text).replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
  if (!normalized) {
    return new Set();
  }
  if (normalized.length < 3) {
    return new Set([normalized]);
  }
  const grams = new Set();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    grams.add(normalized.slice(index, index + 2));
  }
  return grams;
}

function computeSnippetSimilarity(left = "", right = "") {
  const normalizedLeft = normalizeCompareText(left);
  const normalizedRight = normalizeCompareText(right);
  if (!normalizedLeft || !normalizedRight) {
    return 0;
  }
  if (
    normalizedLeft === normalizedRight
    || normalizedLeft.includes(normalizedRight)
    || normalizedRight.includes(normalizedLeft)
  ) {
    return 1;
  }

  const leftBigrams = buildComparableBigrams(normalizedLeft);
  const rightBigrams = buildComparableBigrams(normalizedRight);
  if (!leftBigrams.size || !rightBigrams.size) {
    return 0;
  }

  let intersection = 0;
  for (const token of leftBigrams) {
    if (rightBigrams.has(token)) {
      intersection += 1;
    }
  }

  return intersection / new Set([...leftBigrams, ...rightBigrams]).size;
}

function areSimilarSourceSnippets(left = "", right = "") {
  return computeSnippetSimilarity(left, right) >= 0.72;
}

function normalizeList(items = []) {
  return [...new Set(
    (Array.isArray(items) ? items : [])
      .map((item) => normalizeText(String(item || "")))
      .filter(Boolean),
  )];
}

function buildFallbackSourceId({ documentId = "", title = "", url = "", sourceType = "" } = {}) {
  return cleanText(documentId || url || title || sourceType);
}

function buildCanonicalAnswerSourceFromPlannerItem(item = {}, { query = "" } = {}) {
  const documentId = cleanText(item?.doc_id || item?.document_id || "");
  const title = cleanText(item?.title || "");
  const url = cleanText(item?.url || "");
  const sourceType = cleanText(item?.source_type || item?.sourceType || "") || DEFAULT_PUBLIC_SOURCE_TYPE;
  const snippet = cleanText(item?.reason || item?.snippet || item?.text || "");
  const id = cleanText(item?.id || "") || buildFallbackSourceId({
    documentId,
    title,
    url,
    sourceType,
  });

  if (!id || !snippet) {
    return null;
  }

  return buildReadSourceItem({
    id,
    snippet,
    metadata: {
      document_id: documentId,
      title,
      url,
      source_type: sourceType,
    },
  }, { query });
}

export function buildCanonicalAnswerSource(item = {}, { query = "" } = {}) {
  const canonical = buildReadSourceItem(item, { query });
  if (canonical) {
    return canonical;
  }
  return buildCanonicalAnswerSourceFromPlannerItem(item, { query });
}

export function buildCanonicalAnswerSources(items = [], { query = "" } = {}) {
  const normalizedItems = Array.isArray(items) ? items : [];
  const seen = new Set();
  const results = [];

  for (const item of normalizedItems) {
    const canonical = buildCanonicalAnswerSource(item, { query });
    if (!canonical || seen.has(canonical.id)) {
      continue;
    }
    seen.add(canonical.id);
    results.push(canonical);
  }

  return results;
}

function buildCanonicalSourceGroupLabel(items = []) {
  const labels = normalizeList((Array.isArray(items) ? items : []).map((item) => (
    getReadSourceTitle(item)
    || cleanText(item?.metadata?.document_id || "")
    || cleanText(item?.id || "")
  )));

  if (labels.length <= 1) {
    return labels[0] || "未命名來源";
  }
  if (labels.length === 2) {
    return labels.join("、");
  }
  return `${labels.slice(0, 2).join("、")} 等 ${labels.length} 份來源`;
}

function buildCanonicalSourceGroups(canonicalSources = []) {
  const groups = [];

  for (const item of Array.isArray(canonicalSources) ? canonicalSources : []) {
    const snippet = getReadSourceSnippet(item);
    if (!snippet) {
      continue;
    }
    const existingGroup = groups.find((group) => areSimilarSourceSnippets(group.primarySnippet, snippet));
    if (existingGroup) {
      existingGroup.items.push(item);
      existingGroup.snippets = normalizeList([...existingGroup.snippets, snippet]);
      continue;
    }
    groups.push({
      items: [item],
      snippets: [snippet],
      primarySnippet: snippet,
    });
  }

  return groups;
}

function renderCanonicalSourceGroupLine(group = {}) {
  const items = Array.isArray(group.items) ? group.items : [];
  const label = buildCanonicalSourceGroupLabel(items);
  const reasons = normalizeList(group.snippets || []).slice(0, 2);
  const reason = reasons.join("；");
  const url = items.length === 1 ? getReadSourceUrl(items[0]) : "";

  if (!label || !reason) {
    return "";
  }
  if (url) {
    return `${label}：${reason} 連結：${url}`;
  }
  return `${label}：${reason}`;
}

export function mapCanonicalAnswerSourcesToLines(canonicalSources = [], { maxSources = 3 } = {}) {
  return buildCanonicalSourceGroups(canonicalSources)
    .map((group) => renderCanonicalSourceGroupLine(group))
    .filter(Boolean)
    .slice(0, maxSources);
}

export function normalizeUserFacingAnswerSources(items = [], {
  query = "",
  maxSources = 3,
  allowStringSources = false,
} = {}) {
  const normalizedItems = Array.isArray(items) ? items : [];
  const stringItems = allowStringSources
    ? normalizeList(normalizedItems.filter((item) => typeof item === "string"))
    : [];
  const objectItems = normalizedItems.filter((item) => item && typeof item === "object" && !Array.isArray(item));

  const canonicalSources = buildCanonicalAnswerSources(objectItems, { query });
  return normalizeList([
    ...stringItems,
    ...mapCanonicalAnswerSourcesToLines(canonicalSources, { maxSources }),
  ]).slice(0, maxSources);
}

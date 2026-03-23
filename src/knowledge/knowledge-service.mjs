import { loadDocsFromDir } from './doc-loader.mjs';
import { searchDocsByKeyword } from './doc-index.mjs';
import { rankResults } from './rank-results.mjs';
import { cleanSnippet } from './snippet-cleaner.mjs';

let cachedIndex = null;
const QUERY_NORMALIZATION_MAP = {
  '交付': 'delivery',
  '流程': 'process',
  '設計': 'design',
  '商機': 'business',
  '管理': 'management',
  '系統': 'runtime system status',
  '穩不穩': 'stability health runtime status',
  '運行情況': 'runtime status health',
};
const QUERY_ALIAS_MAP = {
  okr: ['okr', '目標', 'goal', 'tracking'],
  bd: ['bd', '商機', 'business'],
  sop: ['sop', '交付', '流程', 'delivery', 'process'],
  delivery: ['delivery', '交付', '流程', 'process'],
  onboarding: ['onboarding', '導入', '交付', '流程'],
};

function shouldSuppressGenericBusinessExpansion(raw = '', latinTokens = []) {
  const explicitBusiness = latinTokens.some((token) => token.toLowerCase() === 'business');
  return !explicitBusiness && (raw.includes('商機') || latinTokens.some((token) => token.toLowerCase() === 'bd'));
}

export function getIndex() {
  if (!cachedIndex) cachedIndex = loadDocsFromDir('./docs/system');
  return cachedIndex;
}

function safeSlice(content, start, end) {
  const s = Math.max(0, start);
  const e = Math.min(content.length, end);
  return content.slice(s, e);
}

function splitIntoBlocks(content = '') {
  return String(content)
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean);
}

function getMatchedBlockIndex(blocks = [], keyword = '') {
  const normalizedKeyword = String(keyword || '').trim().toLowerCase();
  if (!normalizedKeyword) return -1;
  return blocks.findIndex((block) => block.toLowerCase().includes(normalizedKeyword));
}

function collectKeywordLineWindow(block = '', keyword = '') {
  const normalizedKeyword = String(keyword || '').trim().toLowerCase();
  if (!normalizedKeyword) return '';

  const lines = String(block)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const matchIndex = lines.findIndex((line) => line.toLowerCase().includes(normalizedKeyword));

  if (matchIndex === -1) return '';

  let start = matchIndex;
  let end = matchIndex;

  if (matchIndex > 0 && /[:：]$/.test(lines[matchIndex - 1].trim())) {
    start = matchIndex - 1;
  }

  while (end + 1 < lines.length) {
    const nextLine = lines[end + 1].trim();
    if (!nextLine) break;
    if (/^\s*#{1,6}\s+/.test(nextLine)) break;
    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(nextLine)) break;
    if (/^[A-Za-z][A-Za-z\s/_-]*[:：]\s*$/.test(nextLine)) break;
    end += 1;
    if (/[.。!?！？]$/.test(lines[end].trim())) break;
  }

  return lines.slice(start, end + 1).join('\n').trim();
}

function collectSnippetCandidates(content, keyword) {
  const blocks = splitIntoBlocks(content);
  const matchIndex = getMatchedBlockIndex(blocks, keyword);
  const candidates = [];

  if (matchIndex !== -1) {
    const block = blocks[matchIndex];
    const focusedWindow = collectKeywordLineWindow(block, keyword);
    if (focusedWindow) {
      candidates.push(focusedWindow);
    }
    if (block) {
      candidates.push(block);
    }
  }

  return candidates;
}

function extractSentenceWindow(content, keyword) {
  const normalizedContent = String(content || '');
  const normalizedKeyword = String(keyword || '').trim().toLowerCase();
  const lower = normalizedContent.toLowerCase();
  const index = normalizedKeyword ? lower.indexOf(normalizedKeyword) : -1;

  if (index === -1) {
    return normalizedContent.slice(0, 260);
  }

  let start = Math.max(0, index - 120);
  let end = Math.min(normalizedContent.length, index + Math.max(normalizedKeyword.length + 180, 220));

  const prevBreak = Math.max(
    normalizedContent.lastIndexOf('\n', start),
    normalizedContent.lastIndexOf('. ', start),
    normalizedContent.lastIndexOf('。', start),
    normalizedContent.lastIndexOf(': ', start),
    normalizedContent.lastIndexOf('：', start),
  );
  const nextCandidates = [
    normalizedContent.indexOf('\n', end),
    normalizedContent.indexOf('. ', end),
    normalizedContent.indexOf('。', end),
    normalizedContent.indexOf(': ', end),
    normalizedContent.indexOf('：', end),
  ].filter((candidate) => candidate !== -1);

  if (prevBreak !== -1) start = prevBreak + 1;
  if (nextCandidates.length > 0) end = Math.min(...nextCandidates) + 1;

  return safeSlice(normalizedContent, start, end).trim();
}

function extractSnippet(content, keyword) {
  const candidates = [
    ...collectSnippetCandidates(content, keyword),
    extractSentenceWindow(content, keyword),
    safeSlice(String(content || ''), 0, 260),
  ];

  for (const candidate of candidates) {
    const cleaned = cleanSnippet(candidate, keyword);
    if (!isLowValueSnippet(cleaned)) {
      return cleaned;
    }
  }

  return cleanSnippet(content, keyword);
}

function isLowValueSnippet(text) {
  if (!text) return true;
  const t = text.trim();
  if (t.length < 20) return true;
  if (/^\|.*\|$/.test(t)) return true;
  if (/^\/|^\.\/|^[A-Za-z]:\\/.test(t)) return true;
  if (/^[A-Za-z0-9_./-]+$/.test(t)) return true;
  if (/^(module|path|file|api|runtime)\s*[:/-]\s*$/i.test(t)) return true;
  if (/^[A-Za-z0-9_./-]+\s*:\s*$/.test(t)) return true;
  if (/[([<{/:;-]\s*$/.test(t) && !/[.。!?！？]$/.test(t)) return true;
  if (!/[.。!?！？:：]/.test(t) && /\b(runbook|guide|readme)\b/i.test(t)) return true;
  if (!/[.。!?！？:：]/.test(t) && (t.match(/[A-Za-z0-9]+/g) || []).length <= 3 && !/[\u4e00-\u9fff]/.test(t)) return true;
  return false;
}

function isRelevantSnippet(snippet, keyword) {
  if (!snippet) return false;

  const s = snippet.toLowerCase();
  const k = keyword.toLowerCase();

  if (!s.includes(k)) return false;
  if (s.includes('oauth') && k !== 'oauth') return false;

  return true;
}

export function queryKnowledge(keyword) {
  const index = getIndex();
  const hits = searchDocsByKeyword(index, keyword);
  return rankResults(hits, keyword);
}

export function queryKnowledgeWithSnippet(keyword) {
  return queryKnowledge(keyword).slice(0, 3).map(d => ({
    id: d.id,
    snippet: extractSnippet(d.content, keyword)
  }));
}

export function filterKnowledgeContextResults(results = [], keyword = "") {
  return (Array.isArray(results) ? results : [])
    .filter(r => !keyword || isRelevantSnippet(r?.snippet, keyword))
    .filter(r => !isLowValueSnippet(r?.snippet))
    .slice(0, 3);
}

function normalizeKnowledgeQueries(keyword) {
  const raw = typeof keyword === 'string' ? keyword.trim() : '';
  if (!raw) return [];

  const variants = [];
  const latinTokens = raw.match(/[A-Za-z0-9][A-Za-z0-9_-]*/g) || [];
  const suppressGenericBusiness = shouldSuppressGenericBusinessExpansion(raw, latinTokens);
  const aliasVariants = latinTokens.flatMap((token) => {
    const aliases = QUERY_ALIAS_MAP[token.toLowerCase()] || [];
    if (!suppressGenericBusiness || token.toLowerCase() !== 'bd') {
      return aliases;
    }
    return aliases.filter((alias) => alias.toLowerCase() !== 'business');
  });

  variants.push(...aliasVariants);

  Object.entries(QUERY_NORMALIZATION_MAP).forEach(([source, target]) => {
    if (raw.includes(source)) {
      variants.push(source);
      if (!(suppressGenericBusiness && source === '商機' && target.toLowerCase() === 'business')) {
        variants.push(target);
      }
    }
  });

  variants.push(...latinTokens, raw);

  return Array.from(
    new Set(
      variants
        .map(value => value.trim())
        .filter(Boolean),
    ),
  );
}

export function queryKnowledgeWithContext(keyword) {
  const queries = normalizeKnowledgeQueries(keyword);
  const merged = [];
  const seen = new Set();
  const buckets = queries
    .map((query) => ({
      query,
      results: filterKnowledgeContextResults(
        queryKnowledgeWithSnippet(query),
        query,
      ),
    }))
    .filter((bucket) => bucket.results.length > 0);

  while (merged.length < 3) {
    let progressed = false;

    buckets.forEach((bucket) => {
      if (merged.length >= 3) return;

      const next = bucket.results.find((result) => result?.id && !seen.has(result.id));
      if (!next) return;

      seen.add(next.id);
      merged.push(next);
      progressed = true;
    });

    if (!progressed) break;
  }

  return merged;
}

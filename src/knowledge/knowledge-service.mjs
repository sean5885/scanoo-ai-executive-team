import { loadDocsFromDir } from './doc-loader.mjs';
import { searchDocsByKeyword } from './doc-index.mjs';
import { rankResults } from './rank-results.mjs';

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

export function getIndex() {
  if (!cachedIndex) cachedIndex = loadDocsFromDir('./docs/system');
  return cachedIndex;
}

function safeSlice(content, start, end) {
  const s = Math.max(0, start);
  const e = Math.min(content.length, end);
  return content.slice(s, e);
}

function stripLeadingLabel(text) {
  let t = (text || '').trim();
  t = t.replace(/^\/Users\/[^\n]+\n?/gm, '');
  if (/^[A-Za-z\s]+\/[A-Za-z\s]+$/.test(t)) return '';
  t = t.replace(/^[A-Za-z\s\/]+-\s*(Purpose|用途|說明)\s*:\s*/i, '');
  t = t.replace(/^[A-Za-z\s\/]+\s*-\s*/, '');
  return t.trim();
}

function extractSnippet(content, keyword) {
  const lower = content.toLowerCase();
  const k = keyword.toLowerCase();
  const i = lower.indexOf(k);

  if (i === -1) return content.slice(0, 120);

  let start = Math.max(0, i - 80);
  let end = Math.min(content.length, i + 140);

  const prevBreak = Math.max(
    content.lastIndexOf('\n', start),
    content.lastIndexOf('. ', start),
    content.lastIndexOf('。', start),
    content.lastIndexOf(': ', start),
    content.lastIndexOf('：', start)
  );

  const nextCandidates = [
    content.indexOf('\n', end),
    content.indexOf('. ', end),
    content.indexOf('。', end),
    content.indexOf(': ', end),
    content.indexOf('：', end)
  ].filter(x => x !== -1);

  if (prevBreak !== -1) start = prevBreak + 1;
  if (nextCandidates.length > 0) end = Math.min(...nextCandidates) + 1;

  return stripLeadingLabel(safeSlice(content, start, end).trim());
}

function isLowValueSnippet(text) {
  if (!text) return true;
  const t = text.trim();
  if (t.length < 20) return true;
  if (/^\|.*\|$/.test(t)) return true;
  if (/^\/|^\.\/|^[A-Za-z]:\\/.test(t)) return true;
  if (/^[A-Za-z0-9_./-]+$/.test(t)) return true;
  if (/^(module|path|file|api|runtime)\s*[:/-]\s*$/i.test(t)) return true;
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

  const variants = [raw];
  const latinTokens = raw.match(/[A-Za-z0-9][A-Za-z0-9_-]*/g) || [];
  variants.push(...latinTokens);

  Object.entries(QUERY_NORMALIZATION_MAP).forEach(([source, target]) => {
    if (raw.includes(source)) {
      variants.push(source, target);
    }
  });

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

  queries.forEach((query) => {
    if (merged.length >= 3) return;

    const results = filterKnowledgeContextResults(
      queryKnowledgeWithSnippet(query),
      query,
    );

    results.forEach((result) => {
      if (merged.length >= 3) return;
      if (!result?.id || seen.has(result.id)) return;
      seen.add(result.id);
      merged.push(result);
    });
  });

  return merged;
}

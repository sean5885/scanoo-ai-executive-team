import { loadDocsFromDir } from './doc-loader.mjs';
import { searchDocsByKeyword } from './doc-index.mjs';
import { rankResults } from './rank-results.mjs';

let cachedIndex = null;

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

export function queryKnowledgeWithContext(keyword) {
  return queryKnowledgeWithSnippet(keyword)
    .filter(r => isRelevantSnippet(r.snippet, keyword))
    .filter(r => !isLowValueSnippet(r.snippet))
    .slice(0, 3);
}

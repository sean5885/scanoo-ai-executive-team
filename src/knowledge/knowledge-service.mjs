import { loadDocsFromDir } from './doc-loader.mjs';
import { searchDocsByKeyword } from './doc-index.mjs';

let cachedIndex = null;

export function getIndex() {
  if (!cachedIndex) {
    cachedIndex = loadDocsFromDir('./docs/system');
  }
  return cachedIndex;
}

function safeSlice(content, start, end) {
  const s = Math.max(0, start);
  const e = Math.min(content.length, end);
  return content.slice(s, e);
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
    content.lastIndexOf('：', start),
    content.lastIndexOf('- ', start)
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

  return safeSlice(content, start, end).trim();
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

export function queryKnowledge(keyword) {
  const index = getIndex();
  return searchDocsByKeyword(index, keyword);
}

export function queryKnowledgeWithSnippet(keyword) {
  const r = queryKnowledge(keyword);
  return r.slice(0, 3).map(d => ({
    id: d.id,
    snippet: extractSnippet(d.content, keyword)
  }));
}

export function queryKnowledgeWithContext(keyword) {
  const results = queryKnowledgeWithSnippet(keyword);
  return results.filter(r => !isLowValueSnippet(r.snippet)).slice(0, 3);
}

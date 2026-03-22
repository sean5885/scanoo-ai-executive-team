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

function isLocalPathLine(line) {
  const t = (line || "").trim();
  return /^[-*]?\s*`?\/Users\/[^\n`]+`?$/.test(t) || /^[-*]?\s*\.\/[^\s]+$/.test(t);
}

function stripLeadingLabel(text) {
  let t = (text || "").trim();

  t = t.replace(/^[-*]\s+/, "");

  if (/^[A-Za-z\s]+\/[A-Za-z\s]+$/.test(t)) return "";

  t = t.replace(/^[A-Za-z\s/]+-\s*(Purpose|用途|說明)\s*:\s*/i, "");
  t = t.replace(/^[A-Za-z\s/]+\s*-\s*/, "");

  return t.trim();
}

function normalizeSnippet(text) {
  const lines = (text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !isLocalPathLine(line));

  return stripLeadingLabel(lines.join("\n"));
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

  const snippet = safeSlice(content, start, end).trim();
  return normalizeSnippet(snippet);
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

function isLabelLike(text) {
  if (!text) return false;

  const t = text.trim();

  if (t.length < 40 && /^[A-Z][A-Za-z]*(?:[ /][A-Z][A-Za-z]*)+$/.test(t)) return true;
  if (/^(routing|execution|runtime|api|module|metadata)$/i.test(t)) return true;
  if (/^[A-Za-z\s]+\/[A-Za-z\s]+$/.test(t)) return true;

  return false;
}

export function filterKnowledgeContextResults(results) {
  return results
    .filter((result) => !isLowValueSnippet(result.snippet))
    .filter((result) => !isLabelLike(result.snippet))
    .slice(0, 3);
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
  return filterKnowledgeContextResults(results);
}

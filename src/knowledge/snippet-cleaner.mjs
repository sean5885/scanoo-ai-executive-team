const MAX_SNIPPET_LENGTH = 220;
const WEAK_TRAILING_TOKENS = /(?:and|or|to|for|with|without|of|in|on|at|by|via|from|is|are|was|were|be|being|been|the|a|an|that|which|who|when|where|if|then|但|且|與|和|或|及|在|是|為|把|將|對|於|的)$/i;

function stripAbsolutePaths(text = "") {
  return String(text)
    .replace(/\/Users\/[^\s)]+/g, "")
    .replace(/(?<=\s|^)\.\/[^\s)]+/g, "")
    .replace(/(?<=\s|^)[A-Za-z]:\\[^\s)]+/g, "");
}

function unwrapMarkdown(text = "") {
  return String(text)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/`+/g, "");
}

function cleanLine(line = "") {
  let value = stripAbsolutePaths(unwrapMarkdown(line))
    .replace(/^#{1,6}\s+/u, "")
    .replace(/^\s*>\s?/u, "")
    .replace(/^\s*[-*+]\s*/u, "")
    .replace(/^\s*\d+\.\s*/u, "")
    .trim();

  value = value
    .replace(/^(Loop Runbook|Delivery Guide|README)\s*[:\-]\s*/iu, "")
    .replace(/^[A-Za-z][A-Za-z\s/&]+\s*\/\s*[A-Za-z][A-Za-z\s/&-]*\s*-\s*/iu, "")
    .replace(/^(Purpose|Overview|Summary|Description|Notes?)\s*:\s*/iu, "")
    .replace(/\s+/gu, " ")
    .trim();

  return value;
}

function isNavigationLine(line = "") {
  return /^Back to\s+(?:[A-Za-z0-9_.-]+|\[[^\]]+\](?:\(\))?)/iu.test(line.trim());
}

function isPathLikeLine(line = "") {
  const value = line.trim();
  if (!value) return true;
  if (/^(?:\/|\.\/|[A-Za-z]:\\)/u.test(value)) return true;
  if (/^[A-Za-z0-9_./-]+$/u.test(value)) return true;
  if (/^[A-Za-z0-9_.-]+\.(md|mjs|js|json|toml|yaml|yml|txt)$/iu.test(value)) return true;
  return false;
}

function isIncompleteLine(line = "") {
  const value = line.trim();
  if (!value) return true;
  if (/^[`"'()[\]{}<>|*+/\-:;,.!?]+$/u.test(value)) return true;
  if (/^[A-Za-z0-9_.-]+\s*:\s*$/u.test(value)) return true;
  if (/^[A-Za-z][A-Za-z-]*(?:\s+[A-Za-z][A-Za-z-]*)*\s+checkpoint:\s*Thread\s+\d+\s*$/iu.test(value)) return true;
  if (/[([<{/:;-]\s*$/u.test(value) && !/[.。!?！？」』】]$/u.test(value)) return true;
  if (value.split(/\s+/u).length <= 2 && !/[。.!?！？:：]/u.test(value) && value.length < 12) return true;
  return false;
}

function isMeaningfulLine(line = "") {
  const value = line.trim();
  if (!value) return false;
  if (isNavigationLine(value) || isPathLikeLine(value) || isIncompleteLine(value)) return false;
  return /[A-Za-z\u4e00-\u9fff0-9]/u.test(value);
}

function dropLeadingNoise(lines = []) {
  const queue = [...lines];

  while (queue.length > 0) {
    const first = queue[0];
    if (isMeaningfulLine(first)) break;
    queue.shift();
  }

  return queue;
}

function splitIntoSegments(text = "") {
  return String(text)
    .split(/(?<=[。！？.!?])\s+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function pickFocusedText(text = "", keyword = "") {
  const normalizedKeyword = String(keyword || "").trim().toLowerCase();
  if (!text || !normalizedKeyword) return text;

  const segments = splitIntoSegments(text);
  if (segments.length === 0) return text;

  const index = segments.findIndex((segment) => segment.toLowerCase().includes(normalizedKeyword));
  if (index === -1) return text;

  const selected = [segments[index]];
  if (
    selected[0].length < 90
    && index + 1 < segments.length
    && !WEAK_TRAILING_TOKENS.test(selected[0])
  ) {
    selected.push(segments[index + 1]);
  }

  return selected.join(" ").trim();
}

function trimBrokenEdges(text = "") {
  let value = String(text)
    .replace(/^[^A-Za-z\u4e00-\u9fff0-9(【「『]+/u, "")
    .replace(/\s+/gu, " ")
    .trim();

  value = value
    .replace(/\s+([,.:;!?])/gu, "$1")
    .replace(/[|/,:;\-–—]+\s*$/u, "")
    .replace(/\b(?:and|or)\s*$/iu, "")
    .trim();

  if (WEAK_TRAILING_TOKENS.test(value) && !/[.。!?！？]$/u.test(value)) {
    value = value.replace(/\b(?:and|or|to|for|with|without|of|in|on|at|by|via|from|is|are|was|were|be|being|been|the|a|an|that|which|who|when|where|if|then)$/iu, "").trim();
    value = value.replace(/[但且與和或及在是為把將對於的]$/u, "").trim();
  }

  return value;
}

function clampSnippet(text = "", keyword = "") {
  if (text.length <= MAX_SNIPPET_LENGTH) return text;

  const normalizedKeyword = String(keyword || "").trim().toLowerCase();
  const lower = text.toLowerCase();
  const index = normalizedKeyword ? lower.indexOf(normalizedKeyword) : -1;
  if (index === -1) {
    return `${text.slice(0, MAX_SNIPPET_LENGTH).trimEnd()}...`;
  }

  let start = Math.max(0, index - 70);
  let end = Math.min(text.length, index + Math.max(normalizedKeyword.length + 120, 160));

  const leftBoundary = Math.max(
    text.lastIndexOf(". ", start),
    text.lastIndexOf("。", start),
    text.lastIndexOf("\n", start),
  );
  const rightCandidates = [
    text.indexOf(". ", end),
    text.indexOf("。", end),
    text.indexOf("\n", end),
  ].filter((candidate) => candidate !== -1);

  if (leftBoundary !== -1) start = leftBoundary + 1;
  if (rightCandidates.length > 0) end = Math.min(...rightCandidates) + 1;

  const clipped = text.slice(start, end).trim();
  if (clipped.length <= MAX_SNIPPET_LENGTH) return clipped;

  return `${clipped.slice(0, MAX_SNIPPET_LENGTH).trimEnd()}...`;
}

export function cleanSnippet(text, keyword) {
  if (!text) return "";

  const lines = String(text)
    .split(/\r?\n/u)
    .map((line) => cleanLine(line))
    .filter((line) => !isNavigationLine(line))
    .filter((line) => !isPathLikeLine(line))
    .filter((line) => !isIncompleteLine(line));

  const merged = dropLeadingNoise(lines).join(" ").replace(/\s+/gu, " ").trim();
  if (!merged) return "";

  const focused = pickFocusedText(merged, keyword);
  const trimmed = trimBrokenEdges(focused);
  if (!trimmed) return "";

  return clampSnippet(trimmed, keyword);
}

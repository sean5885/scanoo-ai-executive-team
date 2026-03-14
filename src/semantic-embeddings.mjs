import { normalizeText } from "./text-utils.mjs";

const DEFAULT_DIMENSIONS = 128;

function hashToken(token) {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function tokenize(text) {
  const normalized = normalizeText(text).toLowerCase();
  return normalized
    .split(/[\s,.;:!?()[\]{}"'`~@#$%^&*+=|\\/<>-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

export function embedTextLocally(text, dimensions = DEFAULT_DIMENSIONS) {
  const vector = new Array(dimensions).fill(0);
  const tokens = tokenize(text);
  if (!tokens.length) {
    return vector;
  }

  for (const token of tokens) {
    const hash = hashToken(token);
    const slot = hash % dimensions;
    vector[slot] += 1;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + (value * value), 0));
  if (!magnitude) {
    return vector;
  }

  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index] || 0);
    const b = Number(right[index] || 0);
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }

  if (!leftNorm || !rightNorm) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

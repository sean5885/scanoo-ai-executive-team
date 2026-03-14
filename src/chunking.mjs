import { chunkOverlapSize, chunkTargetSize } from "./config.mjs";
import { normalizeText, sha256 } from "./text-utils.mjs";

function splitParagraphs(text) {
  return normalizeText(text)
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function chunkText(text, options = {}) {
  const maxSize = options.targetSize || chunkTargetSize;
  const overlap = options.overlap || chunkOverlapSize;
  const paragraphs = splitParagraphs(text);
  const chunks = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxSize || !current) {
      current = candidate;
      continue;
    }

    chunks.push(current);
    const tail = current.slice(-overlap).trim();
    current = tail ? `${tail}\n\n${paragraph}` : paragraph;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks
    .map((content, index) => {
      const normalized = normalizeText(content);
      return {
        chunk_index: index,
        content,
        content_norm: normalized,
        char_count: normalized.length,
        chunk_hash: sha256(normalized),
      };
    })
    .filter((chunk) => chunk.content_norm);
}

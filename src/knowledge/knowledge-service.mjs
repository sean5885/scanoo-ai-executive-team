import { loadDocsFromDir } from "./doc-loader.mjs";
import { searchDocsByKeyword } from "./doc-index.mjs";

let cachedIndex = null;

export function getIndex() {
  if (!cachedIndex) {
    cachedIndex = loadDocsFromDir("./docs/system");
  }
  return cachedIndex;
}

export function queryKnowledge(keyword) {
  const index = getIndex();
  return searchDocsByKeyword(index, keyword);
}

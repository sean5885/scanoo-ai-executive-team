import {
  querySystemKnowledgeFromRuntimeSync,
  querySystemKnowledgeWithContextFromRuntimeSync,
  querySystemKnowledgeWithSnippetFromRuntimeSync,
} from "../read-runtime.mjs";

export { filterKnowledgeContextResults } from "./system-knowledge-core.mjs";

export function queryKnowledge(keyword) {
  return querySystemKnowledgeFromRuntimeSync({
    keyword,
  });
}

export function queryKnowledgeWithSnippet(keyword) {
  return querySystemKnowledgeWithSnippetFromRuntimeSync({
    keyword,
  });
}

export function queryKnowledgeWithContext(keyword) {
  return querySystemKnowledgeWithContextFromRuntimeSync({
    keyword,
  });
}

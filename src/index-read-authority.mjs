import {
  embeddingSearchTopK,
  searchTopK,
} from "./config.mjs";
import {
  getAccountContext,
  searchChunks,
  searchChunksBySemantic,
  searchChunksBySubstring,
} from "./rag-repository.mjs";
import {
  normalizeText,
  toSearchMatchQuery,
} from "./text-utils.mjs";
import {
  querySystemKnowledge,
  querySystemKnowledgeWithContext,
  querySystemKnowledgeWithSnippet,
} from "./knowledge/system-knowledge-core.mjs";

function buildSearchCandidates(query) {
  const normalized = normalizeText(query).replace(/[?？!！。]+$/g, "");
  const reduced = normalized
    .replace(/(是什麼|是什么|是啥|有什麼|有什么|有哪些|如何|怎麼|怎么)$/u, "")
    .trim();

  return [...new Set([normalized, reduced].filter(Boolean))];
}

function normalizePositiveInteger(value, fallback) {
  const normalized = Number.parseInt(`${value ?? ""}`, 10);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : fallback;
}

export function searchKnowledgeBaseByIndexAuthority(accountId, query, limit = searchTopK) {
  const accountContext = getAccountContext(accountId);
  if (!accountContext) {
    throw new Error("No authorized Lark account found. Complete OAuth first.");
  }

  const resolvedLimit = normalizePositiveInteger(limit, searchTopK);
  const candidates = buildSearchCandidates(query);
  const merged = new Map();

  for (const candidate of candidates) {
    const ftsItems = searchChunks(accountContext.account.id, toSearchMatchQuery(candidate), resolvedLimit);
    if (ftsItems.length) {
      for (const item of ftsItems) {
        merged.set(item.id, item);
      }
      break;
    }
  }

  if (!merged.size) {
    for (const candidate of candidates) {
      const semanticItems = searchChunksBySemantic(accountContext.account.id, candidate, embeddingSearchTopK);
      for (const item of semanticItems) {
        merged.set(item.id, item);
      }

      const substringItems = searchChunksBySubstring(accountContext.account.id, candidate, resolvedLimit);
      if (substringItems.length) {
        for (const item of substringItems) {
          merged.set(item.id, item);
        }
        break;
      }
    }
  }

  return {
    account: accountContext.account,
    items: [...merged.values()].slice(0, resolvedLimit),
  };
}

export function searchKnowledgeBaseIndexAction({ accountId, payload = {} } = {}) {
  const query = normalizeText(payload.q || payload.query);
  const limit = normalizePositiveInteger(payload.top_k ?? payload.limit, searchTopK);

  return {
    success: true,
    data: searchKnowledgeBaseByIndexAuthority(accountId, query, limit),
    error: null,
  };
}

export function querySystemKnowledgeIndexAction({ payload = {} } = {}) {
  return {
    success: true,
    data: {
      items: querySystemKnowledge(payload.q || payload.keyword),
    },
    error: null,
  };
}

export function querySystemKnowledgeWithSnippetIndexAction({ payload = {} } = {}) {
  return {
    success: true,
    data: {
      items: querySystemKnowledgeWithSnippet(payload.q || payload.keyword),
    },
    error: null,
  };
}

export function querySystemKnowledgeWithContextIndexAction({ payload = {} } = {}) {
  return {
    success: true,
    data: {
      items: querySystemKnowledgeWithContext(payload.q || payload.keyword),
    },
    error: null,
  };
}

import {
  getCompanyBrainDocDetailAction,
  listCompanyBrainDocsAction,
  searchCompanyBrainDocsAction,
} from "./company-brain-query.mjs";
import {
  getApprovedCompanyBrainKnowledgeDetailDerivedAction,
  getCompanyBrainLearningStateDetailAction,
  listApprovedCompanyBrainKnowledgeDerivedAction,
  listCompanyBrainLearningStateAction,
  searchApprovedCompanyBrainKnowledgeDerivedAction,
} from "./derived-read-authority.mjs";
import { searchKnowledgeBaseIndexAction } from "./index-read-authority.mjs";
import {
  getDocument,
  listDocumentComments,
} from "./lark-content.mjs";
import { cleanText } from "./message-intent-utils.mjs";

const INDEX_AUTHORITY = "index";
const MIRROR_AUTHORITY = "mirror";
const LIVE_AUTHORITY = "live";
const DERIVED_AUTHORITY = "derived";
const LIVE_REQUIRED_FRESHNESS = "live_required";

const INDEX_READERS = new Map([
  ["search_knowledge_base", ({ accountId, payload }) => searchKnowledgeBaseIndexAction({
    accountId,
    payload: {
      q: payload.q,
      limit: payload.limit,
      top_k: payload.top_k,
    },
  })],
]);

const MIRROR_READERS = new Map([
  ["list_company_brain_docs", ({ accountId, payload }) => listCompanyBrainDocsAction({
    accountId,
    limit: payload.limit,
  })],
  ["search_company_brain_docs", ({ accountId, payload }) => searchCompanyBrainDocsAction({
    accountId,
    q: payload.q,
    limit: payload.limit,
    top_k: payload.top_k,
    ranking_weights: payload.ranking_weights,
  })],
  ["get_company_brain_doc_detail", ({ accountId, payload }) => getCompanyBrainDocDetailAction({
    accountId,
    docId: payload.doc_id,
  })],
]);

const DERIVED_READERS = new Map([
  ["list_approved_company_brain_knowledge", ({ accountId, payload }) => listApprovedCompanyBrainKnowledgeDerivedAction({
    accountId,
    limit: payload.limit,
  })],
  ["search_approved_company_brain_knowledge", ({ accountId, payload }) => searchApprovedCompanyBrainKnowledgeDerivedAction({
    accountId,
    q: payload.q,
    limit: payload.limit,
    top_k: payload.top_k,
    ranking_weights: payload.ranking_weights,
  })],
  ["get_approved_company_brain_knowledge_detail", ({ accountId, payload }) => getApprovedCompanyBrainKnowledgeDetailDerivedAction({
    accountId,
    docId: payload.doc_id,
  })],
  ["list_company_brain_learning_state", ({ accountId, payload }) => listCompanyBrainLearningStateAction({
    accountId,
    limit: payload.limit,
  })],
  ["get_company_brain_learning_state_detail", ({ accountId, payload }) => getCompanyBrainLearningStateDetailAction({
    accountId,
    docId: payload.doc_id,
  })],
]);

const LIVE_READERS = new Map([
  ["read_document", async ({ payload, context }) => ({
    success: true,
    data: await getDocument(context.access_token, payload.doc_id),
    error: null,
  })],
  ["list_document_comments", async ({ payload, context }) => ({
    success: true,
    data: await listDocumentComments(context.access_token, payload.doc_id, {
      fileType: "docx",
      isSolved:
        payload.include_solved === true
          ? undefined
          : false,
      pageToken: payload.page_token || undefined,
      pageSize: Number.isFinite(Number(payload.page_size)) ? Number(payload.page_size) : undefined,
    }),
    error: null,
  })],
]);

function buildFailSoftQueryResult(error = "runtime_exception") {
  return {
    success: false,
    data: {},
    error: cleanText(error) || "runtime_exception",
  };
}

function normalizeReadPayload(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }

  return {
    q: cleanText(payload.q) || cleanText(payload.query) || "",
    doc_id: cleanText(payload.doc_id) || cleanText(payload.docId) || "",
    limit: payload.limit ?? null,
    top_k: payload.top_k ?? payload.topK ?? null,
    include_solved: payload.include_solved === true,
    page_token: cleanText(payload.page_token || payload.pageToken) || "",
    page_size: payload.page_size ?? payload.pageSize ?? null,
    ranking_weights:
      payload.ranking_weights && typeof payload.ranking_weights === "object" && !Array.isArray(payload.ranking_weights)
        ? { ...payload.ranking_weights }
        : null,
  };
}

function normalizeReaderOverrides(overrides = null) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return null;
  }
  return {
    live:
      overrides.live && typeof overrides.live === "object" && !Array.isArray(overrides.live)
        ? { ...overrides.live }
        : null,
    index:
      overrides.index && typeof overrides.index === "object" && !Array.isArray(overrides.index)
        ? { ...overrides.index }
        : null,
    mirror:
      overrides.mirror && typeof overrides.mirror === "object" && !Array.isArray(overrides.mirror)
        ? { ...overrides.mirror }
        : null,
    derived:
      overrides.derived && typeof overrides.derived === "object" && !Array.isArray(overrides.derived)
        ? { ...overrides.derived }
        : null,
  };
}

function normalizeReadContext(context = {}) {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return {};
  }

  return {
    pathname: cleanText(context.pathname) || null,
    freshness: cleanText(context.freshness),
    primary_authority: cleanText(context.primary_authority || context.primaryAuthority),
    access_token: cleanText(context.access_token || context.accessToken),
    reader_overrides: normalizeReaderOverrides(context.reader_overrides || context.readerOverrides),
  };
}

function resolveAuthorityForAction(action = "") {
  if (INDEX_READERS.has(action)) {
    return INDEX_AUTHORITY;
  }
  if (MIRROR_READERS.has(action)) {
    return MIRROR_AUTHORITY;
  }
  if (DERIVED_READERS.has(action)) {
    return DERIVED_AUTHORITY;
  }
  if (LIVE_READERS.has(action)) {
    return LIVE_AUTHORITY;
  }
  return null;
}

function resolveReaderForRequest(request = {}) {
  const overrides = request.context?.reader_overrides;
  if (request.primary_authority === INDEX_AUTHORITY) {
    const override = overrides?.index?.[request.action];
    if (typeof override === "function") {
      return override;
    }
    return INDEX_READERS.get(request.action) || null;
  }

  if (request.primary_authority === LIVE_AUTHORITY) {
    const override = overrides?.live?.[request.action];
    if (typeof override === "function") {
      return override;
    }
    return LIVE_READERS.get(request.action) || null;
  }

  if (request.primary_authority === DERIVED_AUTHORITY) {
    const override = overrides?.derived?.[request.action];
    if (typeof override === "function") {
      return override;
    }
    return DERIVED_READERS.get(request.action) || null;
  }

  const override = overrides?.mirror?.[request.action];
  if (typeof override === "function") {
    return override;
  }
  return MIRROR_READERS.get(request.action) || null;
}

export function assertCanonicalReadRequestSchema(request = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("invalid_canonical_read_request");
  }

  const action = cleanText(request.action || request.action_type);
  const accountId = cleanText(request.account_id || request.accountId);
  const authority = resolveAuthorityForAction(action);
  const context = normalizeReadContext(request.context);

  if (!action || !authority || !accountId) {
    throw new Error("invalid_canonical_read_request");
  }

  if (context.primary_authority && context.primary_authority !== authority) {
    throw new Error("invalid_canonical_read_request");
  }

  if (authority === LIVE_AUTHORITY) {
    if (context.freshness !== LIVE_REQUIRED_FRESHNESS || !context.access_token) {
      throw new Error("invalid_canonical_read_request");
    }
  }

  return {
    action,
    primary_authority: authority,
    account_id: accountId,
    payload: normalizeReadPayload(request.payload),
    context,
  };
}

function logReadRuntime(logger = null, event = {}) {
  logger?.debug?.("read_runtime", event);
}

export async function runRead({ canonicalRequest, logger = null } = {}) {
  let request = null;
  try {
    request = assertCanonicalReadRequestSchema(canonicalRequest);
  } catch {
    return {
      ok: false,
      action: cleanText(canonicalRequest?.action || canonicalRequest?.action_type) || null,
      primary_authority: null,
      authorities_attempted: [],
      fallback_used: false,
      result: buildFailSoftQueryResult("invalid_canonical_read_request"),
      error: "invalid_canonical_read_request",
    };
  }

  const reader = resolveReaderForRequest(request);
  if (typeof reader !== "function") {
    return {
      ok: false,
      action: request.action,
      primary_authority: request.primary_authority,
      authorities_attempted: [request.primary_authority],
      fallback_used: false,
      result: buildFailSoftQueryResult("runtime_exception"),
      error: "runtime_exception",
    };
  }
  let result = null;
  try {
    result = await reader({
      accountId: request.account_id,
      payload: request.payload,
      context: request.context,
    });
  } catch {
    result = buildFailSoftQueryResult("runtime_exception");
  }

  logReadRuntime(logger, {
    stage: "read_runtime",
    action: request.action,
    account_id: request.account_id,
    primary_authority: request.primary_authority,
    ok: result?.success === true,
    error: result?.success === true ? null : cleanText(result?.error) || "runtime_exception",
  });

  return {
    ok: result?.success === true,
    action: request.action,
    primary_authority: request.primary_authority,
    authorities_attempted: [request.primary_authority],
    fallback_used: false,
    result: result && typeof result === "object" && !Array.isArray(result)
      ? result
      : buildFailSoftQueryResult("runtime_exception"),
    error: result?.success === true ? null : cleanText(result?.error) || "runtime_exception",
  };
}

function buildLiveReadCanonicalRequest({
  action = "",
  accountId = "",
  accessToken = "",
  payload = {},
  pathname = "",
  readerOverrides = null,
} = {}) {
  return {
    action,
    account_id: cleanText(accountId) || "",
    payload: payload && typeof payload === "object" && !Array.isArray(payload)
      ? { ...payload }
      : {},
    context: {
      pathname: cleanText(pathname) || null,
      primary_authority: LIVE_AUTHORITY,
      freshness: LIVE_REQUIRED_FRESHNESS,
      access_token: cleanText(accessToken) || "",
      reader_overrides: readerOverrides && typeof readerOverrides === "object" && !Array.isArray(readerOverrides)
        ? { ...readerOverrides }
        : undefined,
    },
  };
}

async function unwrapReadExecution(readExecution = null) {
  if (readExecution?.result?.success === true) {
    return readExecution.result.data;
  }
  throw new Error(cleanText(readExecution?.error || readExecution?.result?.error) || "runtime_exception");
}

function buildIndexReadCanonicalRequest({
  action = "",
  accountId = "",
  payload = {},
  pathname = "",
  readerOverrides = null,
} = {}) {
  return {
    action,
    account_id: cleanText(accountId) || "",
    payload: payload && typeof payload === "object" && !Array.isArray(payload)
      ? { ...payload }
      : {},
    context: {
      pathname: cleanText(pathname) || null,
      primary_authority: INDEX_AUTHORITY,
      reader_overrides: readerOverrides && typeof readerOverrides === "object" && !Array.isArray(readerOverrides)
        ? { ...readerOverrides }
        : undefined,
    },
  };
}

function buildDerivedReadCanonicalRequest({
  action = "",
  accountId = "",
  payload = {},
  pathname = "",
  readerOverrides = null,
} = {}) {
  return {
    action,
    account_id: cleanText(accountId) || "",
    payload: payload && typeof payload === "object" && !Array.isArray(payload)
      ? { ...payload }
      : {},
    context: {
      pathname: cleanText(pathname) || null,
      primary_authority: DERIVED_AUTHORITY,
      reader_overrides: readerOverrides && typeof readerOverrides === "object" && !Array.isArray(readerOverrides)
        ? { ...readerOverrides }
        : undefined,
    },
  };
}

export async function readDocumentFromRuntime({
  accountId = "",
  accessToken = "",
  documentId = "",
  pathname = "internal:read_document",
  logger = null,
  readerOverrides = null,
} = {}) {
  const readExecution = await runRead({
    canonicalRequest: buildLiveReadCanonicalRequest({
      action: "read_document",
      accountId,
      accessToken,
      payload: {
        doc_id: documentId,
      },
      pathname,
      readerOverrides,
    }),
    logger,
  });
  return unwrapReadExecution(readExecution);
}

export async function searchKnowledgeBaseFromRuntime({
  accountId = "",
  query = "",
  limit = null,
  pathname = "internal:search_knowledge_base",
  logger = null,
  readerOverrides = null,
} = {}) {
  const readExecution = await runRead({
    canonicalRequest: buildIndexReadCanonicalRequest({
      action: "search_knowledge_base",
      accountId,
      payload: {
        q: cleanText(query) || "",
        limit,
        top_k: limit,
      },
      pathname,
      readerOverrides,
    }),
    logger,
  });

  return unwrapReadExecution(readExecution);
}

export async function listDocumentCommentsFromRuntime({
  accountId = "",
  accessToken = "",
  documentId = "",
  includeSolved = false,
  pageToken = "",
  pageSize = null,
  pathname = "internal:list_document_comments",
  logger = null,
  readerOverrides = null,
} = {}) {
  const readExecution = await runRead({
    canonicalRequest: buildLiveReadCanonicalRequest({
      action: "list_document_comments",
      accountId,
      accessToken,
      payload: {
        doc_id: documentId,
        include_solved: includeSolved === true,
        page_token: cleanText(pageToken) || "",
        page_size: pageSize,
      },
      pathname,
      readerOverrides,
    }),
    logger,
  });
  return unwrapReadExecution(readExecution);
}

export async function getApprovedCompanyBrainKnowledgeDetailFromRuntime({
  accountId = "",
  docId = "",
  pathname = "internal:get_approved_company_brain_knowledge_detail",
  logger = null,
  readerOverrides = null,
} = {}) {
  const readExecution = await runRead({
    canonicalRequest: buildDerivedReadCanonicalRequest({
      action: "get_approved_company_brain_knowledge_detail",
      accountId,
      payload: {
        doc_id: docId,
      },
      pathname,
      readerOverrides,
    }),
    logger,
  });
  return unwrapReadExecution(readExecution);
}

export async function getCompanyBrainLearningStateFromRuntime({
  accountId = "",
  docId = "",
  pathname = "internal:get_company_brain_learning_state_detail",
  logger = null,
  readerOverrides = null,
} = {}) {
  const readExecution = await runRead({
    canonicalRequest: buildDerivedReadCanonicalRequest({
      action: "get_company_brain_learning_state_detail",
      accountId,
      payload: {
        doc_id: docId,
      },
      pathname,
      readerOverrides,
    }),
    logger,
  });
  return unwrapReadExecution(readExecution);
}

import {
  getCompanyBrainDocRecordAction,
  getCompanyBrainDocDetailAction,
  listCompanyBrainDocsAction,
  searchCompanyBrainDocsAction,
} from "./company-brain-query.mjs";
import {
  getCompanyBrainApprovalStateAction,
  getApprovedCompanyBrainKnowledgeDetailDerivedAction,
  getCompanyBrainLearningStateDetailAction,
  listApprovedCompanyBrainKnowledgeDerivedAction,
  listCompanyBrainLearningStateAction,
  searchApprovedCompanyBrainKnowledgeDerivedAction,
} from "./derived-read-authority.mjs";
import {
  querySystemKnowledgeIndexAction,
  querySystemKnowledgeWithContextIndexAction,
  querySystemKnowledgeWithSnippetIndexAction,
  searchKnowledgeBaseIndexAction,
} from "./index-read-authority.mjs";
import {
  getDocument,
  listDocumentComments,
} from "./lark-content.mjs";
import { buildExecutionEnvelope } from "./execution-envelope.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import { buildReadSourceItems } from "./read-source-schema.mjs";

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
  ["query_system_knowledge", ({ payload }) => querySystemKnowledgeIndexAction({
    payload: {
      q: payload.q,
      keyword: payload.q,
    },
  })],
  ["query_system_knowledge_with_snippet", ({ payload }) => querySystemKnowledgeWithSnippetIndexAction({
    payload: {
      q: payload.q,
      keyword: payload.q,
    },
  })],
  ["query_system_knowledge_with_context", ({ payload }) => querySystemKnowledgeWithContextIndexAction({
    payload: {
      q: payload.q,
      keyword: payload.q,
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
  ["get_company_brain_doc_record", ({ accountId, payload }) => getCompanyBrainDocRecordAction({
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
  ["get_company_brain_approval_state", ({ accountId, payload }) => getCompanyBrainApprovalStateAction({
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

function normalizeReadAccessToken(accessToken = "") {
  if (typeof accessToken === "string") {
    return cleanText(accessToken);
  }
  if (accessToken && typeof accessToken === "object" && !Array.isArray(accessToken)) {
    return cleanText(accessToken.access_token || accessToken.accessToken);
  }
  return "";
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
    access_token: normalizeReadAccessToken(context.access_token || context.accessToken),
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

function buildReaderOverride(override = null) {
  if (typeof override === "function") {
    return override;
  }
  if (override && typeof override === "object" && !Array.isArray(override)) {
    return async () => JSON.parse(JSON.stringify(override));
  }
  return null;
}

function resolveReaderForRequest(request = {}) {
  const overrides = request.context?.reader_overrides;
  if (request.primary_authority === INDEX_AUTHORITY) {
    const override = buildReaderOverride(overrides?.index?.[request.action]);
    if (override) {
      return override;
    }
    return INDEX_READERS.get(request.action) || null;
  }

  if (request.primary_authority === LIVE_AUTHORITY) {
    const override = buildReaderOverride(overrides?.live?.[request.action]);
    if (override) {
      return override;
    }
    return LIVE_READERS.get(request.action) || null;
  }

  if (request.primary_authority === DERIVED_AUTHORITY) {
    const override = buildReaderOverride(overrides?.derived?.[request.action]);
    if (override) {
      return override;
    }
    return DERIVED_READERS.get(request.action) || null;
  }

  const override = buildReaderOverride(overrides?.mirror?.[request.action]);
  if (override) {
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

function normalizeReadResult(result = null, request = {}) {
  if (!result || typeof result !== "object" || Array.isArray(result) || result.success !== true) {
    return result;
  }

  if (request?.action !== "search_knowledge_base") {
    return result;
  }

  const data = result.data && typeof result.data === "object" && !Array.isArray(result.data)
    ? result.data
    : {};
  const items = Array.isArray(data.items) ? data.items : [];

  return {
    ...result,
    data: {
      ...data,
      items: buildReadSourceItems(items, {
        query: cleanText(request?.payload?.q || request?.payload?.query || ""),
      }),
    },
  };
}

export async function runRead({ canonicalRequest, logger = null } = {}) {
  let request = null;
  try {
    request = assertCanonicalReadRequestSchema(canonicalRequest);
  } catch {
    return buildExecutionEnvelope({
      ok: false,
      action: "get_runtime_info",
      data: buildFailSoftQueryResult("invalid_canonical_read_request"),
      meta: {
        primary_authority: null,
        authorities_attempted: [],
        fallback_used: false,
      },
      error: "invalid_canonical_read_request",
    });
  }

  const reader = resolveReaderForRequest(request);
  if (typeof reader !== "function") {
    return buildExecutionEnvelope({
      ok: false,
      action: "get_runtime_info",
      data: buildFailSoftQueryResult("runtime_exception"),
      meta: {
        primary_authority: request.primary_authority,
        authorities_attempted: [request.primary_authority],
        fallback_used: false,
      },
      error: "runtime_exception",
    });
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
  result = normalizeReadResult(result, request);

  logReadRuntime(logger, {
    stage: "read_runtime",
    action: request.action,
    account_id: request.account_id,
    primary_authority: request.primary_authority,
    ok: result?.success === true,
    error: result?.success === true ? null : cleanText(result?.error) || "runtime_exception",
  });

  return buildExecutionEnvelope({
    ok: result?.success === true,
    action: "get_runtime_info",
    data: result && typeof result === "object" && !Array.isArray(result)
      ? result
      : buildFailSoftQueryResult("runtime_exception"),
    meta: {
      primary_authority: request.primary_authority,
      authorities_attempted: [request.primary_authority],
      fallback_used: false,
    },
    error: result?.success === true ? null : cleanText(result?.error) || "runtime_exception",
  });
}

export function runReadSync({ canonicalRequest, logger = null } = {}) {
  let request = null;
  try {
    request = assertCanonicalReadRequestSchema(canonicalRequest);
  } catch {
    return buildExecutionEnvelope({
      ok: false,
      action: "get_runtime_info",
      data: buildFailSoftQueryResult("invalid_canonical_read_request"),
      meta: {
        primary_authority: null,
        authorities_attempted: [],
        fallback_used: false,
      },
      error: "invalid_canonical_read_request",
    });
  }

  if (request.primary_authority === LIVE_AUTHORITY) {
    return buildExecutionEnvelope({
      ok: false,
      action: "get_runtime_info",
      data: buildFailSoftQueryResult("runtime_exception"),
      meta: {
        primary_authority: request.primary_authority,
        authorities_attempted: [request.primary_authority],
        fallback_used: false,
      },
      error: "runtime_exception",
    });
  }

  const reader = resolveReaderForRequest(request);
  if (typeof reader !== "function") {
    return buildExecutionEnvelope({
      ok: false,
      action: "get_runtime_info",
      data: buildFailSoftQueryResult("runtime_exception"),
      meta: {
        primary_authority: request.primary_authority,
        authorities_attempted: [request.primary_authority],
        fallback_used: false,
      },
      error: "runtime_exception",
    });
  }

  let result = null;
  try {
    result = reader({
      accountId: request.account_id,
      payload: request.payload,
      context: request.context,
    });
  } catch {
    result = buildFailSoftQueryResult("runtime_exception");
  }

  if (result && typeof result.then === "function") {
    result = buildFailSoftQueryResult("runtime_exception");
  }
  result = normalizeReadResult(result, request);

  logReadRuntime(logger, {
    stage: "read_runtime",
    action: request.action,
    account_id: request.account_id,
    primary_authority: request.primary_authority,
    ok: result?.success === true,
    error: result?.success === true ? null : cleanText(result?.error) || "runtime_exception",
  });

  return buildExecutionEnvelope({
    ok: result?.success === true,
    action: "get_runtime_info",
    data: result && typeof result === "object" && !Array.isArray(result)
      ? result
      : buildFailSoftQueryResult("runtime_exception"),
    meta: {
      primary_authority: request.primary_authority,
      authorities_attempted: [request.primary_authority],
      fallback_used: false,
    },
    error: result?.success === true ? null : cleanText(result?.error) || "runtime_exception",
  });
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
      access_token: normalizeReadAccessToken(accessToken),
      reader_overrides: readerOverrides && typeof readerOverrides === "object" && !Array.isArray(readerOverrides)
        ? { ...readerOverrides }
        : undefined,
    },
  };
}

async function unwrapReadExecution(readExecution = null) {
  if (readExecution?.data?.success === true) {
    return readExecution.data.data;
  }
  throw new Error(cleanText(readExecution?.error || readExecution?.data?.error) || "runtime_exception");
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

function buildMirrorReadCanonicalRequest({
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
      primary_authority: MIRROR_AUTHORITY,
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

function unwrapReadExecutionSync(readExecution = null) {
  if (readExecution?.data?.success === true) {
    return readExecution.data.data;
  }
  return null;
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

export function querySystemKnowledgeFromRuntimeSync({
  keyword = "",
  pathname = "internal:query_system_knowledge",
  logger = null,
  readerOverrides = null,
} = {}) {
  const readExecution = runReadSync({
    canonicalRequest: buildIndexReadCanonicalRequest({
      action: "query_system_knowledge",
      accountId: "__system__",
      payload: {
        q: cleanText(keyword) || "",
      },
      pathname,
      readerOverrides,
    }),
    logger,
  });
  return unwrapReadExecutionSync(readExecution)?.items || [];
}

export function querySystemKnowledgeWithSnippetFromRuntimeSync({
  keyword = "",
  pathname = "internal:query_system_knowledge_with_snippet",
  logger = null,
  readerOverrides = null,
} = {}) {
  const readExecution = runReadSync({
    canonicalRequest: buildIndexReadCanonicalRequest({
      action: "query_system_knowledge_with_snippet",
      accountId: "__system__",
      payload: {
        q: cleanText(keyword) || "",
      },
      pathname,
      readerOverrides,
    }),
    logger,
  });
  return unwrapReadExecutionSync(readExecution)?.items || [];
}

export function querySystemKnowledgeWithContextFromRuntimeSync({
  keyword = "",
  pathname = "internal:query_system_knowledge_with_context",
  logger = null,
  readerOverrides = null,
} = {}) {
  const readExecution = runReadSync({
    canonicalRequest: buildIndexReadCanonicalRequest({
      action: "query_system_knowledge_with_context",
      accountId: "__system__",
      payload: {
        q: cleanText(keyword) || "",
      },
      pathname,
      readerOverrides,
    }),
    logger,
  });
  return unwrapReadExecutionSync(readExecution)?.items || [];
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

export function getCompanyBrainDocRecordFromRuntimeSync({
  accountId = "",
  docId = "",
  pathname = "internal:get_company_brain_doc_record",
  logger = null,
  readerOverrides = null,
} = {}) {
  const readExecution = runReadSync({
    canonicalRequest: buildMirrorReadCanonicalRequest({
      action: "get_company_brain_doc_record",
      accountId,
      payload: {
        doc_id: docId,
      },
      pathname,
      readerOverrides,
    }),
    logger,
  });
  return unwrapReadExecutionSync(readExecution);
}

export function getCompanyBrainDocDetailFromRuntimeSync({
  accountId = "",
  docId = "",
  pathname = "internal:get_company_brain_doc_detail",
  logger = null,
  readerOverrides = null,
} = {}) {
  const readExecution = runReadSync({
    canonicalRequest: buildMirrorReadCanonicalRequest({
      action: "get_company_brain_doc_detail",
      accountId,
      payload: {
        doc_id: docId,
      },
      pathname,
      readerOverrides,
    }),
    logger,
  });
  return unwrapReadExecutionSync(readExecution);
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

export function getApprovedCompanyBrainKnowledgeDetailFromRuntimeSync({
  accountId = "",
  docId = "",
  pathname = "internal:get_approved_company_brain_knowledge_detail",
  logger = null,
  readerOverrides = null,
} = {}) {
  const readExecution = runReadSync({
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
  return unwrapReadExecutionSync(readExecution);
}

export function getCompanyBrainLearningStateFromRuntimeSync({
  accountId = "",
  docId = "",
  pathname = "internal:get_company_brain_learning_state_detail",
  logger = null,
  readerOverrides = null,
} = {}) {
  const readExecution = runReadSync({
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
  return unwrapReadExecutionSync(readExecution);
}

export function getCompanyBrainApprovalStateFromRuntimeSync({
  accountId = "",
  docId = "",
  pathname = "internal:get_company_brain_approval_state",
  logger = null,
  readerOverrides = null,
} = {}) {
  const readExecution = runReadSync({
    canonicalRequest: buildDerivedReadCanonicalRequest({
      action: "get_company_brain_approval_state",
      accountId,
      payload: {
        doc_id: docId,
      },
      pathname,
      readerOverrides,
    }),
    logger,
  });
  return unwrapReadExecutionSync(readExecution);
}

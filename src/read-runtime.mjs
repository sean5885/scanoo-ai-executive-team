import {
  getApprovedCompanyBrainKnowledgeDetailAction,
  getCompanyBrainDocDetailAction,
  listApprovedCompanyBrainKnowledgeAction,
  listCompanyBrainDocsAction,
  searchApprovedCompanyBrainKnowledgeAction,
  searchCompanyBrainDocsAction,
} from "./company-brain-query.mjs";
import { cleanText } from "./message-intent-utils.mjs";

const MIRROR_AUTHORITY = "mirror";

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
  ["list_approved_company_brain_knowledge", ({ accountId, payload }) => listApprovedCompanyBrainKnowledgeAction({
    accountId,
    limit: payload.limit,
  })],
  ["search_approved_company_brain_knowledge", ({ accountId, payload }) => searchApprovedCompanyBrainKnowledgeAction({
    accountId,
    q: payload.q,
    limit: payload.limit,
    top_k: payload.top_k,
    ranking_weights: payload.ranking_weights,
  })],
  ["get_approved_company_brain_knowledge_detail", ({ accountId, payload }) => getApprovedCompanyBrainKnowledgeDetailAction({
    accountId,
    docId: payload.doc_id,
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
    ranking_weights:
      payload.ranking_weights && typeof payload.ranking_weights === "object" && !Array.isArray(payload.ranking_weights)
        ? { ...payload.ranking_weights }
        : null,
  };
}

export function assertCanonicalReadRequestSchema(request = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("invalid_canonical_read_request");
  }

  const action = cleanText(request.action || request.action_type);
  const accountId = cleanText(request.account_id || request.accountId);
  if (!action || !MIRROR_READERS.has(action) || !accountId) {
    throw new Error("invalid_canonical_read_request");
  }

  return {
    action,
    account_id: accountId,
    payload: normalizeReadPayload(request.payload),
    context:
      request.context && typeof request.context === "object" && !Array.isArray(request.context)
        ? { ...request.context }
        : {},
  };
}

function logReadRuntime(logger = null, event = {}) {
  logger?.debug?.("read_runtime", event);
}

export function runRead({ canonicalRequest, logger = null } = {}) {
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

  const reader = MIRROR_READERS.get(request.action);
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

  logReadRuntime(logger, {
    stage: "read_runtime",
    action: request.action,
    account_id: request.account_id,
    primary_authority: MIRROR_AUTHORITY,
    ok: result?.success === true,
    error: result?.success === true ? null : cleanText(result?.error) || "runtime_exception",
  });

  return {
    ok: result?.success === true,
    action: request.action,
    primary_authority: MIRROR_AUTHORITY,
    authorities_attempted: [MIRROR_AUTHORITY],
    fallback_used: false,
    result: result && typeof result === "object" && !Array.isArray(result)
      ? result
      : buildFailSoftQueryResult("runtime_exception"),
    error: result?.success === true ? null : cleanText(result?.error) || "runtime_exception",
  };
}

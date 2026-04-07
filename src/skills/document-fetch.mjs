export const SKILL_CONTRACT = Object.freeze({
  intent: "Resolve a document_id from direct input or raw Lark card payload and fetch plain-text document content through the existing auth boundary.",
  success_criteria: "Return { ok: true, document_id, content } when the document_id is valid, auth resolves, and plain-text document content is readable.",
  failure_criteria: "Fail closed with missing_access_token, permission_denied, or not_found when auth cannot be resolved, the document is inaccessible, or the document_id is invalid.",
});

import { fetchDocxPlainText } from "../lark-connectors.mjs";
import {
  isOAuthReauthRequiredError,
  resolveLarkRequestAuth,
} from "../lark-request-auth.mjs";
import { cleanText, extractDocumentId } from "../message-intent-utils.mjs";

export const DOCUMENT_FETCH_ERROR_TYPES = Object.freeze({
  MISSING_ACCESS_TOKEN: "missing_access_token",
  NOT_FOUND: "not_found",
  PERMISSION_DENIED: "permission_denied",
});

function isLikelyDocumentId(value = "") {
  const normalized = cleanText(value);
  return /^[A-Za-z0-9_-]{8,}$/.test(normalized);
}

function buildDocumentFetchError(type = DOCUMENT_FETCH_ERROR_TYPES.NOT_FOUND, {
  documentId = "",
  message = "",
} = {}) {
  return {
    ok: false,
    error: {
      type: cleanText(type) || DOCUMENT_FETCH_ERROR_TYPES.NOT_FOUND,
      document_id: cleanText(documentId) || null,
      message: cleanText(message) || null,
    },
  };
}

function resolveRawCardDocumentId(rawCard = null) {
  if (!rawCard) {
    return "";
  }
  if (typeof rawCard === "string") {
    return cleanText(extractDocumentId({ text: rawCard }));
  }
  if (typeof rawCard === "object" && !Array.isArray(rawCard)) {
    return cleanText(extractDocumentId(rawCard));
  }
  return "";
}

export function resolveDocumentFetchInput(input = {}) {
  const normalizedInput = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const documentId = cleanText(normalizedInput.document_id || normalizedInput.documentId || "");
  const rawCardDocumentId = resolveRawCardDocumentId(normalizedInput.raw_card || normalizedInput.rawCard || null);
  const resolvedDocumentId = documentId || rawCardDocumentId;

  return {
    document_id: resolvedDocumentId || "",
    auth: normalizedInput.auth
      ?? normalizedInput.request_auth
      ?? normalizedInput.requestAuth
      ?? normalizedInput.access_token
      ?? normalizedInput.accessToken
      ?? null,
    raw_card: normalizedInput.raw_card ?? normalizedInput.rawCard ?? null,
  };
}

export function normalizeDocumentFetchFailure(error, {
  documentId = "",
} = {}) {
  const message = cleanText(error?.message || String(error || ""));
  const code = cleanText(error?.code || error?.error || error?.type || "");
  const lowered = `${code} ${message}`.toLowerCase();

  if (
    code === "missing_access_token"
    || code === "missing_user_access_token"
    || lowered.includes("missing_access_token")
    || lowered.includes("missing_user_access_token")
  ) {
    return buildDocumentFetchError(DOCUMENT_FETCH_ERROR_TYPES.MISSING_ACCESS_TOKEN, {
      documentId,
      message: message || "missing_access_token",
    });
  }

  if (
    isOAuthReauthRequiredError(error)
    || error?.status === 401
    || error?.statusCode === 401
    || error?.status === 403
    || error?.statusCode === 403
    || lowered.includes("permission denied")
    || lowered.includes("permission_denied")
    || lowered.includes("forbidden")
    || lowered.includes("access denied")
    || lowered.includes("unauthorized")
    || lowered.includes("no permission")
  ) {
    return buildDocumentFetchError(DOCUMENT_FETCH_ERROR_TYPES.PERMISSION_DENIED, {
      documentId,
      message: message || code || "permission_denied",
    });
  }

  if (
    error?.status === 404
    || error?.statusCode === 404
    || lowered.includes("not found")
    || lowered.includes("not_found")
    || lowered.includes("invalid document")
    || lowered.includes("invalid_document")
    || lowered.includes("missing doc")
  ) {
    return buildDocumentFetchError(DOCUMENT_FETCH_ERROR_TYPES.NOT_FOUND, {
      documentId,
      message: message || code || "not_found",
    });
  }

  return buildDocumentFetchError(DOCUMENT_FETCH_ERROR_TYPES.NOT_FOUND, {
    documentId,
    message: message || code || "not_found",
  });
}

export async function fetchDocumentPlainText(input = {}, {
  resolveAuth = resolveLarkRequestAuth,
  fetchPlainText = fetchDocxPlainText,
} = {}) {
  const normalizedInput = resolveDocumentFetchInput(input);
  const documentId = cleanText(normalizedInput.document_id || "");

  if (!documentId || !isLikelyDocumentId(documentId)) {
    return buildDocumentFetchError(DOCUMENT_FETCH_ERROR_TYPES.NOT_FOUND, {
      documentId,
      message: "invalid_document_id",
    });
  }

  let auth;
  try {
    auth = await resolveAuth(normalizedInput.auth);
  } catch (error) {
    return normalizeDocumentFetchFailure(error, { documentId });
  }

  try {
    const content = await fetchPlainText(auth?.accessToken || auth?.access_token || auth, documentId);
    return {
      ok: true,
      document_id: documentId,
      content: typeof content === "string" ? content : cleanText(content),
    };
  } catch (error) {
    return normalizeDocumentFetchFailure(error, { documentId });
  }
}

export default fetchDocumentPlainText;

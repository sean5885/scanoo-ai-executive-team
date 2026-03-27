import { executeLarkWrite } from "./execute-lark-write.mjs";
import { getExternalMutationSpec } from "./external-mutation-registry.mjs";
import { replyMessage, sendMessage } from "./lark-content.mjs";
import { buildCanonicalMutationRequest } from "./mutation-admission.mjs";
import { runMutation } from "./mutation-runtime.mjs";
import { buildExternalWritePolicy } from "./write-policy-contract.mjs";

function cleanText(value) {
  return String(value || "").trim();
}

function cloneObject(value = null) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : null;
}

export function buildCanonicalExternalMutationRequest({
  action = "",
  pathname = "",
  method = "POST",
  accountId = null,
  resourceType = null,
  resourceId = null,
  scopeKey = null,
  idempotencyKey = null,
  confirmed = true,
  verifierCompleted = true,
  reviewRequiredActive = false,
  originalRequest = null,
} = {}) {
  const spec = getExternalMutationSpec(action);
  if (!spec) {
    throw new TypeError(`unknown_external_mutation_action:${cleanText(action) || "unknown"}`);
  }

  const writePolicy = buildExternalWritePolicy(action, {
    scopeKey,
    idempotencyKey,
  });
  if (!writePolicy) {
    throw new TypeError(`missing_external_write_policy:${cleanText(action) || "unknown"}`);
  }

  return buildCanonicalMutationRequest({
    actionType: action,
    resourceType: resourceType || spec.resource_type,
    resourceId,
    actor: {
      source: spec.source,
      owner: spec.owner,
      accountId,
    },
    context: {
      pathname,
      method,
      scopeKey: scopeKey ?? writePolicy.scope_key,
      idempotencyKey: idempotencyKey ?? writePolicy.idempotency_key,
      externalWrite: true,
      confirmed,
      verifierCompleted,
      reviewRequiredActive,
    },
    originalRequest,
  });
}

export async function runCanonicalLarkMutation({
  action = "",
  pathname = "",
  method = "POST",
  accountId = null,
  accessToken = null,
  logger = null,
  traceId = null,
  resourceType = null,
  resourceId = null,
  scopeKey = null,
  idempotencyKey = null,
  confirmed = true,
  verifierCompleted = true,
  reviewRequiredActive = false,
  originalRequest = null,
  payload = null,
  canonicalRequest = null,
  confirmation = null,
  budget = null,
  verifierProfile = "",
  verifierInput = null,
  performWrite = null,
  onSuccess = null,
  apiName = "",
} = {}) {
  const resolvedCanonicalRequest = canonicalRequest || buildCanonicalExternalMutationRequest({
    action,
    pathname,
    method,
    accountId,
    resourceType,
    resourceId,
    scopeKey,
    idempotencyKey,
    confirmed,
    verifierCompleted,
    reviewRequiredActive,
    originalRequest,
  });
  const resolvedWritePolicy = buildExternalWritePolicy(action, {
    scopeKey: scopeKey ?? resolvedCanonicalRequest?.context?.scope_key ?? null,
    idempotencyKey: idempotencyKey ?? resolvedCanonicalRequest?.context?.idempotency_key ?? null,
  });
  const resolvedBudget = cloneObject(budget) || {};

  if (!Object.prototype.hasOwnProperty.call(resolvedBudget, "scopeKey") && !Object.prototype.hasOwnProperty.call(resolvedBudget, "scope_key")) {
    resolvedBudget.scopeKey = resolvedCanonicalRequest?.context?.scope_key || null;
  }
  if (
    !Object.prototype.hasOwnProperty.call(resolvedBudget, "idempotencyKey")
    && !Object.prototype.hasOwnProperty.call(resolvedBudget, "idempotency_key")
    && cleanText(resolvedCanonicalRequest?.context?.idempotency_key)
  ) {
    resolvedBudget.idempotencyKey = resolvedCanonicalRequest.context.idempotency_key;
  }

  return runMutation({
    action,
    payload,
    context: {
      pathname,
      account_id: accountId,
      trace_id: traceId || null,
      logger,
      canonical_request: resolvedCanonicalRequest,
      ...(resolvedWritePolicy ? { write_policy: resolvedWritePolicy } : {}),
      ...(cleanText(verifierProfile) ? { verifier_profile: cleanText(verifierProfile) } : {}),
      ...(verifierInput && typeof verifierInput === "object" && !Array.isArray(verifierInput)
        ? { verifier_input: { ...verifierInput } }
        : {}),
    },
    execute: async () => executeLarkWrite({
      apiName: cleanText(apiName) || cleanText(action) || "external_mutation",
      action,
      pathname,
      accountId,
      accessToken,
      traceId: traceId || null,
      logger,
      confirmation: cloneObject(confirmation) || {},
      budget: resolvedBudget,
      performWrite,
      onSuccess,
    }),
  });
}

export async function executeCanonicalLarkMutation(options = {}) {
  const mutationExecution = await runCanonicalLarkMutation(options);
  return mutationExecution?.ok === true
    ? mutationExecution.result
    : mutationExecution;
}

function buildMessageScopeKey({ receiveIdType = "", receiveId = "" } = {}) {
  const normalizedType = cleanText(receiveIdType) || "message";
  const normalizedId = cleanText(receiveId);
  return normalizedId
    ? `${normalizedType}:${normalizedId}`
    : null;
}

export async function executeCanonicalLarkMessageReply({
  pathname = "/runtime/messages/reply",
  accountId = null,
  accessToken = null,
  logger = null,
  traceId = null,
  messageId = "",
  content = "",
  replyInThread = false,
  cardTitle = "",
  cardPayload = null,
  originalRequest = null,
  idempotencyKey = null,
} = {}) {
  const normalizedMessageId = cleanText(messageId);
  const scopeKey = buildMessageScopeKey({
    receiveIdType: "message",
    receiveId: normalizedMessageId,
  });

  return executeCanonicalLarkMutation({
    action: "message_reply",
    pathname,
    accountId,
    accessToken,
    logger,
    traceId,
    resourceId: normalizedMessageId || null,
    scopeKey,
    idempotencyKey,
    payload: {
      message_id: normalizedMessageId || null,
      reply_in_thread: replyInThread === true,
      has_card: Boolean(cardTitle || cardPayload),
    },
    originalRequest,
    budget: {
      sessionKey: accountId || scopeKey,
      scopeKey,
      targetDocumentId: normalizedMessageId || null,
      payload: {
        message_id: normalizedMessageId || null,
        reply_in_thread: replyInThread === true,
        has_card: Boolean(cardTitle || cardPayload),
      },
      ...(cleanText(idempotencyKey) ? { idempotencyKey: cleanText(idempotencyKey) } : {}),
    },
    performWrite: async ({ accessToken: runtimeAccessToken }) => replyMessage(
      runtimeAccessToken,
      normalizedMessageId,
      content,
      {
        replyInThread,
        cardTitle,
        cardPayload,
      },
    ),
  });
}

export async function executeCanonicalLarkMessageSend({
  pathname = "/runtime/messages/send",
  accountId = null,
  accessToken = null,
  logger = null,
  traceId = null,
  receiveId = "",
  receiveIdType = "chat",
  content = "",
  cardTitle = "",
  cardPayload = null,
  originalRequest = null,
  idempotencyKey = null,
} = {}) {
  const normalizedReceiveId = cleanText(receiveId);
  const normalizedReceiveIdType = cleanText(receiveIdType) || "chat";
  const scopeKey = buildMessageScopeKey({
    receiveIdType: normalizedReceiveIdType,
    receiveId: normalizedReceiveId,
  });

  return executeCanonicalLarkMutation({
    action: "message_send",
    pathname,
    accountId,
    accessToken,
    logger,
    traceId,
    resourceId: normalizedReceiveId || null,
    scopeKey,
    idempotencyKey,
    payload: {
      receive_id: normalizedReceiveId || null,
      receive_id_type: normalizedReceiveIdType,
      has_card: Boolean(cardTitle || cardPayload),
    },
    originalRequest,
    budget: {
      sessionKey: accountId || scopeKey,
      scopeKey,
      targetDocumentId: normalizedReceiveId || null,
      payload: {
        receive_id: normalizedReceiveId || null,
        receive_id_type: normalizedReceiveIdType,
        has_card: Boolean(cardTitle || cardPayload),
      },
      ...(cleanText(idempotencyKey) ? { idempotencyKey: cleanText(idempotencyKey) } : {}),
    },
    performWrite: async ({ accessToken: runtimeAccessToken }) => sendMessage(
      runtimeAccessToken,
      normalizedReceiveId,
      content,
      {
        receiveIdType: normalizedReceiveIdType,
        cardTitle,
        cardPayload,
      },
    ),
  });
}

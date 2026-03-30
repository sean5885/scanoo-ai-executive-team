import { executeLarkWrite } from "./execute-lark-write.mjs";
import { getExternalMutationSpec } from "./external-mutation-registry.mjs";
import { replyMessage, sendMessage } from "./lark-content.mjs";
import {
  buildCanonicalMutationRequest,
  buildCreateDocCanonicalRequest,
} from "./mutation-admission.mjs";
import { runMutation } from "./mutation-runtime.mjs";
import {
  buildCreateDocWritePolicy,
  buildExternalWritePolicy,
} from "./write-policy-contract.mjs";
import {
  consumeDocumentCreateConfirmation,
  createDocumentCreateConfirmation,
  peekDocumentCreateConfirmation,
} from "./doc-update-confirmations.mjs";
import { planDocumentCreateGuard } from "./lark-write-guard.mjs";

function cleanText(value) {
  return String(value || "").trim();
}

function cloneObject(value = null) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : null;
}

function cloneRecord(value = null) {
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
  rollback = null,
  audit = null,
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
      ...(typeof rollback === "function" ? { rollback } : {}),
      ...(audit && typeof audit === "object" && !Array.isArray(audit) ? { audit } : {}),
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

export async function runDocumentCreateMutation({
  pathname = "/api/doc/create",
  accountId = null,
  account = null,
  accessToken = null,
  logger = null,
  traceId = null,
  originalRequest = null,
  title = "",
  requestedFolderToken = "",
  content = "",
  source = "",
  owner = "",
  intent = "",
  type = "",
  confirm = false,
  confirmationId = "",
  idempotencyKey = null,
  previewOnMissingConfirmation = true,
  createConfirmation = createDocumentCreateConfirmation,
  peekConfirmation = peekDocumentCreateConfirmation,
  consumeConfirmation = consumeDocumentCreateConfirmation,
  rollback = null,
  audit = null,
  performWrite = null,
} = {}) {
  const createGuard = planDocumentCreateGuard({
    title,
    source,
    requestedFolderToken,
    account,
    requireConfirmation: false,
    confirmed: confirm,
  });
  if (!createGuard.ok) {
    return {
      ok: false,
      stage: "guard_blocked",
      error: createGuard.error,
      message: createGuard.message,
      statusCode: createGuard.statusCode,
      create_guard: createGuard,
      write_policy: buildCreateDocWritePolicy({
        folderToken: requestedFolderToken,
        idempotencyKey,
      }),
    };
  }

  const folderToken = createGuard.resolved_folder_token || undefined;
  const writePolicy = buildCreateDocWritePolicy({
    folderToken,
    idempotencyKey,
  });
  const effectiveConfirm = confirm === true;
  const effectiveConfirmationId = cleanText(confirmationId);

  if (!effectiveConfirm) {
    if (previewOnMissingConfirmation !== false) {
      const preview = await createConfirmation({
        accountId,
        title,
        requestedFolderToken,
        resolvedFolderToken: folderToken,
        content,
        source,
        owner,
        intent,
        type,
      });
      return {
        ok: true,
        stage: "preview_ready",
        preview,
        create_guard: createGuard,
        write_policy: writePolicy,
        requested_folder_token: requestedFolderToken || null,
        resolved_folder_token: folderToken || null,
      };
    }

    return {
      ok: false,
      stage: "confirmation_required",
      error: "lark_write_confirmation_required",
      message: "Document creation requires explicit confirmation. Preview first, then re-submit with confirm=true and confirmation_id.",
      statusCode: 409,
      create_guard: createGuard,
      write_policy: writePolicy,
      requested_folder_token: requestedFolderToken || null,
      resolved_folder_token: folderToken || null,
    };
  }

  const canonicalRequest = buildCreateDocCanonicalRequest({
    pathname,
    method: "POST",
    folderToken,
    context: {
      idempotencyKey,
      confirmed: true,
      verifierCompleted: true,
      reviewRequiredActive: false,
    },
    originalRequest,
  });
  const mutationExecution = await runCanonicalLarkMutation({
    action: "create_doc",
    pathname,
    accountId,
    accessToken,
    logger,
    traceId,
    canonicalRequest,
    ...(typeof rollback === "function" ? { rollback } : {}),
    ...(audit && typeof audit === "object" && !Array.isArray(audit) ? { audit } : {}),
    payload: {
      title,
      folder_token: folderToken || null,
      requested_folder_token: requestedFolderToken || null,
      content,
      confirmation_id: effectiveConfirmationId || null,
      confirm: effectiveConfirm === true,
      source: source || "api_doc_create",
      owner: owner || null,
      intent: intent || null,
      type: type || null,
    },
    confirmation: {
      kind: "document_create",
      requireConfirm: true,
      requireConfirmationId: true,
      confirm: effectiveConfirm,
      confirmationId: effectiveConfirmationId,
      peek: async () => peekConfirmation({
        confirmationId: effectiveConfirmationId,
        accountId,
      }),
      consume: async () => consumeConfirmation({
        confirmationId: effectiveConfirmationId,
        accountId,
        title,
        requestedFolderToken,
        resolvedFolderToken: folderToken,
        content,
      }),
      invalidMessage: "The document creation confirmation is missing or expired.",
    },
    budget: {
      sessionKey: accountId,
      scopeKey: writePolicy?.scope_key || null,
      targetDocumentId: folderToken || null,
      content,
      payload: {
        title,
        folder_token: folderToken || null,
        requested_folder_token: requestedFolderToken || null,
        source: source || "api_doc_create",
        owner: owner || null,
        intent: intent || null,
        type: type || null,
      },
      idempotencyKey,
    },
    performWrite: async (runtimeInput) => performWrite({
      ...runtimeInput,
      folderToken,
      requestedFolderToken,
      createGuard: cloneRecord(createGuard),
      writePolicy: cloneRecord(writePolicy),
      confirmationId: effectiveConfirmationId,
      confirm: effectiveConfirm,
    }),
  });

  return {
    ok: mutationExecution?.ok === true,
    stage: "mutation_executed",
    mutation_execution: mutationExecution,
    create_guard: createGuard,
    write_policy: writePolicy,
    requested_folder_token: requestedFolderToken || null,
    resolved_folder_token: folderToken || null,
    confirmation_id: effectiveConfirmationId || null,
    confirm: effectiveConfirm === true,
  };
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

import {
  executeCanonicalLarkMessageReply,
  executeCanonicalLarkMessageSend,
} from "./lark-mutation-runtime.mjs";
import {
  getStoredAccountContext,
  getStoredAccountContextByOpenId,
  getTenantAccessToken,
  getValidUserToken,
} from "./lark-user-auth.mjs";
import { createRequestId, formatIdentifierHint } from "./runtime-observability.mjs";

const RECENT_REPLY_SUPPRESSION_WINDOW_MS = 20 * 1000;
const recentReplySuppressionStore = new Map();

function cleanText(value) {
  return String(value || "").trim();
}

function normalizeLogger(logger = null) {
  return logger && typeof logger === "object" ? logger : console;
}

function inferReplyMsgType(reply = {}) {
  return reply.replyMode === "card" || reply.cardTitle || reply.cardPayload
    ? "interactive"
    : "text";
}

function summarizeRawApiResponse(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return {
    operation: cleanText(value.operation) || null,
    code: Number.isFinite(Number(value.code)) ? Number(value.code) : null,
    msg: cleanText(value.msg) || null,
    log_id: cleanText(value.log_id) || null,
    request_id: cleanText(value.request_id) || null,
    http_status: Number.isFinite(Number(value.http_status)) ? Number(value.http_status) : null,
    data: value.data && typeof value.data === "object" && !Array.isArray(value.data)
      ? {
          message_id: cleanText(value.data.message_id) || null,
          chat_id: cleanText(value.data.chat_id) || null,
          root_id: cleanText(value.data.root_id) || null,
          parent_id: cleanText(value.data.parent_id) || null,
          thread_id: cleanText(value.data.thread_id) || null,
          upper_message_id: cleanText(value.data.upper_message_id) || null,
          msg_type: cleanText(value.data.msg_type) || null,
          create_time: cleanText(value.data.create_time) || null,
          update_time: cleanText(value.data.update_time) || null,
          deleted: value.data.deleted === true,
          updated: value.data.updated === true,
        }
      : null,
  };
}

function buildLaneReplyIdempotencyKey({
  event = null,
  reply = {},
  requestId = "",
} = {}) {
  const messageId = cleanText(event?.message?.message_id);
  const chatId = cleanText(event?.message?.chat_id);
  const mode = cleanText(reply?.replyMode) || "text";
  const baseKey = messageId || `${chatId || "unknown_chat"}:${cleanText(requestId) || "unknown_request"}`;
  return cleanText(`lane_reply:${baseKey}:${mode}`);
}

function buildReplyLogFields({
  requestId = "",
  traceId = null,
  event = null,
  reply = null,
  auth = null,
  receiveId = "",
  receiveIdType = "chat_id",
  targetMessageId = "",
  idempotencyKey = "",
} = {}) {
  const message = event?.message || {};
  return {
    request_id: cleanText(requestId) || null,
    trace_id: cleanText(traceId) || null,
    event_id: cleanText(message.message_id) || null,
    chat_id: cleanText(message.chat_id) || null,
    receive_id: cleanText(receiveId) || null,
    receive_id_type: cleanText(receiveIdType) || null,
    target_message_id: cleanText(targetMessageId) || null,
    msg_type: inferReplyMsgType(reply || {}),
    root_id: cleanText(message.root_id) || null,
    parent_id: cleanText(message.parent_id) || null,
    upper_message_id: cleanText(message.upper_message_id) || null,
    thread_id: cleanText(message.thread_id) || null,
    reply_mode: cleanText(reply?.replyMode) || "text",
    idempotency_key: cleanText(idempotencyKey) || null,
    auth_mode: cleanText(auth?.tokenType) || null,
    token_source: cleanText(auth?.source) || null,
    account_id: cleanText(auth?.accountId) || null,
    sender_open_id: formatIdentifierHint(message?.sender_open_id || event?.sender?.sender_id?.open_id),
  };
}

function buildReplySendFailureError(message = "reply_send_failed", details = {}) {
  const error = new Error(message);
  error.code = "reply_send_failed";
  error.details = details;
  return error;
}

function buildRecentReplySuppressionKey({
  event = null,
  reply = {},
} = {}) {
  const chatId = cleanText(event?.message?.chat_id);
  const senderOpenId = cleanText(event?.sender?.sender_id?.open_id || event?.message?.sender_open_id);
  const mode = cleanText(reply?.replyMode) || "text";
  const text = cleanText(reply?.text).replace(/\s+/g, " ").slice(0, 280);
  if (!chatId || !senderOpenId || !mode || !text) {
    return "";
  }
  return `${chatId}::${senderOpenId}::${mode}::${text}`;
}

function sweepRecentReplySuppression(now = Date.now()) {
  for (const [key, expiresAt] of recentReplySuppressionStore.entries()) {
    if (Number(expiresAt || 0) <= now) {
      recentReplySuppressionStore.delete(key);
    }
  }
}

export function resetRecentReplySuppressionForTests() {
  recentReplySuppressionStore.clear();
}

export async function resolveRuntimeReplyAuth({
  reply = {},
  event = null,
} = {}) {
  const explicitAccessToken = reply?.accessToken ?? reply?.access_token ?? null;
  const explicitTokenType = cleanText(
    reply?.accessTokenType
    || reply?.access_token_type
    || explicitAccessToken?.token_type
    || "",
  ) || null;
  const senderOpenId = cleanText(event?.sender?.sender_id?.open_id);
  const scoped = senderOpenId ? await getStoredAccountContextByOpenId(senderOpenId) : null;
  const fallback = scoped || await getStoredAccountContext();
  const accountId = cleanText(reply?.accountId || reply?.account_id || fallback?.account?.id || senderOpenId || event?.message?.chat_id);

  if (explicitAccessToken) {
    return {
      accountId,
      accessToken: explicitAccessToken,
      tokenType: explicitTokenType || "user",
      source: "reply_explicit_token",
    };
  }

  try {
    const tenantToken = await getTenantAccessToken();
    return {
      accountId,
      accessToken: tenantToken,
      tokenType: "tenant",
      source: "tenant_bot_token",
    };
  } catch (tenantError) {
    if (fallback?.account?.id) {
      const userToken = await getValidUserToken(fallback.account.id);
      if (userToken?.access_token) {
        return {
          accountId: fallback.account.id,
          accessToken: userToken,
          tokenType: "user",
          source: "user_token_fallback",
        };
      }
    }
    throw tenantError;
  }
}

export async function sendLaneReply({
  event,
  reply = {},
  traceId = null,
  logger = null,
  resolveReplyAuth = resolveRuntimeReplyAuth,
  executeMessageSend = executeCanonicalLarkMessageSend,
  executeMessageReply = executeCanonicalLarkMessageReply,
  nowMs = Date.now(),
} = {}) {
  const chatId = cleanText(event?.message?.chat_id);
  const messageId = cleanText(event?.message?.message_id);
  const text = cleanText(reply?.text);
  if (!chatId || !text) {
    throw buildReplySendFailureError("reply_send_missing_chat_or_text", {
      chat_id: chatId || null,
      has_text: Boolean(text),
    });
  }

  const eventLogger = normalizeLogger(logger);
  const requestId = createRequestId("reply");
  const replySuppressionKey = buildRecentReplySuppressionKey({ event, reply });
  sweepRecentReplySuppression(nowMs);
  if (replySuppressionKey) {
    const existingExpiry = recentReplySuppressionStore.get(replySuppressionKey);
    if (Number(existingExpiry || 0) > nowMs) {
      eventLogger.info("reply_send_suppressed", {
        request_id: requestId,
        trace_id: cleanText(traceId) || null,
        event_id: messageId || null,
        chat_id: chatId || null,
        suppression_reason: "duplicate_reply_within_window",
      });
      return {
        request_id: requestId,
        suppressed: true,
        reason: "duplicate_reply_within_window",
      };
    }
  }
  const auth = await resolveReplyAuth({ reply, event });
  const idempotencyKey = buildLaneReplyIdempotencyKey({
    event,
    reply,
    requestId,
  });
  const baseFields = buildReplyLogFields({
    requestId,
    traceId,
    event,
    reply,
    auth,
    receiveId: chatId,
    receiveIdType: "chat_id",
    targetMessageId: messageId,
    idempotencyKey,
  });
  eventLogger.info("reply_send_attempted", baseFields);

  const execution = reply.replyMode === "card" && messageId
    ? await executeMessageReply({
        pathname: "/runtime/index/lane-reply-card",
        accountId: auth.accountId,
        accessToken: auth.accessToken,
        logger: eventLogger,
        traceId,
        messageId,
        content: text,
        replyInThread: true,
        cardTitle: reply.cardTitle || null,
        cardPayload: reply.cardPayload || null,
        idempotencyKey,
      })
    : await executeMessageSend({
        pathname: "/runtime/index/lane-reply",
        accountId: auth.accountId,
        accessToken: auth.accessToken,
        logger: eventLogger,
        traceId,
        receiveId: chatId,
        receiveIdType: "chat_id",
        content: text,
        cardTitle: reply.cardTitle || null,
        cardPayload: reply.cardPayload || null,
        idempotencyKey,
      });

  const evidence = execution?.result?.__send_evidence || execution?.meta?.journal?.error_details || null;
  const rawApiResponse = summarizeRawApiResponse(evidence?.raw_response);
  const sentMessageId = cleanText(execution?.result?.message_id);
  const resultChatId = cleanText(execution?.result?.chat_id);
  const expectedMsgType = inferReplyMsgType(reply || {});
  const resultMsgType = cleanText(execution?.result?.msg_type);
  const targetMismatch = Boolean(resultChatId && resultChatId !== chatId);
  const msgTypeMismatch = Boolean(expectedMsgType && resultMsgType && resultMsgType !== expectedMsgType);

  if (execution?.ok !== true || !sentMessageId || targetMismatch || msgTypeMismatch) {
    const failureError = cleanText(execution?.error)
      || (!sentMessageId
        ? "missing_message_id"
        : targetMismatch
          ? "target_mismatch"
          : msgTypeMismatch
            ? "msg_type_mismatch"
            : "reply_send_failed");
    const failureDetails = {
      ...baseFields,
      error: failureError,
      status_code: Number.isFinite(Number(execution?.statusCode || execution?.data?.statusCode))
        ? Number(execution?.statusCode || execution?.data?.statusCode)
        : null,
      message: cleanText(execution?.message || execution?.data?.message) || null,
      api_http_status: Number.isFinite(Number(evidence?.http_status)) ? Number(evidence.http_status) : null,
      api_raw_response: rawApiResponse,
      message_id: sentMessageId || null,
      result_chat_id: resultChatId || null,
      result_msg_type: resultMsgType || null,
    };
    eventLogger.warn("reply_send_failed", failureDetails);
    throw buildReplySendFailureError("reply_send_failed", failureDetails);
  }

  eventLogger.info("reply_send_succeeded", {
    ...baseFields,
    message_id: sentMessageId,
    result_chat_id: cleanText(execution?.result?.chat_id) || null,
    result_msg_type: cleanText(execution?.result?.msg_type) || null,
    api_http_status: Number.isFinite(Number(evidence?.http_status)) ? Number(evidence.http_status) : null,
    api_raw_response: rawApiResponse,
  });
  if (replySuppressionKey) {
    recentReplySuppressionStore.set(
      replySuppressionKey,
      nowMs + RECENT_REPLY_SUPPRESSION_WINDOW_MS,
    );
  }

  return {
    request_id: requestId,
    execution,
    result: execution.result,
    auth,
  };
}

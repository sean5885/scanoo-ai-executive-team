import * as Lark from "@larksuiteoapi/node-sdk";
import { baseConfig, botName } from "./config.mjs";
import { resolveLarkBindingRuntime } from "./binding-runtime.mjs";
import { startCommentSuggestionPoller } from "./comment-suggestion-poller.mjs";
import { buildLaneFailureReply } from "./capability-lane.mjs";
import { executeCapabilityLane } from "./lane-executor.mjs";
import {
  executeCanonicalLarkMessageReply,
  executeCanonicalLarkMessageSend,
} from "./lark-mutation-runtime.mjs";
import { createRuntimeLogger, createTraceId, summarizeLarkEvent } from "./runtime-observability.mjs";
import { startHttpServer } from "./http-server.mjs";
import { enforceSingleLarkResponderRuntime } from "./runtime-conflict-guard.mjs";
import { createMessageEventDeduper } from "./runtime-message-deduper.mjs";
import { touchResolvedSession } from "./session-scope-store.mjs";

const runtimeLogger = createRuntimeLogger({ logger: console, component: "long_connection" });
const messageEventDeduper = createMessageEventDeduper();

async function sendLaneReply(event, reply = {}) {
  const chatId = event?.message?.chat_id;
  const messageId = event?.message?.message_id;
  const text = String(reply.text || "").trim();
  const accountId = event?.sender?.sender_id?.open_id || event?.sender?.sender_id?.union_id || chatId || null;
  const eventLogger = runtimeLogger.child("message_runtime", {
    action: "lane_reply",
    chat_id: chatId || null,
    message_id: messageId || null,
  });

  if (!chatId || !text) {
    return null;
  }

  if (reply.replyMode === "card" && messageId && reply.accessToken) {
    const execution = await executeCanonicalLarkMessageReply({
      pathname: "/runtime/index/lane-reply-card",
      accountId,
      accessToken: reply.accessToken,
      logger: eventLogger,
      messageId,
      content: text,
      replyInThread: true,
      cardTitle: reply.cardTitle || botName,
    });
    return execution.ok === true ? execution.result : execution;
  }

  const execution = await executeCanonicalLarkMessageSend({
    pathname: "/runtime/index/lane-reply",
    accountId,
    accessToken: reply.accessToken,
    logger: eventLogger,
    receiveId: chatId,
    receiveIdType: "chat_id",
    content: text,
  });
  return execution.ok === true ? execution.result : execution;
}

const eventDispatcher = new Lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    const chatId = data?.message?.chat_id;
    const senderType = data?.sender?.sender_type;
    const eventSummary = summarizeLarkEvent(data);
    const traceId = createTraceId("evt");
    const eventLogger = runtimeLogger.child("event", { trace_id: traceId, ...eventSummary });

    if (!chatId || senderType === "app") {
      eventLogger.info("event_skipped", {
        reason: !chatId ? "missing_chat_id" : "sender_is_app",
      });
      return;
    }

    eventLogger.info("event_received");

    if (!messageEventDeduper.shouldProcess(data?.message?.message_id)) {
      eventLogger.warn("event_skipped", {
        reason: "duplicate_message_id",
      });
      return;
    }

    let scope = null;
    try {
      scope = resolveLarkBindingRuntime({ event: data });
      eventLogger.info("lane_resolved", {
        capability_lane: scope.capability_lane,
        chosen_lane: scope.capability_lane,
        lane_reason: scope.lane_reason,
        session_key: scope.session_key,
      });

      await touchResolvedSession(scope);

      const reply = await executeCapabilityLane({
        event: data,
        scope,
        logger: runtimeLogger.child(scope.capability_lane || "lane", {
          trace_id: traceId,
          ...eventSummary,
        }),
        traceId,
      });
      if (reply?.suppressReply) {
        eventLogger.info("reply_suppressed", {
          capability_lane: scope.capability_lane,
        });
        return;
      }
      if (!reply?.text) {
        eventLogger.warn("lane_returned_empty_reply", {
          capability_lane: scope.capability_lane,
        });
        await sendLaneReply(data, {
          text: `${botName} 已連上長連接，之後我會按對話 scope 自動分到對應能力模式。`,
          accessToken: scope?.accessToken || null,
        });
        return;
      }

      await sendLaneReply(data, reply);
      eventLogger.info("reply_sent", {
        capability_lane: scope.capability_lane,
        reply_mode: reply.replyMode || "text",
        card_title: reply.cardTitle || null,
      });
    } catch (error) {
      eventLogger.error("event_processing_failed", {
        capability_lane: scope?.capability_lane || null,
        error: runtimeLogger.compactError(error),
      });

      if (!chatId) {
        return;
      }

      try {
        await sendLaneReply(data, {
          text: buildLaneFailureReply(scope, scope),
          accessToken: scope?.accessToken || null,
        });
        eventLogger.warn("error_reply_sent", {
          capability_lane: scope?.capability_lane || null,
        });
      } catch (replyError) {
        eventLogger.error("error_reply_failed", {
          capability_lane: scope?.capability_lane || null,
          error: runtimeLogger.compactError(replyError),
        });
      }
    }
  },
});

const wsClient = new Lark.WSClient({
  ...baseConfig,
  loggerLevel: Lark.LoggerLevel.info,
});
const httpServer = startHttpServer();
const commentSuggestionPoller = startCommentSuggestionPoller({ logger: console });

process.on("SIGINT", () => {
  runtimeLogger.info("service_shutdown_requested", {
    action: "service_shutdown",
    signal: "SIGINT",
    status: "stopping",
  });
  commentSuggestionPoller.stop();
  httpServer.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  runtimeLogger.info("service_shutdown_requested", {
    action: "service_shutdown",
    signal: "SIGTERM",
    status: "stopping",
  });
  commentSuggestionPoller.stop();
  httpServer.close();
  process.exit(0);
});

runtimeLogger.info("service_starting", {
  action: "service_start",
  bot_name: botName,
  status: "starting",
});
await enforceSingleLarkResponderRuntime({ logger: runtimeLogger.child("runtime_guard") });
wsClient.start({ eventDispatcher });

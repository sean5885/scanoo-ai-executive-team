import * as Lark from "@larksuiteoapi/node-sdk";
import { baseConfig, botName } from "./config.mjs";
import { resolveLarkBindingRuntime } from "./binding-runtime.mjs";
import { startCommentSuggestionPoller } from "./comment-suggestion-poller.mjs";
import { buildLaneFailureReply } from "./capability-lane.mjs";
import { executeCapabilityLane } from "./lane-executor.mjs";
import { replyMessage } from "./lark-content.mjs";
import { createRuntimeLogger, summarizeLarkEvent } from "./runtime-observability.mjs";
import { startHttpServer } from "./http-server.mjs";
import { touchResolvedSession } from "./session-scope-store.mjs";

const client = new Lark.Client(baseConfig);
const runtimeLogger = createRuntimeLogger({ logger: console, component: "long_connection" });

async function replyToChat(chatId, text) {
  return client.im.v1.message.create({
    params: {
      receive_id_type: "chat_id",
    },
    data: {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    },
  });
}

async function sendLaneReply(event, reply = {}) {
  const chatId = event?.message?.chat_id;
  const messageId = event?.message?.message_id;
  const text = String(reply.text || "").trim();

  if (!chatId || !text) {
    return null;
  }

  if (reply.replyMode === "card" && messageId && reply.accessToken) {
    return replyMessage(reply.accessToken, messageId, text, {
      replyInThread: true,
      cardTitle: reply.cardTitle || botName,
    });
  }

  return replyToChat(chatId, text);
}

const eventDispatcher = new Lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    const chatId = data?.message?.chat_id;
    const senderType = data?.sender?.sender_type;
    const eventSummary = summarizeLarkEvent(data);

    if (!chatId || senderType === "app") {
      runtimeLogger.info("event_skipped", {
        ...eventSummary,
        reason: !chatId ? "missing_chat_id" : "sender_is_app",
      });
      return;
    }

    runtimeLogger.info("event_received", eventSummary);

    let scope = null;
    try {
      scope = resolveLarkBindingRuntime({ event: data });
      runtimeLogger.info("lane_resolved", {
        ...eventSummary,
        capability_lane: scope.capability_lane,
        lane_reason: scope.lane_reason,
        session_key: scope.session_key,
      });

      await touchResolvedSession(scope);

      const reply = await executeCapabilityLane({
        event: data,
        scope,
        logger: runtimeLogger.child(scope.capability_lane || "lane"),
      });
      if (!reply?.text) {
        runtimeLogger.warn("lane_returned_empty_reply", {
          ...eventSummary,
          capability_lane: scope.capability_lane,
        });
        await replyToChat(chatId, `${botName} 已連上長連接，之後我會按對話 scope 自動分到對應能力模式。`);
        return;
      }

      await sendLaneReply(data, reply);
      runtimeLogger.info("reply_sent", {
        ...eventSummary,
        capability_lane: scope.capability_lane,
        reply_mode: reply.replyMode || "text",
        card_title: reply.cardTitle || null,
      });
    } catch (error) {
      runtimeLogger.error("event_processing_failed", {
        ...eventSummary,
        capability_lane: scope?.capability_lane || null,
        error: runtimeLogger.compactError(error),
      });

      if (!chatId) {
        return;
      }

      try {
        await replyToChat(chatId, buildLaneFailureReply(scope, scope));
        runtimeLogger.warn("error_reply_sent", {
          ...eventSummary,
          capability_lane: scope?.capability_lane || null,
        });
      } catch (replyError) {
        runtimeLogger.error("error_reply_failed", {
          ...eventSummary,
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
  console.log("Shutting down Lark services...");
  commentSuggestionPoller.stop();
  httpServer.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Shutting down Lark services...");
  commentSuggestionPoller.stop();
  httpServer.close();
  process.exit(0);
});

console.log(`Starting ${botName} with long connection...`);
wsClient.start({ eventDispatcher });

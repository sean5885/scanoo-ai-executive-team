import * as Lark from "@larksuiteoapi/node-sdk";
import { baseConfig, botName, larkDirectIngressPrimaryEnabled } from "./config.mjs";
import { resolveLarkBindingRuntime } from "./binding-runtime.mjs";
import { startCommentSuggestionPoller } from "./comment-suggestion-poller.mjs";
import { buildLaneFailureReply } from "./capability-lane.mjs";
import { resolveDirectIngressSourceState } from "./lark-plugin-dispatch-adapter.mjs";
import { executeCapabilityLane } from "./lane-executor.mjs";
import { createRuntimeLogger, createTraceId, summarizeLarkEvent } from "./runtime-observability.mjs";
import { startHttpServer } from "./http-server.mjs";
import { enforceSingleLarkResponderRuntime } from "./runtime-conflict-guard.mjs";
import { createMessageEventDeduper } from "./runtime-message-deduper.mjs";
import { sendLaneReply } from "./runtime-message-reply.mjs";
import { touchResolvedSession } from "./session-scope-store.mjs";
import {
  startAutonomyRuntimeManager,
  stopAutonomyRuntimeManager,
} from "./worker/autonomy-runtime-manager.mjs";

const runtimeLogger = createRuntimeLogger({ logger: console, component: "long_connection" });
const messageEventDeduper = createMessageEventDeduper();

const eventDispatcher = new Lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    const chatId = data?.message?.chat_id;
    const senderType = data?.sender?.sender_type;
    const eventSummary = summarizeLarkEvent(data);
    const traceId = createTraceId("evt");
    const eventLogger = runtimeLogger.child("event", {
      trace_id: traceId,
      event_id: data?.message?.message_id || null,
      ...eventSummary,
    });

    if (!chatId || senderType === "app") {
      eventLogger.info("event_skipped", {
        reason: !chatId ? "missing_chat_id" : "sender_is_app",
      });
      return;
    }

    const directIngressState = resolveDirectIngressSourceState({
      source: "direct_lark_long_connection",
      directIngressPrimaryEnabled: larkDirectIngressPrimaryEnabled,
    });
    eventLogger.info("event_received", {
      ingress_primary: directIngressState.is_primary_entry === true,
      ingress_note: directIngressState.fallback_reason || null,
    });

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
        await sendLaneReply({
          event: data,
          reply: {
            text: `${botName} 已連上長連接，之後我會按對話 scope 自動分到對應能力模式。`,
          },
          traceId,
          logger: runtimeLogger.child("message_runtime", {
            trace_id: traceId,
            ...eventSummary,
            action: "lane_reply",
          }),
        });
        return;
      }

      await sendLaneReply({
        event: data,
        reply,
        traceId,
        logger: runtimeLogger.child("message_runtime", {
          trace_id: traceId,
          ...eventSummary,
          action: "lane_reply",
          capability_lane: scope.capability_lane,
        }),
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
        await sendLaneReply({
          event: data,
          reply: {
            text: buildLaneFailureReply(scope, scope),
          },
          traceId,
          logger: runtimeLogger.child("message_runtime", {
            trace_id: traceId,
            ...eventSummary,
            action: "lane_reply",
            capability_lane: scope?.capability_lane || null,
          }),
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
const autonomyRuntimeLogger = runtimeLogger.child("autonomy_runtime_manager");

process.on("SIGINT", () => {
  runtimeLogger.info("service_shutdown_requested", {
    action: "service_shutdown",
    signal: "SIGINT",
    status: "stopping",
  });
  stopAutonomyRuntimeManager({ logger: autonomyRuntimeLogger });
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
  stopAutonomyRuntimeManager({ logger: autonomyRuntimeLogger });
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

const autonomyRuntimeStatus = startAutonomyRuntimeManager({
  logger: autonomyRuntimeLogger,
});
if (autonomyRuntimeStatus.status !== "running") {
  runtimeLogger.warn("autonomy_runtime_manager_not_running", {
    status: autonomyRuntimeStatus.status,
    reason: autonomyRuntimeStatus.error?.reason || null,
  });
}

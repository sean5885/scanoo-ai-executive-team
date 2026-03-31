import test from "node:test";
import assert from "node:assert/strict";

import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const {
  sendLaneReply,
} = await import("../src/runtime-message-reply.mjs");

test.after(() => {
  testDb.close();
});

function createLoggerCalls() {
  const calls = [];
  return {
    calls,
    logger: {
      info(event, payload) {
        calls.push({ level: "info", event, payload });
      },
      warn(event, payload) {
        calls.push({ level: "warn", event, payload });
      },
      error(event, payload) {
        calls.push({ level: "error", event, payload });
      },
    },
  };
}

function attachSendEvidence(result = {}, evidence = {}) {
  Object.defineProperty(result, "__send_evidence", {
    value: evidence,
    enumerable: false,
    configurable: true,
  });
  return result;
}

test("sendLaneReply logs success only when execution is ok and message_id is present", async () => {
  const { calls, logger } = createLoggerCalls();
  const captured = [];
  await sendLaneReply({
    event: {
      sender: {
        sender_id: {
          open_id: "ou_user_1",
        },
      },
      message: {
        chat_id: "oc_chat_1",
        message_id: "om_event_1",
        root_id: "om_root_1",
      },
    },
    reply: {
      text: "bot reply",
    },
    traceId: "evt_trace_1",
    logger,
    async resolveReplyAuth() {
      return {
        accountId: "acct_1",
        accessToken: { accessToken: "tenant-token", tokenType: "tenant" },
        tokenType: "tenant",
        source: "tenant_bot_token",
      };
    },
    async executeMessageSend(input) {
      captured.push(input);
      return {
        ok: true,
        result: attachSendEvidence({
          message_id: "om_reply_1",
          chat_id: "oc_chat_1",
          msg_type: "text",
        }, {
          http_status: 200,
          raw_response: {
            code: 0,
            request_id: "req_lark_send_1",
            data: {
              message_id: "om_reply_1",
              chat_id: "oc_chat_1",
              msg_type: "text",
            },
          },
        }),
      };
    },
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].receiveId, "oc_chat_1");
  assert.equal(captured[0].receiveIdType, "chat_id");
  assert.equal(captured[0].accountId, "acct_1");
  assert.equal(calls[0].event, "reply_send_attempted");
  assert.equal(calls[1].event, "reply_send_succeeded");
  assert.equal(calls[1].payload.message_id, "om_reply_1");
  assert.equal(calls[1].payload.api_raw_response.data.message_id, "om_reply_1");
});

test("sendLaneReply treats ok results without message_id as failed and never logs success", async () => {
  const { calls, logger } = createLoggerCalls();

  await assert.rejects(
    () => sendLaneReply({
      event: {
        sender: {
          sender_id: {
            open_id: "ou_user_1",
          },
        },
        message: {
          chat_id: "oc_chat_1",
          message_id: "om_event_2",
        },
      },
      reply: {
        text: "bot reply",
      },
      traceId: "evt_trace_2",
      logger,
      async resolveReplyAuth() {
        return {
          accountId: "acct_1",
          accessToken: { accessToken: "tenant-token", tokenType: "tenant" },
          tokenType: "tenant",
          source: "tenant_bot_token",
        };
      },
      async executeMessageSend() {
        return {
          ok: true,
          result: attachSendEvidence({
            chat_id: "oc_chat_1",
            msg_type: "text",
          }, {
            http_status: 200,
            raw_response: {
              code: 0,
              request_id: "req_lark_send_2",
              data: {
                chat_id: "oc_chat_1",
                msg_type: "text",
              },
            },
          }),
        };
      },
    }),
    /reply_send_failed/,
  );

  assert.equal(calls[0].event, "reply_send_attempted");
  assert.equal(calls[1].event, "reply_send_failed");
  assert.equal(calls[1].payload.message_id, null);
  assert.equal(calls.some((entry) => entry.event === "reply_send_succeeded"), false);
});

test("sendLaneReply surfaces execution failures instead of treating resolved envelopes as success", async () => {
  const { calls, logger } = createLoggerCalls();

  await assert.rejects(
    () => sendLaneReply({
      event: {
        sender: {
          sender_id: {
            open_id: "ou_user_1",
          },
        },
        message: {
          chat_id: "oc_chat_1",
          message_id: "om_event_3",
        },
      },
      reply: {
        text: "bot reply",
      },
      traceId: "evt_trace_3",
      logger,
      async resolveReplyAuth() {
        return {
          accountId: "acct_1",
          accessToken: { accessToken: "tenant-token", tokenType: "tenant" },
          tokenType: "tenant",
          source: "tenant_bot_token",
        };
      },
      async executeMessageSend() {
        return {
          ok: false,
          error: "execution_failed",
          data: {
            statusCode: 500,
            message: "missing_user_access_token",
          },
          meta: {
            journal: {
              error_details: {
                http_status: 401,
                raw_response: {
                  code: 99991663,
                  msg: "missing token",
                },
              },
            },
          },
        };
      },
    }),
    /reply_send_failed/,
  );

  assert.equal(calls[0].event, "reply_send_attempted");
  assert.equal(calls[1].event, "reply_send_failed");
  assert.equal(calls[1].payload.error, "execution_failed");
  assert.equal(calls[1].payload.api_raw_response.code, 99991663);
  assert.equal(calls.some((entry) => entry.event === "reply_send_succeeded"), false);
});

test("sendLaneReply rejects responses whose target chat does not match the requested chat", async () => {
  const { calls, logger } = createLoggerCalls();

  await assert.rejects(
    () => sendLaneReply({
      event: {
        sender: {
          sender_id: {
            open_id: "ou_user_1",
          },
        },
        message: {
          chat_id: "oc_chat_expected",
          message_id: "om_event_4",
        },
      },
      reply: {
        text: "bot reply",
      },
      traceId: "evt_trace_4",
      logger,
      async resolveReplyAuth() {
        return {
          accountId: "acct_1",
          accessToken: { accessToken: "tenant-token", tokenType: "tenant" },
          tokenType: "tenant",
          source: "tenant_bot_token",
        };
      },
      async executeMessageSend() {
        return {
          ok: true,
          result: attachSendEvidence({
            message_id: "om_reply_4",
            chat_id: "oc_chat_actual",
            msg_type: "text",
          }, {
            http_status: 200,
            raw_response: {
              code: 0,
              request_id: "req_lark_send_4",
              data: {
                message_id: "om_reply_4",
                chat_id: "oc_chat_actual",
                msg_type: "text",
              },
            },
          }),
        };
      },
    }),
    /reply_send_failed/,
  );

  assert.equal(calls[0].event, "reply_send_attempted");
  assert.equal(calls[1].event, "reply_send_failed");
  assert.equal(calls[1].payload.error, "target_mismatch");
  assert.equal(calls[1].payload.result_chat_id, "oc_chat_actual");
  assert.equal(calls.some((entry) => entry.event === "reply_send_succeeded"), false);
});

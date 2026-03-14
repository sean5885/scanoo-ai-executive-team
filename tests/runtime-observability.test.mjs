import test from "node:test";
import assert from "node:assert/strict";

import {
  createRuntimeLogger,
  formatIdentifierHint,
  summarizeLarkEvent,
} from "../src/runtime-observability.mjs";

test("formatIdentifierHint 會縮短較長識別碼", () => {
  assert.equal(formatIdentifierHint("om_1234567890abcdef"), "om_123...cdef");
  assert.equal(formatIdentifierHint("short_id"), "short_id");
  assert.equal(formatIdentifierHint(""), null);
});

test("summarizeLarkEvent 會抽出並遮罩關鍵事件欄位", () => {
  const summary = summarizeLarkEvent({
    message: {
      message_id: "om_1234567890abcdef",
      chat_id: "oc_1234567890abcdef",
      chat_type: "group",
      message_type: "text",
      parent_id: "om_parent_123456",
      root_id: "om_root_abcdef12",
    },
    sender: {
      sender_id: {
        open_id: "ou_1234567890abcdef",
      },
    },
  });

  assert.equal(summary.chat_type, "group");
  assert.equal(summary.msg_type, "text");
  assert.equal(summary.message_id, "om_123...cdef");
  assert.equal(summary.chat_id, "oc_123...cdef");
  assert.equal(summary.parent_id, "om_par...3456");
  assert.equal(summary.root_id, "om_roo...ef12");
  assert.equal(summary.sender_open_id, "ou_123...cdef");
});

test("createRuntimeLogger 會輸出結構化 runtime log", () => {
  const calls = [];
  const logger = createRuntimeLogger({
    logger: {
      info(...args) {
        calls.push(args);
      },
    },
    component: "test_component",
  });

  logger.info("lane_resolved", { capability_lane: "doc-editor" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "lobster_runtime");
  assert.equal(calls[0][1].component, "test_component");
  assert.equal(calls[0][1].event, "lane_resolved");
  assert.equal(calls[0][1].capability_lane, "doc-editor");
  assert.ok(typeof calls[0][1].ts === "string");
});

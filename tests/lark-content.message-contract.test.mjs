import test from "node:test";
import assert from "node:assert/strict";

import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const [
  {
    disposeLarkContentClientForTests,
    sendMessage,
    setLarkContentServiceOverridesForTests,
  },
  {
    withLarkWriteExecutionContext,
  },
] = await Promise.all([
  import("../src/lark-content.mjs"),
  import("../src/execute-lark-write.mjs"),
]);

test.after(() => {
  setLarkContentServiceOverridesForTests({});
  disposeLarkContentClientForTests();
  testDb.close();
});

test("sendMessage rejects API success responses that omit message_id", async () => {
  const previousAllowWrites = process.env.ALLOW_LARK_WRITES;
  process.env.ALLOW_LARK_WRITES = "true";
  setLarkContentServiceOverridesForTests({
    async sendMessageApi() {
      return {
        code: 0,
        msg: "success",
        data: {
          chat_id: "oc_test_chat",
          msg_type: "text",
        },
      };
    },
  });

  try {
    await assert.rejects(
      () => withLarkWriteExecutionContext({ action: "message_send" }, async () =>
        sendMessage(
          { accessToken: "tenant-token", tokenType: "tenant" },
          "oc_test_chat",
          "hello",
          { receiveIdType: "chat_id", tokenType: "tenant" },
        )
      ),
      (error) => {
        assert.equal(error?.code, "lark_message_missing_message_id");
        assert.equal(error?.details?.receive_id, "oc_test_chat");
        assert.equal(error?.details?.receive_id_type, "chat_id");
        assert.equal(error?.details?.raw_response?.data?.message_id, null);
        return true;
      },
    );
  } finally {
    setLarkContentServiceOverridesForTests({});
    if (previousAllowWrites === undefined) {
      delete process.env.ALLOW_LARK_WRITES;
    } else {
      process.env.ALLOW_LARK_WRITES = previousAllowWrites;
    }
  }
});

test("sendMessage attaches raw API evidence when the response contract is complete", async () => {
  const previousAllowWrites = process.env.ALLOW_LARK_WRITES;
  process.env.ALLOW_LARK_WRITES = "true";
  setLarkContentServiceOverridesForTests({
    async sendMessageApi() {
      return {
        code: 0,
        msg: "success",
        request_id: "req_lark_send_1",
        data: {
          message_id: "om_reply_1",
          chat_id: "oc_test_chat",
          msg_type: "text",
        },
      };
    },
  });

  try {
    const result = await withLarkWriteExecutionContext({ action: "message_send" }, async () =>
      sendMessage(
        { accessToken: "tenant-token", tokenType: "tenant" },
        "oc_test_chat",
        "hello",
        { receiveIdType: "chat_id", tokenType: "tenant" },
      )
    );

    assert.equal(result.message_id, "om_reply_1");
    assert.equal(result.chat_id, "oc_test_chat");
    assert.equal(Object.prototype.propertyIsEnumerable.call(result, "__send_evidence"), false);
    assert.equal(result.__send_evidence.raw_response.request_id, "req_lark_send_1");
    assert.equal(result.__send_evidence.raw_response.data.message_id, "om_reply_1");
  } finally {
    setLarkContentServiceOverridesForTests({});
    if (previousAllowWrites === undefined) {
      delete process.env.ALLOW_LARK_WRITES;
    } else {
      process.env.ALLOW_LARK_WRITES = previousAllowWrites;
    }
  }
});

test("sendMessage rejects API success responses that point at the wrong chat target", async () => {
  const previousAllowWrites = process.env.ALLOW_LARK_WRITES;
  process.env.ALLOW_LARK_WRITES = "true";
  setLarkContentServiceOverridesForTests({
    async sendMessageApi() {
      return {
        code: 0,
        msg: "success",
        request_id: "req_lark_send_wrong_target",
        data: {
          message_id: "om_reply_wrong_target",
          chat_id: "oc_other_chat",
          msg_type: "text",
        },
      };
    },
  });

  try {
    await assert.rejects(
      () => withLarkWriteExecutionContext({ action: "message_send" }, async () =>
        sendMessage(
          { accessToken: "tenant-token", tokenType: "tenant" },
          "oc_expected_chat",
          "hello",
          { receiveIdType: "chat_id", tokenType: "tenant" },
        )
      ),
      (error) => {
        assert.equal(error?.code, "lark_message_target_mismatch");
        assert.equal(error?.details?.receive_id, "oc_expected_chat");
        assert.equal(error?.details?.raw_response?.data?.chat_id, "oc_other_chat");
        return true;
      },
    );
  } finally {
    setLarkContentServiceOverridesForTests({});
    if (previousAllowWrites === undefined) {
      delete process.env.ALLOW_LARK_WRITES;
    } else {
      process.env.ALLOW_LARK_WRITES = previousAllowWrites;
    }
  }
});

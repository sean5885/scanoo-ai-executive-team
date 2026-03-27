import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

import {
  assertLarkWriteExecutionAllowed,
  withLarkWriteExecutionContext,
} from "../src/execute-lark-write.mjs";

const testDb = await createTestDbHarness();

test.after(() => {
  testDb.close();
});

test("assertLarkWriteExecutionAllowed blocks direct writes outside runtime context", () => {
  assert.throws(
    () => assertLarkWriteExecutionAllowed("sendMessage"),
    (error) => error?.code === "direct_lark_write_bypass" && /sendMessage/.test(error.message),
  );
});

test("assertLarkWriteExecutionAllowed permits writes inside runtime context", async () => {
  await withLarkWriteExecutionContext({ action: "message_send" }, async () => {
    assert.doesNotThrow(() => assertLarkWriteExecutionAllowed("sendMessage"));
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const [
  {
    executeCanonicalLarkMessageSend,
    runDocumentCreateMutation,
  },
  {
    disposeLarkContentClientForTests,
    setLarkContentServiceOverridesForTests,
  },
] = await Promise.all([
  import("../src/lark-mutation-runtime.mjs"),
  import("../src/lark-content.mjs"),
]);

test.after(() => {
  setLarkContentServiceOverridesForTests({});
  disposeLarkContentClientForTests();
  testDb.close();
});

test("runDocumentCreateMutation carries create_doc audit and rollback details into the runtime journal", async () => {
  const previousAllowWrites = process.env.ALLOW_LARK_WRITES;
  process.env.ALLOW_LARK_WRITES = "true";
  const mutationAudit = {
    boundary: "create_doc",
    nested_mutations: [],
  };

  try {
    const result = await runDocumentCreateMutation({
      pathname: "/api/doc/create",
      accountId: "acct-1",
      account: {
        id: "acct-1",
      },
      accessToken: "token-1",
      title: "Rollback Me",
      content: "# Draft",
      confirm: true,
      confirmationId: "confirm-1",
      peekConfirmation: async () => ({
        confirmation_id: "confirm-1",
      }),
      consumeConfirmation: async () => ({
        confirmation_id: "confirm-1",
      }),
      audit: mutationAudit,
      rollback: async () => {
        mutationAudit.nested_mutations.push({
          phase: "rollback",
          action: "delete_document",
          target_id: "doc-1",
        });
        return {
          deleted_document_id: "doc-1",
        };
      },
      performWrite: async () => {
        mutationAudit.nested_mutations.push({
          phase: "execute",
          action: "create_document",
          target_id: "doc-1",
        });
        throw new Error("post_create_failed");
      },
    });

    assert.equal(result.ok, false);
    assert.deepEqual(Object.keys(result).sort(), ["action", "data", "error", "meta", "ok"]);
    assert.equal(result.data?.stage, "mutation_executed");
    assert.equal(result.data?.mutation_execution?.error, "execution_failed");
    assert.deepEqual(result.data?.mutation_execution?.meta?.journal?.audit, {
      boundary: "create_doc",
      nested_mutations: [
        {
          phase: "execute",
          action: "create_document",
          target_id: "doc-1",
        },
        {
          phase: "rollback",
          action: "delete_document",
          target_id: "doc-1",
        },
      ],
    });
    assert.deepEqual(result.data?.mutation_execution?.meta?.journal?.rollback, {
      status: "success",
      details: {
        deleted_document_id: "doc-1",
      },
    });
  } finally {
    if (previousAllowWrites === undefined) {
      delete process.env.ALLOW_LARK_WRITES;
    } else {
      process.env.ALLOW_LARK_WRITES = previousAllowWrites;
    }
  }
});

test("executeCanonicalLarkMessageSend does not treat different message content in the same chat as duplicate_write_same_session", async () => {
  const previousAllowWrites = process.env.ALLOW_LARK_WRITES;
  process.env.ALLOW_LARK_WRITES = "true";
  const receiveId = `oc_budget_chat_${Date.now()}`;
  let sendCount = 0;

  setLarkContentServiceOverridesForTests({
    async sendMessageApi({ data }) {
      sendCount += 1;
      return {
        code: 0,
        msg: "success",
        request_id: `req_budget_${sendCount}`,
        data: {
          message_id: `om_budget_${sendCount}`,
          chat_id: data.receive_id,
          msg_type: data.msg_type,
        },
      };
    },
  });

  try {
    const first = await executeCanonicalLarkMessageSend({
      pathname: "/runtime/messages/send",
      accountId: "acct-budget-1",
      accessToken: { accessToken: "tenant-token", tokenType: "tenant" },
      receiveId,
      receiveIdType: "chat_id",
      content: "first unique content",
    });
    const second = await executeCanonicalLarkMessageSend({
      pathname: "/runtime/messages/send",
      accountId: "acct-budget-1",
      accessToken: { accessToken: "tenant-token", tokenType: "tenant" },
      receiveId,
      receiveIdType: "chat_id",
      content: "second unique content",
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.result?.message_id, "om_budget_1");
    assert.equal(second.result?.message_id, "om_budget_2");
    assert.equal(sendCount, 2);
  } finally {
    setLarkContentServiceOverridesForTests({});
    if (previousAllowWrites === undefined) {
      delete process.env.ALLOW_LARK_WRITES;
    } else {
      process.env.ALLOW_LARK_WRITES = previousAllowWrites;
    }
  }
});

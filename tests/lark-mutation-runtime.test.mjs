import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
import { runDocumentCreateMutation } from "../src/lark-mutation-runtime.mjs";

test.after(() => {
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
    assert.equal(result.stage, "mutation_executed");
    assert.equal(result.mutation_execution?.error, "execution_failed");
    assert.deepEqual(result.mutation_execution?.meta?.journal?.audit, {
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
    assert.deepEqual(result.mutation_execution?.meta?.journal?.rollback, {
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

test("runDocumentCreateMutation can fail closed instead of issuing a preview when confirmation is required at entry", async (t) => {
  const previousAllowWrites = process.env.ALLOW_LARK_WRITES;
  process.env.ALLOW_LARK_WRITES = "true";
  let createConfirmationCalls = 0;

  try {
    const result = await runDocumentCreateMutation({
      pathname: "/agent/docs/create",
      accountId: "acct-1",
      account: {
        id: "acct-1",
      },
      accessToken: "token-1",
      title: "Fail Closed",
      confirm: false,
      previewOnMissingConfirmation: false,
      createConfirmation: async () => {
        createConfirmationCalls += 1;
        return {
          confirmation_id: "should-not-be-created",
        };
      },
      performWrite: async () => {
        throw new Error("should_not_write");
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.stage, "confirmation_required");
    assert.equal(result.error, "lark_write_confirmation_required");
    assert.equal(result.statusCode, 409);
    assert.equal(createConfirmationCalls, 0);
  } finally {
    if (previousAllowWrites === undefined) {
      delete process.env.ALLOW_LARK_WRITES;
    } else {
      process.env.ALLOW_LARK_WRITES = previousAllowWrites;
    }
  }
});

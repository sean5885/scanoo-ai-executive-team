import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const { resolveDocumentWriteRootBlock } = await import("../src/lark-content.mjs");

test.after(() => {
  testDb.close();
});

test("resolveDocumentWriteRootBlock prefers page blocks over container roots", () => {
  const root = resolveDocumentWriteRootBlock([
    {
      block_id: "blk-container-root",
      children: ["blk-page"],
    },
    {
      block_id: "blk-page",
      parent_id: "blk-container-root",
      page: {
        elements: [],
      },
      children: [],
    },
  ]);

  assert.equal(root?.block_id, "blk-page");
});

test("resolveDocumentWriteRootBlock falls back to parentless root when page block is missing", () => {
  const root = resolveDocumentWriteRootBlock([
    {
      block_id: "blk-root",
      children: [],
    },
    {
      block_id: "blk-child",
      parent_id: "blk-root",
    },
  ]);

  assert.equal(root?.block_id, "blk-root");
});

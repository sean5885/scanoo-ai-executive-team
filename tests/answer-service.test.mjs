import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const { db } = testDb;

process.env.LLM_API_KEY = process.env.LLM_API_KEY || "test-answer-service-key";

const [
  {
    answerQuestion,
    buildKnowledgeAnswerPrompt,
    searchKnowledgeBase,
  },
  {
    replaceDocumentChunks,
    saveToken,
    upsertDocument,
  },
] = await Promise.all([
  import("../src/answer-service.mjs"),
  import("../src/rag-repository.mjs"),
]);

test.after(() => {
  testDb.close();
});

function ensureTestAccount(accountId) {
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO lark_accounts (
      id, open_id, user_id, union_id, tenant_key, name, email, scope, created_at, updated_at
    ) VALUES (
      @id, @open_id, NULL, NULL, NULL, @name, NULL, @scope, @created_at, @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      updated_at = excluded.updated_at
  `).run({
    id: accountId,
    open_id: `ou_test_${accountId}`,
    name: "Answer Service Test",
    scope: "test",
    created_at: timestamp,
    updated_at: timestamp,
  });
}

function cleanupAccountFixtures(accountId) {
  db.prepare("DELETE FROM lark_chunk_embeddings WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM lark_chunks_fts WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM lark_chunks WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM lark_tokens WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM lark_documents WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM lark_accounts WHERE id = ?").run(accountId);
}

function insertIndexedFixture({
  accountId,
  docId,
  title,
  rawText,
}) {
  saveToken(accountId, {
    access_token: `token_${docId}`,
    refresh_token: `refresh_${docId}`,
    token_type: "Bearer",
    scope: "docs:read",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 120_000).toISOString(),
  });

  const document = upsertDocument({
    account_id: accountId,
    source_type: "docx",
    external_key: `ext_${docId}`,
    external_id: docId,
    document_id: docId,
    title,
    url: `https://larksuite.com/docx/${docId}`,
    parent_path: "/",
    raw_text: rawText,
    active: 1,
    status: "verified",
  });

  replaceDocumentChunks(document, [
    {
      chunk_index: 0,
      content: rawText,
      content_norm: rawText,
      char_count: rawText.length,
      chunk_hash: `chunk_hash_${docId}`,
    },
  ]);
}

function installFailingLlmFetch() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    async json() {
      return {
        error: {
          message: "llm_unavailable_for_test",
        },
      };
    },
  });
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("buildKnowledgeAnswerPrompt uses checkpoint and trimmed retrieval snippets", () => {
  const items = [
    {
      id: "source_1",
      snippet: "這是一大段產品藍圖內容。".repeat(120),
      metadata: {
        title: "產品藍圖",
        url: "https://example.com/doc-1",
      },
    },
    {
      id: "source_2",
      snippet: "這是一大段營運流程內容。".repeat(120),
      metadata: {
        title: "營運流程",
        url: "https://example.com/doc-2",
      },
    },
  ];

  const result = buildKnowledgeAnswerPrompt({
    question: "請整理 AI 系統的回答速度優化方式",
    items,
    checkpoint: {
      goal: "持續回答同一個知識主題",
      completed: ["前一輪已整理架構背景"],
      pending: ["這輪要回答速度優化"],
      constraints: ["只能依據來源內容回答"],
      facts: ["已知重點是上下文大小影響延遲"],
      risks: ["不要重複解釋專案背景"],
    },
  });

  assert.match(result.prompt, /<lobster_prompt/);
  assert.match(result.prompt, /<section name="task_checkpoint"/);
  assert.match(result.prompt, /前一輪已整理架構背景/);
  assert.match(result.prompt, /<section name="retrieved_context"/);
  assert.match(result.prompt, /Title: 產品藍圖/);
  assert.match(result.prompt, /verify the draft satisfies the latest user intent/i);
  assert.ok(result.governance.finalTokens > 0);
  assert.ok(result.prompt.length < 4000);
});

test("searchKnowledgeBase and answerQuestion share the same canonical source schema", async () => {
  const accountId = `acct_answer_service_${Date.now()}`;
  ensureTestAccount(accountId);
  insertIndexedFixture({
    accountId,
    docId: "doc_answer_service_1",
    title: "Delivery Verification Guide",
    rawText: [
      "# Delivery Verification Guide",
      "",
      "Back to [README.md](/Users/seanhan/Documents/Playground/README.md)",
      "",
      "- Verification keeps evidence explicit before completion.",
      "- Delivery owners confirm deadlines inside the same checked-in workflow.",
    ].join("\n"),
  });

  const restoreFetch = installFailingLlmFetch();
  try {
    const searchResult = await searchKnowledgeBase(accountId, "delivery verification", 3);
    const answerResult = await answerQuestion(accountId, "delivery verification", 3);

    assert.ok(searchResult.items.length > 0);
    assert.deepEqual(answerResult.sources, searchResult.items);
    assert.deepEqual(Object.keys(searchResult.items[0]).sort(), ["id", "metadata", "snippet"]);
    assert.equal(searchResult.items[0].metadata.title, "Delivery Verification Guide");
    assert.match(searchResult.items[0].metadata.url || "", /doc_answer_service_1/);
    assert.doesNotMatch(searchResult.items[0].snippet, /\/Users\//);
    assert.doesNotMatch(searchResult.items[0].snippet, /Back to \[?README/i);
    assert.doesNotMatch(searchResult.items[0].snippet, /`/);
  } finally {
    restoreFetch();
    cleanupAccountFixtures(accountId);
  }
});

test("answerQuestion can complete through read-runtime overrides without direct repository reads", async () => {
  const restoreFetch = installFailingLlmFetch();
  try {
    const result = await answerQuestion("acct_runtime_only", "runtime boundary", 2, {
      readerOverrides: {
        index: {
          search_knowledge_base: ({ accountId, payload }) => ({
            success: true,
            data: {
              account: { id: accountId },
              items: [
                {
                  id: "runtime_source_1",
                  snippet: `runtime boundary answer for ${payload.q}`,
                  metadata: {
                    title: "Runtime Boundary",
                    url: "https://example.com/runtime-boundary",
                    source_type: "docx",
                    document_id: "runtime_doc_1",
                  },
                },
              ],
            },
            error: null,
          }),
        },
      },
    });

    assert.equal(result.account.id, "acct_runtime_only");
    assert.deepEqual(result.sources, [
      {
        id: "runtime_source_1",
        snippet: "runtime boundary answer for runtime boundary",
        metadata: {
          title: "Runtime Boundary",
          url: "https://example.com/runtime-boundary",
          source_type: "docx",
          document_id: "runtime_doc_1",
        },
      },
    ]);
  } finally {
    restoreFetch();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const { db } = testDb;
const [
  { listDocumentCommentsFromRuntime, readDocumentFromRuntime, runRead },
  { replaceDocumentChunks, saveToken, upsertDocument },
] = await Promise.all([
  import("../src/read-runtime.mjs"),
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
    name: "Read Runtime Test",
    scope: "test",
    created_at: timestamp,
    updated_at: timestamp,
  });
}

function insertDocFixture({
  accountId,
  docId,
  title,
  rawText,
  source = "api",
}) {
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO lark_documents (
      id, account_id, source_id, source_type, external_key, external_id, file_token, node_id,
      document_id, space_id, title, url, parent_path, revision, updated_at_remote, content_hash,
      raw_text, inactive_reason, acl_json, meta_json, active, status, indexed_at, verified_at,
      failure_reason, synced_at, created_at, updated_at
    ) VALUES (
      @id, @account_id, NULL, 'docx', @external_key, NULL, NULL, NULL,
      @document_id, NULL, @title, @url, '/', NULL, NULL, NULL,
      @raw_text, NULL, NULL, NULL, 1, 'verified', NULL, NULL,
      NULL, @synced_at, @created_at, @updated_at
    )
    ON CONFLICT(account_id, external_key) DO UPDATE SET
      document_id = excluded.document_id,
      title = excluded.title,
      url = excluded.url,
      raw_text = excluded.raw_text,
      active = excluded.active,
      status = excluded.status,
      synced_at = excluded.synced_at,
      updated_at = excluded.updated_at
  `).run({
    id: `ldoc_${docId}`,
    account_id: accountId,
    external_key: `ext_${docId}`,
    document_id: docId,
    title,
    url: `https://larksuite.com/docx/${docId}`,
    raw_text: rawText,
    synced_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
  });

  db.prepare(`
    INSERT INTO company_brain_docs (
      account_id, doc_id, title, source, created_at, creator_json, updated_at
    ) VALUES (
      @account_id, @doc_id, @title, @source, @created_at, @creator_json, @updated_at
    )
    ON CONFLICT(account_id, doc_id) DO UPDATE SET
      title = excluded.title,
      source = excluded.source,
      created_at = excluded.created_at,
      creator_json = excluded.creator_json,
      updated_at = excluded.updated_at
  `).run({
    account_id: accountId,
    doc_id: docId,
    title,
    source,
    created_at: timestamp,
    creator_json: JSON.stringify({
      account_id: accountId,
      open_id: `ou_test_${accountId}`,
    }),
    updated_at: timestamp,
  });
}

function cleanupAccountFixtures(accountId) {
  db.prepare("DELETE FROM lark_chunk_embeddings WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM lark_chunks_fts WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM lark_chunks WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM lark_tokens WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM company_brain_approved_knowledge WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM company_brain_learning_state WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM company_brain_docs WHERE account_id = ?").run(accountId);
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

test("runRead routes canonical company-brain search through mirror authority only", async () => {
  const accountId = `acct_read_runtime_${Date.now()}`;
  ensureTestAccount(accountId);
  insertDocFixture({
    accountId,
    docId: "doc_read_runtime_1",
    title: "Mirror Launch Runbook",
    rawText: "launch checklist owner timeline",
  });

  try {
    const result = await runRead({
      canonicalRequest: {
        action: "search_company_brain_docs",
        account_id: accountId,
        payload: {
          q: "launch checklist",
          top_k: 5,
        },
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result).sort(), ["action", "data", "error", "meta", "ok"]);
    assert.equal(result.meta.primary_authority, "mirror");
    assert.deepEqual(result.meta.authorities_attempted, ["mirror"]);
    assert.equal(result.meta.fallback_used, false);
    assert.equal(result.data.success, true);
    assert.equal(result.data.data.items[0].doc_id, "doc_read_runtime_1");
  } finally {
    cleanupAccountFixtures(accountId);
  }
});

test("runRead routes canonical knowledge search through index authority only", async () => {
  const accountId = `acct_read_runtime_index_${Date.now()}`;
  ensureTestAccount(accountId);
  insertIndexedFixture({
    accountId,
    docId: "doc_read_runtime_index_1",
    title: "Index Launch Notes",
    rawText: [
      "# Index Launch Notes",
      "",
      "Back to [README.md](/Users/seanhan/Documents/Playground/README.md)",
      "",
      "- launch checklist owner timeline",
    ].join("\n"),
  });

  try {
    const result = await runRead({
      canonicalRequest: {
        action: "search_knowledge_base",
        account_id: accountId,
        payload: {
          q: "launch checklist",
          top_k: 5,
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.meta.primary_authority, "index");
    assert.deepEqual(result.meta.authorities_attempted, ["index"]);
    assert.equal(result.meta.fallback_used, false);
    assert.equal(result.data.success, true);
    assert.equal(result.data.data.items[0].metadata.title, "Index Launch Notes");
    assert.match(result.data.data.items[0].snippet, /launch checklist owner timeline/i);
    assert.doesNotMatch(result.data.data.items[0].snippet, /\/Users\//);
    assert.doesNotMatch(result.data.data.items[0].snippet, /Back to \[?README/i);
  } finally {
    cleanupAccountFixtures(accountId);
  }
});

test("runRead canonicalizes overridden knowledge-search snippets before returning them", async () => {
  const result = await runRead({
    canonicalRequest: {
      action: "search_knowledge_base",
      account_id: "acct_read_runtime_override",
      payload: {
        q: "launch checklist",
        top_k: 5,
      },
      context: {
        primary_authority: "index",
        reader_overrides: {
          index: {
            search_knowledge_base: {
              success: true,
              data: {
                items: [
                  {
                    id: "doc_override_1:0",
                    snippet: "Back to [README.md](/Users/seanhan/Documents/Playground/README.md)\n- [Ship checklist](https://example.com/checklist)\n- owner: ops",
                    metadata: {
                      title: "Noisy Launch Notes",
                      url: "https://example.com/noisy-launch-notes",
                    },
                  },
                ],
              },
              error: null,
            },
          },
        },
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.data.items.length, 1);
  assert.match(result.data.data.items[0].snippet, /Ship checklist owner: ops/i);
  assert.doesNotMatch(result.data.data.items[0].snippet, /\/Users\/|Back to \[?README|https:\/\/example\.com\/checklist/);
  assert.equal(result.data.data.items[0].metadata.title, "Noisy Launch Notes");
  assert.equal(result.data.data.items[0].metadata.url, "https://example.com/noisy-launch-notes");
});

test("runRead keeps approved mirror detail on the same canonical result shape", async () => {
  const accountId = `acct_read_runtime_approved_${Date.now()}`;
  ensureTestAccount(accountId);
  insertDocFixture({
    accountId,
    docId: "doc_read_runtime_approved_1",
    title: "Approved Delivery Guide",
    rawText: "approved delivery owner deadline",
  });

  db.prepare(`
    INSERT INTO company_brain_approved_knowledge (
      account_id, doc_id, source_stage, approved_by, approved_at, created_at, updated_at
    ) VALUES (
      @account_id, @doc_id, @source_stage, @approved_by, @approved_at, @created_at, @updated_at
    )
    ON CONFLICT(account_id, doc_id) DO UPDATE SET
      source_stage = excluded.source_stage,
      approved_by = excluded.approved_by,
      approved_at = excluded.approved_at,
      updated_at = excluded.updated_at
  `).run({
    account_id: accountId,
    doc_id: "doc_read_runtime_approved_1",
    source_stage: "approved_knowledge",
    created_at: new Date().toISOString(),
    approved_by: "reviewer@test",
    approved_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  try {
    const result = await runRead({
      canonicalRequest: {
        action: "get_approved_company_brain_knowledge_detail",
        account_id: accountId,
        payload: {
          doc_id: "doc_read_runtime_approved_1",
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.meta.primary_authority, "derived");
    assert.deepEqual(result.meta.authorities_attempted, ["derived"]);
    assert.equal(result.data.success, true);
    assert.equal(result.data.data.doc.doc_id, "doc_read_runtime_approved_1");
    assert.equal(result.data.data.knowledge_state.stage, "approved");
  } finally {
    cleanupAccountFixtures(accountId);
  }
});

test("runRead routes learning-state detail through derived authority only", async () => {
  const accountId = `acct_read_runtime_learning_${Date.now()}`;
  ensureTestAccount(accountId);
  insertDocFixture({
    accountId,
    docId: "doc_read_runtime_learning_1",
    title: "Learning Runtime Guide",
    rawText: "learning runtime owner deadline",
  });

  db.prepare(`
    INSERT INTO company_brain_learning_state (
      account_id, doc_id, learning_status, structured_summary_json, key_concepts_json, tags_json,
      notes, learned_at, created_at, updated_at
    ) VALUES (
      @account_id, @doc_id, @learning_status, @structured_summary_json, @key_concepts_json, @tags_json,
      @notes, @learned_at, @created_at, @updated_at
    )
    ON CONFLICT(account_id, doc_id) DO UPDATE SET
      learning_status = excluded.learning_status,
      structured_summary_json = excluded.structured_summary_json,
      key_concepts_json = excluded.key_concepts_json,
      tags_json = excluded.tags_json,
      notes = excluded.notes,
      learned_at = excluded.learned_at,
      updated_at = excluded.updated_at
  `).run({
    account_id: accountId,
    doc_id: "doc_read_runtime_learning_1",
    learning_status: "learned",
    structured_summary_json: JSON.stringify({
      overview: "Learning Runtime Guide",
      headings: ["Learning Runtime Guide"],
      highlights: ["learning runtime owner deadline"],
      snippet: "learning runtime owner deadline",
      content_length: 31,
    }),
    key_concepts_json: JSON.stringify(["derived authority"]),
    tags_json: JSON.stringify(["runtime-derived"]),
    notes: "stored in learning state",
    learned_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  try {
    const result = await runRead({
      canonicalRequest: {
        action: "get_company_brain_learning_state_detail",
        account_id: accountId,
        payload: {
          doc_id: "doc_read_runtime_learning_1",
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.meta.primary_authority, "derived");
    assert.deepEqual(result.meta.authorities_attempted, ["derived"]);
    assert.equal(result.meta.fallback_used, false);
    assert.equal(result.data.success, true);
    assert.equal(result.data.data.doc.doc_id, "doc_read_runtime_learning_1");
    assert.equal(result.data.data.learning_state.status, "learned");
    assert.equal(result.data.data.derived_state.stage, "learning_state");
  } finally {
    cleanupAccountFixtures(accountId);
  }
});

test("runRead routes live document reads only when freshness is live_required", async () => {
  const result = await runRead({
    canonicalRequest: {
      action: "read_document",
      account_id: "acct_live_runtime",
      payload: {
        doc_id: "doc_live_runtime_1",
      },
      context: {
        primary_authority: "live",
        freshness: "live_required",
        access_token: "token-live-runtime",
        reader_overrides: {
          live: {
            read_document: async ({ payload }) => ({
              success: true,
              data: {
                document_id: payload.doc_id,
                title: "Live Runtime Doc",
                content: "# live",
                revision_id: "rev-live-1",
              },
              error: null,
            }),
          },
        },
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.meta.primary_authority, "live");
  assert.deepEqual(result.meta.authorities_attempted, ["live"]);
  assert.equal(result.meta.fallback_used, false);
  assert.equal(result.data.success, true);
  assert.equal(result.data.data.document_id, "doc_live_runtime_1");
});

test("readDocumentFromRuntime accepts resolved auth envelopes for live doc reads", async () => {
  let observedAccessToken = null;

  const document = await readDocumentFromRuntime({
    accountId: "acct_live_runtime_envelope",
    accessToken: {
      access_token: "token-live-envelope",
      account_id: "acct_live_runtime_envelope",
    },
    documentId: "doc_live_runtime_envelope",
    readerOverrides: {
      live: {
        read_document: async ({ payload, context }) => {
          observedAccessToken = context.access_token;
          return {
            success: true,
            data: {
              document_id: payload.doc_id,
              title: "Envelope Live Doc",
              content: "# envelope",
              revision_id: "rev-envelope-1",
            },
            error: null,
          };
        },
      },
    },
  });

  assert.equal(observedAccessToken, "token-live-envelope");
  assert.equal(document.document_id, "doc_live_runtime_envelope");
  assert.equal(document.title, "Envelope Live Doc");
});

test("listDocumentCommentsFromRuntime accepts resolved auth envelopes for live comment reads", async () => {
  let observedAccessToken = null;

  const comments = await listDocumentCommentsFromRuntime({
    accountId: "acct_live_runtime_comments",
    accessToken: {
      accessToken: "token-live-comments",
      accountId: "acct_live_runtime_comments",
    },
    documentId: "doc_live_runtime_comments",
    readerOverrides: {
      live: {
        list_document_comments: async ({ payload, context }) => {
          observedAccessToken = context.access_token;
          return {
            success: true,
            data: {
              items: [
                {
                  comment_id: "comment-1",
                  latest_reply_text: "請補上數據維度",
                },
              ],
              page_token: null,
              has_more: false,
            },
            error: null,
          };
        },
      },
    },
  });

  assert.equal(observedAccessToken, "token-live-comments");
  assert.equal(comments.items[0].comment_id, "comment-1");
  assert.equal(comments.has_more, false);
});

test("runRead rejects live document reads without live_required freshness", async () => {
  const result = await runRead({
    canonicalRequest: {
      action: "read_document",
      account_id: "acct_live_runtime_invalid",
      payload: {
        doc_id: "doc_live_runtime_invalid",
      },
      context: {
        primary_authority: "live",
        access_token: "token-live-runtime",
      },
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(Object.keys(result).sort(), ["action", "data", "error", "meta", "ok"]);
  assert.equal(result.meta.primary_authority, null);
  assert.deepEqual(result.meta.authorities_attempted, []);
  assert.equal(result.error, "invalid_canonical_read_request");
});

test("runRead rejects index search when the requested primary authority does not match index", async () => {
  const result = await runRead({
    canonicalRequest: {
      action: "search_knowledge_base",
      account_id: "acct_index_runtime_invalid",
      payload: {
        q: "launch checklist",
      },
      context: {
        primary_authority: "mirror",
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.meta.primary_authority, null);
  assert.deepEqual(result.meta.authorities_attempted, []);
  assert.equal(result.error, "invalid_canonical_read_request");
});

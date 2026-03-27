import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const { db } = testDb;
const [{ runRead }] = await Promise.all([
  import("../src/read-runtime.mjs"),
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
  db.prepare("DELETE FROM company_brain_approved_knowledge WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM company_brain_learning_state WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM company_brain_docs WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM lark_documents WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM lark_accounts WHERE id = ?").run(accountId);
}

test("runRead routes canonical company-brain search through mirror authority only", () => {
  const accountId = `acct_read_runtime_${Date.now()}`;
  ensureTestAccount(accountId);
  insertDocFixture({
    accountId,
    docId: "doc_read_runtime_1",
    title: "Mirror Launch Runbook",
    rawText: "launch checklist owner timeline",
  });

  try {
    const result = runRead({
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
    assert.equal(result.primary_authority, "mirror");
    assert.deepEqual(result.authorities_attempted, ["mirror"]);
    assert.equal(result.fallback_used, false);
    assert.equal(result.result.success, true);
    assert.equal(result.result.data.items[0].doc_id, "doc_read_runtime_1");
  } finally {
    cleanupAccountFixtures(accountId);
  }
});

test("runRead keeps approved mirror detail on the same canonical result shape", () => {
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
    const result = runRead({
      canonicalRequest: {
        action: "get_approved_company_brain_knowledge_detail",
        account_id: accountId,
        payload: {
          doc_id: "doc_read_runtime_approved_1",
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.primary_authority, "mirror");
    assert.equal(result.result.success, true);
    assert.equal(result.result.data.doc.doc_id, "doc_read_runtime_approved_1");
    assert.equal(result.result.data.knowledge_state.stage, "approved");
  } finally {
    cleanupAccountFixtures(accountId);
  }
});

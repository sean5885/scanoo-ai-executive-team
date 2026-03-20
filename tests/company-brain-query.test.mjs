import test from "node:test";
import assert from "node:assert/strict";

import db from "../src/db.mjs";
import {
  getCompanyBrainDocDetailAction,
  searchCompanyBrainDocsAction,
} from "../src/company-brain-query.mjs";

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
    name: "Company Brain Query Test",
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
  db.prepare("DELETE FROM company_brain_docs WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM lark_documents WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM lark_sources WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM lark_accounts WHERE id = ?").run(accountId);
}

test("searchCompanyBrainDocsAction hits matching docs and returns structured summaries", () => {
  const accountId = `acct_company_brain_search_${Date.now()}`;
  ensureTestAccount(accountId);
  insertDocFixture({
    accountId,
    docId: "doc_company_brain_search_1",
    title: "Customer Onboarding Playbook",
    rawText: [
      "# Customer Onboarding Playbook",
      "## Goals",
      "- Shorten launch handoff time",
      "- Keep owners and deadlines visible",
      "## Steps",
      "Prepare kickoff checklist and confirm onboarding owner.",
    ].join("\n"),
  });

  try {
    const result = searchCompanyBrainDocsAction({
      accountId,
      q: "launch handoff onboarding",
      limit: 5,
    });

    assert.equal(result.success, true);
    assert.equal(result.error, null);
    assert.equal(result.data.total, 1);
    assert.equal(result.data.items[0].doc_id, "doc_company_brain_search_1");
    assert.equal(result.data.items[0].summary.overview.length > 0, true);
    assert.deepEqual(result.data.items[0].summary.headings.slice(0, 2), [
      "Customer Onboarding Playbook",
      "Goals",
    ]);
    assert.equal(Array.isArray(result.data.items[0].summary.highlights), true);
    assert.equal(result.data.items[0].match.score > 0, true);
  } finally {
    cleanupAccountFixtures(accountId);
  }
});

test("getCompanyBrainDocDetailAction returns structured content summary without raw full text", () => {
  const accountId = `acct_company_brain_detail_${Date.now()}`;
  ensureTestAccount(accountId);
  insertDocFixture({
    accountId,
    docId: "doc_company_brain_detail_1",
    title: "Delivery SOP",
    rawText: [
      "# Delivery SOP",
      "## Owner",
      "CS Team",
      "## Deadline",
      "Every Friday",
      "## Risks",
      "- Account activation delay",
      "- Missing implementation checklist",
    ].join("\n"),
  });

  try {
    const result = getCompanyBrainDocDetailAction({
      accountId,
      docId: "doc_company_brain_detail_1",
    });

    assert.equal(result.success, true);
    assert.equal(result.error, null);
    assert.equal(result.data.doc.doc_id, "doc_company_brain_detail_1");
    assert.equal(result.data.doc.title, "Delivery SOP");
    assert.match(result.data.summary.overview, /Delivery SOP/);
    assert.deepEqual(result.data.summary.headings.slice(0, 3), [
      "Delivery SOP",
      "Owner",
      "Deadline",
    ]);
    assert.equal(result.data.summary.highlights.length > 0, true);
    assert.equal("raw_text" in result.data.summary, false);
  } finally {
    cleanupAccountFixtures(accountId);
  }
});

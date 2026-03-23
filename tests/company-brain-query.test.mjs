import test from "node:test";
import assert from "node:assert/strict";

import db from "../src/db.mjs";
import { updateLearningStateAction } from "../src/company-brain-learning.mjs";
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
  createdAt = null,
  updatedAt = null,
}) {
  const timestamp = new Date().toISOString();
  const effectiveCreatedAt = createdAt || timestamp;
  const effectiveUpdatedAt = updatedAt || effectiveCreatedAt;
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
    synced_at: effectiveUpdatedAt,
    created_at: effectiveCreatedAt,
    updated_at: effectiveUpdatedAt,
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
    created_at: effectiveCreatedAt,
    creator_json: JSON.stringify({
      account_id: accountId,
      open_id: `ou_test_${accountId}`,
    }),
    updated_at: effectiveUpdatedAt,
  });
}

function cleanupAccountFixtures(accountId) {
  db.prepare("DELETE FROM company_brain_learning_state WHERE account_id = ?").run(accountId);
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
    assert.equal(result.data.top_k, 5);
    assert.equal(result.data.items[0].match.keyword_score > 0, true);
    assert.equal(result.data.items[0].match.recency_score > 0, true);
    assert.equal(Array.isArray(result.data.items[0].match.ranking_basis), true);
    assert.equal(result.data.items[0].match.ranking_basis.length > 0, true);
  } finally {
    cleanupAccountFixtures(accountId);
  }
});

test("searchCompanyBrainDocsAction ranking weights can change document order", () => {
  const accountId = `acct_company_brain_weighted_rank_${Date.now()}`;
  ensureTestAccount(accountId);

  const oldTimestamp = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
  const recentTimestamp = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

  insertDocFixture({
    accountId,
    docId: "doc_company_brain_rank_keyword",
    title: "Launch Handoff Guide",
    rawText: [
      "# Launch Handoff Guide",
      "Launch handoff checklist, owner map, and rollout steps.",
    ].join("\n"),
    createdAt: oldTimestamp,
    updatedAt: oldTimestamp,
  });
  insertDocFixture({
    accountId,
    docId: "doc_company_brain_rank_learning",
    title: "Executive Notes",
    rawText: [
      "# Executive Notes",
      "Weekly execution review without the target keywords in title or body.",
    ].join("\n"),
    createdAt: recentTimestamp,
    updatedAt: recentTimestamp,
  });

  try {
    const updateResult = updateLearningStateAction({
      accountId,
      docId: "doc_company_brain_rank_learning",
      status: "learned",
      tags: ["launch handoff"],
      key_concepts: ["launch handoff operating model"],
      notes: "Learning metadata should be able to outrank old keyword-only docs when weighted higher.",
    });
    assert.equal(updateResult.success, true);

    const keywordFirst = searchCompanyBrainDocsAction({
      accountId,
      q: "launch handoff",
      top_k: 2,
      ranking_weights: {
        keyword: 1,
        semantic_lite: 0,
        learning: 0,
        recency: 0,
      },
    });
    assert.equal(keywordFirst.success, true);
    assert.deepEqual(keywordFirst.data.items.map((item) => item.doc_id), [
      "doc_company_brain_rank_keyword",
      "doc_company_brain_rank_learning",
    ]);

    const learningFirst = searchCompanyBrainDocsAction({
      accountId,
      q: "launch handoff",
      top_k: 2,
      ranking_weights: {
        keyword: 0,
        semantic_lite: 0,
        learning: 1,
        recency: 0.5,
      },
    });
    assert.equal(learningFirst.success, true);
    assert.deepEqual(learningFirst.data.items.map((item) => item.doc_id), [
      "doc_company_brain_rank_learning",
      "doc_company_brain_rank_keyword",
    ]);
    assert.equal(learningFirst.data.items[0].match.learning_score > 0, true);
    assert.equal(learningFirst.data.items[0].match.recency_score >= learningFirst.data.items[1].match.recency_score, true);
  } finally {
    cleanupAccountFixtures(accountId);
  }
});

test("searchCompanyBrainDocsAction uses deterministic tie-breaker when scores match", () => {
  const accountId = `acct_company_brain_deterministic_tie_${Date.now()}`;
  ensureTestAccount(accountId);
  const sharedTimestamp = "2026-03-20T00:00:00.000Z";

  insertDocFixture({
    accountId,
    docId: "doc_company_brain_tie_b",
    title: "Deterministic Playbook",
    rawText: "Launch handoff approval checklist for shared rollout review.",
    createdAt: sharedTimestamp,
    updatedAt: sharedTimestamp,
  });
  insertDocFixture({
    accountId,
    docId: "doc_company_brain_tie_a",
    title: "Deterministic Playbook",
    rawText: "Launch handoff approval checklist for shared rollout review.",
    createdAt: sharedTimestamp,
    updatedAt: sharedTimestamp,
  });

  try {
    const result = searchCompanyBrainDocsAction({
      accountId,
      q: "launch handoff approval",
      top_k: 2,
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.data.items.map((item) => item.doc_id), [
      "doc_company_brain_tie_a",
      "doc_company_brain_tie_b",
    ]);
    assert.equal(result.data.items[0].match.score, result.data.items[1].match.score);
  } finally {
    cleanupAccountFixtures(accountId);
  }
});

test("searchCompanyBrainDocsAction returns identical results across the same query x10", () => {
  const accountId = `acct_company_brain_repeat_${Date.now()}`;
  ensureTestAccount(accountId);

  insertDocFixture({
    accountId,
    docId: "doc_company_brain_repeat_1",
    title: "Launch Handoff Guide",
    rawText: [
      "# Launch Handoff Guide",
      "Launch handoff requires owner confirmation before rollout.",
      "Checklist review happens before launch approval.",
    ].join("\n"),
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
  });
  insertDocFixture({
    accountId,
    docId: "doc_company_brain_repeat_2",
    title: "Launch Review SOP",
    rawText: [
      "# Launch Review SOP",
      "Launch review includes owner approval and rollback planning.",
    ].join("\n"),
    createdAt: "2026-03-18T00:00:00.000Z",
    updatedAt: "2026-03-18T00:00:00.000Z",
  });

  const originalDateNow = Date.now;
  const fixedBaseNow = originalDateNow();
  try {
    let baseline = null;
    for (let index = 0; index < 10; index += 1) {
      Date.now = () => fixedBaseNow + (index * 24 * 60 * 60 * 1000);
      const result = searchCompanyBrainDocsAction({
        accountId,
        q: "launch handoff approval",
        top_k: 2,
      });
      if (!baseline) {
        baseline = result;
      } else {
        assert.deepEqual(result, baseline);
      }
    }
  } finally {
    Date.now = originalDateNow;
    cleanupAccountFixtures(accountId);
  }
});

test("searchCompanyBrainDocsAction selects a deterministic top1 snippet sentence per doc", () => {
  const accountId = `acct_company_brain_snippet_${Date.now()}`;
  ensureTestAccount(accountId);
  insertDocFixture({
    accountId,
    docId: "doc_company_brain_snippet_1",
    title: "Launch Notes",
    rawText: [
      "# Launch Notes",
      "General context without the target words.",
      "Launch handoff requires owner confirmation before rollout. Launch handoff approval is recorded in the checklist.",
      "Another line that mentions launch only once.",
    ].join("\n"),
  });

  try {
    const result = searchCompanyBrainDocsAction({
      accountId,
      q: "launch handoff approval",
      top_k: 1,
    });

    assert.equal(result.success, true);
    assert.equal(
      result.data.items[0].summary.snippet,
      "Launch handoff approval is recorded in the checklist.",
    );
  } finally {
    cleanupAccountFixtures(accountId);
  }
});

test("searchCompanyBrainDocsAction applies top_k and defaults to 5", () => {
  const accountId = `acct_company_brain_top_k_${Date.now()}`;
  ensureTestAccount(accountId);

  try {
    for (let index = 0; index < 6; index += 1) {
      const timestamp = new Date(Date.now() - index * 60 * 1000).toISOString();
      insertDocFixture({
        accountId,
        docId: `doc_company_brain_top_k_${index + 1}`,
        title: `Retention Handoff Playbook ${index + 1}`,
        rawText: `Retention handoff checklist version ${index + 1}.`,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }

    const defaultResult = searchCompanyBrainDocsAction({
      accountId,
      q: "retention handoff",
    });
    assert.equal(defaultResult.success, true);
    assert.equal(defaultResult.data.top_k, 5);
    assert.equal(defaultResult.data.total, 5);
    assert.equal(defaultResult.data.items.length, 5);

    const limitedResult = searchCompanyBrainDocsAction({
      accountId,
      q: "retention handoff",
      top_k: 2,
    });
    assert.equal(limitedResult.success, true);
    assert.equal(limitedResult.data.top_k, 2);
    assert.equal(limitedResult.data.total, 2);
    assert.equal(limitedResult.data.items.length, 2);
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
    assert.deepEqual(Object.keys(result.data.summary), [
      "overview",
      "headings",
      "highlights",
      "snippet",
      "content_length",
    ]);
    assert.equal(result.data.summary.highlights.length > 0, true);
    assert.equal("raw_text" in result.data.summary, false);
  } finally {
    cleanupAccountFixtures(accountId);
  }
});

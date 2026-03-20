import test from "node:test";
import assert from "node:assert/strict";

import db from "../src/db.mjs";
import {
  ingestLearningDocAction,
  updateLearningStateAction,
} from "../src/company-brain-learning.mjs";
import { searchCompanyBrainDocsAction } from "../src/company-brain-query.mjs";
import {
  resetPlannerRuntimeContext,
  runPlannerToolFlow,
} from "../src/executive-planner.mjs";

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
    name: "Company Brain Learning Test",
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
  db.prepare("DELETE FROM company_brain_learning_state WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM company_brain_docs WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM lark_documents WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM lark_sources WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM lark_accounts WHERE id = ?").run(accountId);
}

test("ingestLearningDocAction learns a company-brain doc into the simplified learning store", () => {
  const accountId = `acct_company_brain_learning_ingest_${Date.now()}`;
  ensureTestAccount(accountId);
  insertDocFixture({
    accountId,
    docId: "doc_company_brain_learning_1",
    title: "Customer Onboarding Playbook",
    rawText: [
      "# Customer Onboarding Playbook",
      "## Goals",
      "- Keep owners and deadlines visible",
      "## Risks",
      "- Missing implementation checklist",
      "## Next Steps",
      "Prepare kickoff checklist and confirm onboarding owner.",
    ].join("\n"),
  });

  try {
    const result = ingestLearningDocAction({
      accountId,
      docId: "doc_company_brain_learning_1",
    });

    assert.equal(result.success, true);
    assert.equal(result.error, null);
    assert.equal(result.data.doc.doc_id, "doc_company_brain_learning_1");
    assert.equal(result.data.learning_state.status, "learned");
    assert.match(result.data.learning_state.structured_summary.overview, /Customer Onboarding Playbook/);
    assert.deepEqual(result.data.learning_state.structured_summary.headings.slice(0, 3), [
      "Customer Onboarding Playbook",
      "Goals",
      "Risks",
    ]);
    assert.equal(result.data.learning_state.key_concepts.length > 0, true);
    assert.equal(result.data.learning_state.tags.includes("onboarding"), true);
    assert.equal(Boolean(result.data.learning_state.learned_at), true);
  } finally {
    cleanupAccountFixtures(accountId);
  }
});

test("searchCompanyBrainDocsAction can hit learned tags and concepts after learning state update", () => {
  const accountId = `acct_company_brain_learning_search_${Date.now()}`;
  ensureTestAccount(accountId);
  insertDocFixture({
    accountId,
    docId: "doc_company_brain_learning_2",
    title: "Weekly Business Review",
    rawText: [
      "# Weekly Business Review",
      "## Notes",
      "Review pipeline conversion and revenue blockers.",
    ].join("\n"),
  });

  try {
    const ingestResult = ingestLearningDocAction({
      accountId,
      docId: "doc_company_brain_learning_2",
    });
    assert.equal(ingestResult.success, true);

    const updateResult = updateLearningStateAction({
      accountId,
      docId: "doc_company_brain_learning_2",
      tags: ["qbr-automation"],
      key_concepts: ["Closed-loop company memory"],
      notes: "Added a unique learned tag for planner-side retrieval.",
    });

    assert.equal(updateResult.success, true);
    assert.equal(updateResult.data.learning_state.tags.includes("qbr-automation"), true);

    const result = searchCompanyBrainDocsAction({
      accountId,
      q: "qbr-automation",
      limit: 5,
    });

    assert.equal(result.success, true);
    assert.equal(result.error, null);
    assert.equal(result.data.total, 1);
    assert.equal(result.data.items[0].doc_id, "doc_company_brain_learning_2");
    assert.equal(result.data.items[0].learning_state.status, "learned");
    assert.equal(result.data.items[0].learning_state.tags.includes("qbr-automation"), true);
    assert.equal(result.data.items[0].match.score > 0, true);
  } finally {
    cleanupAccountFixtures(accountId);
  }
});

test("runPlannerToolFlow exposes learning state when planner queries learned doc detail", async () => {
  resetPlannerRuntimeContext();

  await runPlannerToolFlow({
    userIntent: "整理這份 Weekly Business Review",
    payload: {},
    logger: console,
    async presetRunner() {
      return {
        ok: true,
        preset: "search_and_detail_doc",
        steps: [
          { action: "search_company_brain_docs" },
          { action: "get_company_brain_doc_detail" },
        ],
        results: [
          {
            ok: true,
            action: "search_company_brain_docs",
            data: {
              success: true,
              data: {
                q: "整理這份 Weekly Business Review",
                total: 1,
                items: [{ doc_id: "doc_learning_planner_1", title: "Weekly Business Review" }],
              },
              error: null,
            },
            trace_id: "trace_seed_search_learning",
          },
          {
            ok: true,
            action: "get_company_brain_doc_detail",
            data: {
              success: true,
              data: {
                doc: { doc_id: "doc_learning_planner_1", title: "Weekly Business Review" },
                summary: {
                  overview: "Weekly Business Review overview",
                  headings: [],
                  highlights: [],
                  snippet: "Weekly Business Review overview",
                  content_length: 28,
                },
                learning_state: {
                  status: "learned",
                  structured_summary: {
                    overview: "Weekly Business Review overview",
                    headings: [],
                    highlights: [],
                    snippet: "Weekly Business Review overview",
                    content_length: 28,
                  },
                  key_concepts: ["Closed-loop company memory"],
                  tags: ["qbr-automation"],
                  notes: "",
                  learned_at: "2026-03-21T00:00:00.000Z",
                  updated_at: "2026-03-21T00:00:00.000Z",
                },
              },
              error: null,
            },
            trace_id: "trace_seed_detail_learning",
          },
        ],
        trace_id: "trace_seed_learning",
        stopped: false,
        stopped_at_step: null,
      };
    },
    async contentReader() {
      return null;
    },
  });

  const result = await runPlannerToolFlow({
    userIntent: "這份文件學了什麼",
    payload: {},
    logger: console,
    async dispatcher({ action, payload }) {
      assert.equal(action, "get_company_brain_doc_detail");
      assert.equal(payload.doc_id, "doc_learning_planner_1");
      return {
        ok: true,
        action: "get_company_brain_doc_detail",
        data: {
          success: true,
          data: {
            doc: {
              doc_id: "doc_learning_planner_1",
              title: "Weekly Business Review",
            },
            summary: {
              overview: "Weekly Business Review overview",
              headings: [],
              highlights: [],
              snippet: "Weekly Business Review overview",
              content_length: 28,
            },
            learning_state: {
              status: "learned",
              structured_summary: {
                overview: "Weekly Business Review overview",
                headings: [],
                highlights: [],
                snippet: "Weekly Business Review overview",
                content_length: 28,
              },
              key_concepts: ["Closed-loop company memory"],
              tags: ["qbr-automation"],
              notes: "Planner should be able to surface this learning state.",
              learned_at: "2026-03-21T00:00:00.000Z",
              updated_at: "2026-03-21T00:00:00.000Z",
            },
          },
          error: null,
        },
        trace_id: "trace_learning_detail",
      };
    },
    async contentReader() {
      return null;
    },
  });

  assert.equal(result.execution_result?.formatted_output?.kind, "detail");
  assert.equal(result.execution_result?.formatted_output?.learning_status, "learned");
  assert.deepEqual(result.execution_result?.formatted_output?.learning_concepts, ["Closed-loop company memory"]);
  assert.deepEqual(result.execution_result?.formatted_output?.learning_tags, ["qbr-automation"]);

  resetPlannerRuntimeContext();
});

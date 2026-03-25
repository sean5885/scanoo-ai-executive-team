import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const { db } = testDb;
const [
  { ingestLearningDocAction },
  {
    approvalTransitionCompanyBrainDocAction,
    applyApprovedCompanyBrainKnowledgeAction,
    getCompanyBrainApprovalState,
    promoteApprovedCompanyBrainKnowledge,
    resolveCompanyBrainReviewDecision,
    stageCompanyBrainReviewFromIntake,
    stageCompanyBrainReviewState,
  },
  { searchApprovedCompanyBrainKnowledgeAction },
] = await Promise.all([
  import("../src/company-brain-learning.mjs"),
  import("../src/company-brain-review.mjs"),
  import("../src/company-brain-query.mjs"),
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
    name: "Company Brain Review Approval Test",
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
  db.prepare("DELETE FROM company_brain_review_state WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM company_brain_learning_state WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM company_brain_docs WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM lark_documents WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM lark_sources WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM lark_accounts WHERE id = ?").run(accountId);
}

test("formal company knowledge search excludes mirror and learning docs until approval completes", () => {
  const accountId = `acct_company_brain_approval_${Date.now()}`;
  const docId = "doc_company_brain_approval_1";
  ensureTestAccount(accountId);
  insertDocFixture({
    accountId,
    docId,
    title: "Customer Onboarding Playbook",
    rawText: [
      "# Customer Onboarding Playbook",
      "## Goals",
      "- Keep onboarding predictable",
      "## Steps",
      "Confirm launch owner and checklist.",
    ].join("\n"),
  });

  try {
    const learned = ingestLearningDocAction({
      accountId,
      docId,
    });
    assert.equal(learned.success, true);

    const beforeApproval = searchApprovedCompanyBrainKnowledgeAction({
      accountId,
      q: "launch owner checklist",
      limit: 5,
    });
    assert.equal(beforeApproval.success, true);
    assert.equal(beforeApproval.data.total, 0);

    const staged = stageCompanyBrainReviewState({
      accountId,
      docId,
      sourceStage: "mirror",
      proposedAction: "approval_transition",
      reviewStatus: "pending_review",
    });
    assert.equal(staged.success, true);
    assert.equal(staged.data.review_state.status, "pending_review");

    const reviewed = resolveCompanyBrainReviewDecision({
      accountId,
      docId,
      approved: true,
      notes: "Reviewed and accepted for formal knowledge.",
      actor: "reviewer@test",
    });
    assert.equal(reviewed.success, true);
    assert.equal(reviewed.data.review_state.status, "approved");

    const promoted = promoteApprovedCompanyBrainKnowledge({
      accountId,
      docId,
      actor: "reviewer@test",
    });
    assert.equal(promoted.success, true);
    assert.equal(promoted.data.approval.status, "approved");

    const afterApproval = searchApprovedCompanyBrainKnowledgeAction({
      accountId,
      q: "launch owner checklist",
      limit: 5,
    });
    assert.equal(afterApproval.success, true);
    assert.equal(afterApproval.data.total, 1);
    assert.equal(afterApproval.data.items[0].doc_id, docId);
    assert.equal(afterApproval.data.items[0].knowledge_state.stage, "approved");
  } finally {
    cleanupAccountFixtures(accountId);
  }
});

test("conflict candidates stay in review and cannot enter approved knowledge directly", () => {
  const accountId = `acct_company_brain_conflict_${Date.now()}`;
  ensureTestAccount(accountId);
  insertDocFixture({
    accountId,
    docId: "doc_company_brain_conflict_1",
    title: "Quarterly Ops Runbook",
    rawText: "# Quarterly Ops Runbook\n## Owners\nOps leadership",
  });
  insertDocFixture({
    accountId,
    docId: "doc_company_brain_conflict_2",
    title: "Quarterly Ops Runbook",
    rawText: "# Quarterly Ops Runbook\n## Changes\nUpdated process proposal",
  });

  try {
    const staged = stageCompanyBrainReviewFromIntake({
      accountId,
      action: "ingest_doc",
      targetStage: "mirror",
      candidate: {
        doc_id: "doc_company_brain_conflict_2",
        title: "Quarterly Ops Runbook",
      },
    });

    assert.equal(staged.success, true);
    assert.equal(staged.data.intake_boundary.review_required, true);
    assert.equal(staged.data.intake_boundary.review_status, "conflict_detected");
    assert.equal(staged.data.review_state.status, "conflict_detected");
    assert.equal(staged.data.review_state.conflict_items.length > 0, true);
    assert.equal(staged.data.review_state.conflict_items[0].doc_id, "doc_company_brain_conflict_1");

    const approvalState = getCompanyBrainApprovalState({
      accountId,
      docId: "doc_company_brain_conflict_2",
    });
    assert.equal(approvalState.review_state.status, "conflict_detected");
    assert.equal(approvalState.approval, null);

    const promoted = promoteApprovedCompanyBrainKnowledge({
      accountId,
      docId: "doc_company_brain_conflict_2",
      actor: "reviewer@test",
    });
    assert.equal(promoted.success, false);
    assert.equal(promoted.error, "approval_required");

    const formalSearch = searchApprovedCompanyBrainKnowledgeAction({
      accountId,
      q: "Updated process proposal",
      limit: 5,
    });
    assert.equal(formalSearch.success, true);
    assert.equal(formalSearch.data.total, 0);
  } finally {
    cleanupAccountFixtures(accountId);
  }
});

test("apply stays blocked when formal admission has not entered review yet", () => {
  const accountId = `acct_company_brain_no_review_${Date.now()}`;
  const docId = "doc_company_brain_no_review_1";
  ensureTestAccount(accountId);
  insertDocFixture({
    accountId,
    docId,
    title: "Policy Draft Without Review",
    rawText: "# Policy Draft Without Review\nNo formal review recorded yet.",
  });

  try {
    const applied = applyApprovedCompanyBrainKnowledgeAction({
      accountId,
      docId,
      actor: "reviewer@test",
    });

    assert.equal(applied.success, false);
    assert.equal(applied.error, "approval_required");
    assert.equal(applied.data.review_state, null);
    assert.equal(applied.data.approval_state.review_state, null);
    assert.equal(applied.data.approval_state.approval, null);
  } finally {
    cleanupAccountFixtures(accountId);
  }
});

test("apply stays blocked when approval decision is rejected", () => {
  const accountId = `acct_company_brain_rejected_${Date.now()}`;
  const docId = "doc_company_brain_rejected_1";
  ensureTestAccount(accountId);
  insertDocFixture({
    accountId,
    docId,
    title: "Rejected Knowledge Draft",
    rawText: "# Rejected Knowledge Draft\nShould not enter approved memory.",
  });

  try {
    const staged = stageCompanyBrainReviewState({
      accountId,
      docId,
      sourceStage: "mirror",
      proposedAction: "approval_transition",
      reviewStatus: "pending_review",
    });
    assert.equal(staged.success, true);

    const rejected = approvalTransitionCompanyBrainDocAction({
      accountId,
      docId,
      decision: "reject",
      actor: "reviewer@test",
      notes: "Rejected after review.",
    });
    assert.equal(rejected.success, true);
    assert.equal(rejected.data.review_state.status, "rejected");

    const applied = applyApprovedCompanyBrainKnowledgeAction({
      accountId,
      docId,
      actor: "reviewer@test",
    });
    assert.equal(applied.success, false);
    assert.equal(applied.error, "approval_required");
    assert.equal(applied.data.review_state.status, "rejected");
    assert.equal(applied.data.approval_state.review_state.status, "rejected");
    assert.equal(applied.data.approval_state.approval, null);
  } finally {
    cleanupAccountFixtures(accountId);
  }
});

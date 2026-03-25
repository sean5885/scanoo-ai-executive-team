import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const { resolveCompanyBrainWriteIntake } = await import("../src/company-brain-write-intake.mjs");

test.after(() => {
  testDb.close();
});

test("verified mirror ingest without overlap stays direct intake", () => {
  const result = resolveCompanyBrainWriteIntake({
    accountId: "acct-1",
    action: "ingest_doc",
    targetStage: "mirror",
    candidate: {
      doc_id: "doc-1",
      title: "Quarterly Ops Runbook",
    },
    searchDocs: () => [],
  });

  assert.equal(result.ok, true);
  assert.equal(result.direct_intake_allowed, true);
  assert.equal(result.review_required, false);
  assert.equal(result.conflict_check_required, false);
  assert.equal(result.approval_required_for_formal_source, false);
  assert.equal(result.intake_state, "mirrored");
  assert.equal(result.review_status, null);
  assert.deepEqual(result.matched_docs, []);
});

test("title overlap forces review and conflict check before stable promotion", () => {
  const result = resolveCompanyBrainWriteIntake({
    accountId: "acct-1",
    action: "ingest_doc",
    targetStage: "mirror",
    candidate: {
      doc_id: "doc-2",
      title: "Quarterly Ops Runbook",
    },
    searchDocs: () => [
      {
        doc_id: "doc-1",
        title: "Quarterly Ops Runbook",
        source: "api",
        created_at: "2026-03-20T10:00:00.000Z",
        creator_json: JSON.stringify({ account_id: "acct-1", open_id: "ou_1" }),
      },
    ],
  });

  assert.equal(result.direct_intake_allowed, false);
  assert.equal(result.review_required, true);
  assert.equal(result.conflict_check_required, true);
  assert.equal(result.approval_required_for_formal_source, false);
  assert.equal(result.intake_state, "pending_review");
  assert.equal(result.review_status, "conflict_detected");
  assert.equal(result.matched_docs.length, 1);
  assert.equal(result.matched_docs[0].doc_id, "doc-1");
  assert.equal(result.matched_docs[0].match_type, "same_title");
});

test("stable update promotion remains review and approval gated", () => {
  const result = resolveCompanyBrainWriteIntake({
    accountId: "acct-1",
    action: "update_doc",
    targetStage: "approved_knowledge",
    candidate: {
      doc_id: "doc-1",
      title: "Quarterly Ops Runbook",
    },
    searchDocs: () => [],
  });

  assert.equal(result.direct_intake_allowed, false);
  assert.equal(result.review_required, true);
  assert.equal(result.conflict_check_required, true);
  assert.equal(result.approval_required_for_formal_source, true);
  assert.equal(result.review_status, "pending_review");
  assert.equal(result.formal_source_state, "approval_required");
  assert.match(result.rationale.join(" "), /approval-gated/);
});

test("self-match is ignored so verified re-ingest stays idempotent", () => {
  const result = resolveCompanyBrainWriteIntake({
    accountId: "acct-1",
    action: "ingest_doc",
    targetStage: "mirror",
    candidate: {
      doc_id: "doc-1",
      title: "Quarterly Ops Runbook",
    },
    searchDocs: () => [
      {
        doc_id: "doc-1",
        title: "Quarterly Ops Runbook",
        source: "api",
        created_at: "2026-03-20T10:00:00.000Z",
        creator_json: JSON.stringify({ account_id: "acct-1", open_id: "ou_1" }),
      },
    ],
  });

  assert.equal(result.direct_intake_allowed, true);
  assert.equal(result.review_required, false);
  assert.equal(result.review_status, null);
  assert.deepEqual(result.matched_docs, []);
});

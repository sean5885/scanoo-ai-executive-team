import test from "node:test";
import assert from "node:assert/strict";

import {
  admitMutation,
  buildCompanyBrainApprovalTransitionCanonicalRequest,
  buildCompanyBrainApplyCanonicalRequest,
  buildCompanyBrainConflictCanonicalRequest,
  buildCompanyBrainReviewCanonicalRequest,
  buildCreateDocCanonicalRequest,
  buildDocumentCommentRewriteApplyCanonicalRequest,
  buildDriveOrganizeApplyCanonicalRequest,
  buildIngestCompanyBrainDocCanonicalRequest,
  buildIngestLearningDocCanonicalRequest,
  buildMeetingConfirmWriteCanonicalRequest,
  buildUpdateLearningStateCanonicalRequest,
  buildUpdateDocCanonicalRequest,
  buildWikiOrganizeApplyCanonicalRequest,
  collectCanonicalMutationRequestSchemaIssues,
  collectMutationAdmissionOutputSchemaIssues,
  listMutationAdmissionReadyRoutes,
} from "../src/mutation-admission.mjs";

test("canonical mutation builders emit the fixed request schema for the current Step 2 route families", () => {
  const createDoc = buildCreateDocCanonicalRequest({
    pathname: "/api/doc/create",
    folderToken: "fld-1",
    actor: {
      accountId: "acct-1",
    },
    context: {
      confirmed: true,
      verifierCompleted: true,
    },
  });
  const meeting = buildMeetingConfirmWriteCanonicalRequest({
    pathname: "/api/meeting/confirm",
    targetDocumentId: "doc-1",
    actor: {
      accountId: "acct-1",
    },
    context: {
      confirmed: false,
      verifierCompleted: true,
    },
  });
  const rewrite = buildDocumentCommentRewriteApplyCanonicalRequest({
    documentId: "doc-2",
    actor: {
      accountId: "acct-1",
    },
    context: {
      confirmed: true,
      verifierCompleted: true,
    },
  });
  const updateDoc = buildUpdateDocCanonicalRequest({
    documentId: "doc-update-1",
    actor: {
      accountId: "acct-1",
    },
    context: {
      confirmed: true,
      verifierCompleted: true,
    },
  });
  const drive = buildDriveOrganizeApplyCanonicalRequest({
    folderToken: "fld-ops",
    actor: {
      accountId: "acct-1",
    },
    context: {
      confirmed: true,
      verifierCompleted: true,
      reviewRequiredActive: true,
    },
  });
  const wiki = buildWikiOrganizeApplyCanonicalRequest({
    resourceId: "space-1",
    actor: {
      accountId: "acct-1",
    },
    context: {
      confirmed: true,
      verifierCompleted: true,
      reviewRequiredActive: true,
    },
  });
  const companyBrain = buildCompanyBrainApplyCanonicalRequest({
    docId: "cb-1",
    actor: {
      accountId: "acct-1",
    },
    context: {
      externalWrite: false,
      confirmed: true,
      verifierCompleted: true,
      reviewRequiredActive: true,
    },
  });
  const companyBrainReview = buildCompanyBrainReviewCanonicalRequest({
    docId: "cb-review-1",
    actor: {
      accountId: "acct-1",
    },
    context: {
      confirmed: true,
      verifierCompleted: true,
      reviewRequiredActive: true,
    },
  });
  const companyBrainApproval = buildCompanyBrainApprovalTransitionCanonicalRequest({
    docId: "cb-approval-1",
    actor: {
      accountId: "acct-1",
    },
    context: {
      confirmed: true,
      verifierCompleted: true,
      reviewRequiredActive: true,
    },
  });
  const companyBrainConflict = buildCompanyBrainConflictCanonicalRequest({
    docId: "cb-conflict-1",
    actor: {
      accountId: "acct-1",
    },
    context: {
      confirmed: true,
      verifierCompleted: true,
      reviewRequiredActive: true,
    },
  });
  const learningIngest = buildIngestLearningDocCanonicalRequest({
    docId: "cb-learning-1",
    actor: {
      accountId: "acct-1",
    },
    context: {
      confirmed: true,
      verifierCompleted: true,
    },
  });
  const learningUpdate = buildUpdateLearningStateCanonicalRequest({
    docId: "cb-learning-update-1",
    actor: {
      accountId: "acct-1",
    },
    context: {
      confirmed: true,
      verifierCompleted: true,
    },
  });
  const mirrorIngest = buildIngestCompanyBrainDocCanonicalRequest({
    docId: "cb-mirror-1",
    actor: {
      accountId: "acct-1",
    },
    context: {
      confirmed: true,
      verifierCompleted: true,
    },
  });

  for (const request of [
    createDoc,
    meeting,
    rewrite,
    updateDoc,
    drive,
    wiki,
    companyBrain,
    companyBrainReview,
    companyBrainConflict,
    companyBrainApproval,
    mirrorIngest,
    learningIngest,
    learningUpdate,
  ]) {
    assert.deepEqual(collectCanonicalMutationRequestSchemaIssues(request), []);
  }

  assert.equal(createDoc.action_type, "create_doc");
  assert.equal(createDoc.resource_type, "doc_container");
  assert.equal(meeting.action_type, "meeting_confirm_write");
  assert.equal(meeting.resource_type, "doc");
  assert.equal(rewrite.action_type, "rewrite_apply");
  assert.equal(updateDoc.action_type, "update_doc");
  assert.equal(updateDoc.resource_type, "doc");
  assert.equal(drive.resource_type, "drive_folder");
  assert.equal(wiki.resource_type, "wiki_space");
  assert.equal(companyBrain.action_type, "company_brain_apply");
  assert.equal(companyBrain.resource_type, "company_brain_doc");
  assert.equal(companyBrainReview.action_type, "review_company_brain_doc");
  assert.equal(companyBrainConflict.action_type, "check_company_brain_conflicts");
  assert.equal(companyBrainApproval.action_type, "approval_transition_company_brain_doc");
  assert.equal(mirrorIngest.action_type, "ingest_doc");
  assert.equal(learningIngest.action_type, "ingest_learning_doc");
  assert.equal(learningUpdate.action_type, "update_learning_state");
});

test("mutation admission adapter returns the fixed output schema and aligns to write_guard", () => {
  const canonicalRequest = buildMeetingConfirmWriteCanonicalRequest({
    pathname: "/api/meeting/confirm",
    targetDocumentId: "doc-1",
    actor: {
      accountId: "acct-1",
    },
    context: {
      confirmed: false,
      verifierCompleted: true,
    },
  });

  const result = admitMutation({
    canonicalRequest,
  });

  assert.deepEqual(collectMutationAdmissionOutputSchemaIssues(result), []);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "confirmation_required");
  assert.equal(result.guard_result.decision, "deny");
  assert.equal(result.guard_result.error_code, "write_guard_confirmation_required");
  assert.equal(result.policy_snapshot.source, "meeting_confirm");
  assert.equal(result.policy_snapshot.owner, "meeting_agent");
  assert.equal(typeof result.evidence.evidence_id, "string");
  assert.equal(typeof result.trace.trace_id, "string");
});

test("mutation admission adapter does not depend on original_request", () => {
  const baseInput = {
    pathname: "/api/doc/rewrite-from-comments",
    documentId: "doc-3",
    actor: {
      accountId: "acct-1",
    },
    context: {
      confirmed: true,
      verifierCompleted: true,
    },
  };
  const first = buildDocumentCommentRewriteApplyCanonicalRequest({
    ...baseInput,
    originalRequest: {
      patch_plan_ready: true,
      route_only_field: "alpha",
    },
  });
  const second = buildDocumentCommentRewriteApplyCanonicalRequest({
    ...baseInput,
    originalRequest: {
      patch_plan_ready: false,
      route_only_field: "beta",
      nested: {
        changed: true,
      },
    },
  });

  const firstResult = admitMutation({
    canonicalRequest: first,
  });
  const secondResult = admitMutation({
    canonicalRequest: second,
  });

  assert.deepEqual(firstResult, secondResult);
});

test("ready route list stays builder-only and covers the current Step 2 surfaces", () => {
  const routes = listMutationAdmissionReadyRoutes();
  const pathnames = routes.map((entry) => entry.pathname);

  assert.equal(routes.length, 14);
  assert.equal(pathnames.includes("/api/doc/create"), true);
  assert.equal(pathnames.includes("/agent/docs/create"), true);
  assert.equal(pathnames.includes("/api/doc/update"), true);
  assert.equal(pathnames.includes("/api/meeting/confirm"), true);
  assert.equal(pathnames.includes("/meeting/confirm"), true);
  assert.equal(pathnames.includes("/api/doc/rewrite-from-comments"), true);
  assert.equal(pathnames.includes("/api/drive/organize/apply"), true);
  assert.equal(pathnames.includes("/api/wiki/organize/apply"), true);
  assert.equal(pathnames.includes("/agent/company-brain/review"), true);
  assert.equal(pathnames.includes("/agent/company-brain/conflicts"), true);
  assert.equal(pathnames.includes("/agent/company-brain/approval-transition"), true);
  assert.equal(pathnames.includes("/agent/company-brain/docs/:doc_id/apply"), true);
  assert.equal(pathnames.includes("/agent/company-brain/learning/ingest"), true);
  assert.equal(pathnames.includes("/agent/company-brain/learning/state"), true);
  assert.equal(
    routes.find((entry) => entry.pathname === "/agent/company-brain/docs/:doc_id/apply")?.ordering,
    "lifecycle_first_adapter_second",
  );
  assert.equal(
    routes.find((entry) => entry.pathname === "/api/meeting/confirm")?.high_risk,
    true,
  );
  assert.equal(
    routes.find((entry) => entry.pathname === "/api/doc/rewrite-from-comments")?.high_risk,
    true,
  );
  assert.equal(
    routes.find((entry) => entry.pathname === "/agent/company-brain/docs/:doc_id/apply")?.verifier_gate_required,
    true,
  );
  assert.equal(
    routes.find((entry) => entry.pathname === "/agent/company-brain/learning/ingest")?.verifier_gate_required,
    true,
  );
});

test("internal high-risk writes are denied when verifier completion is missing", () => {
  const companyBrainApply = buildCompanyBrainApplyCanonicalRequest({
    docId: "cb-apply-1",
    actor: {
      accountId: "acct-1",
    },
    context: {
      externalWrite: false,
      confirmed: true,
      verifierCompleted: false,
      reviewRequiredActive: true,
    },
  });
  const learningIngest = buildIngestLearningDocCanonicalRequest({
    docId: "cb-learning-1",
    actor: {
      accountId: "acct-1",
    },
    context: {
      confirmed: true,
      verifierCompleted: false,
    },
  });

  const applyResult = admitMutation({
    canonicalRequest: companyBrainApply,
  });
  const learningResult = admitMutation({
    canonicalRequest: learningIngest,
  });

  assert.equal(applyResult.allowed, false);
  assert.equal(applyResult.reason, "verifier_incomplete");
  assert.equal(applyResult.guard_result.error_code, "write_guard_verifier_incomplete");
  assert.equal(learningResult.allowed, false);
  assert.equal(learningResult.reason, "verifier_incomplete");
  assert.equal(learningResult.guard_result.error_code, "write_guard_verifier_incomplete");
});

import test from "node:test";
import assert from "node:assert/strict";

import { getRouteContract } from "../src/http-route-contracts.mjs";
import {
  buildCompanyBrainApprovalTransitionWritePolicy,
  buildCompanyBrainApplyWritePolicy,
  buildCompanyBrainIngestWritePolicy,
  buildCompanyBrainLearningIngestWritePolicy,
  buildCompanyBrainReviewWritePolicy,
  buildCreateDocWritePolicy,
  buildDocumentCommentRewriteApplyWritePolicy,
  buildDriveOrganizeApplyWritePolicy,
  buildMeetingConfirmWritePolicy,
  buildUpdateDocWritePolicy,
  buildWikiOrganizeApplyWritePolicy,
  collectWritePolicyMissingFields,
  listPhase1RouteWritePolicyFixtures,
  WRITE_POLICY_VERSION,
} from "../src/write-policy-contract.mjs";
import {
  listWritePolicyEnforcementFixtures,
} from "../src/write-policy-enforcement.mjs";

test("write policy builders normalize phase1 metadata with stable contract fields", () => {
  const createPolicy = buildCreateDocWritePolicy({
    folderToken: "fld_123",
    idempotencyKey: "idem-create",
  });
  const drivePolicy = buildDriveOrganizeApplyWritePolicy({
    scopeKey: "drive:fld_ops",
    idempotencyKey: "idem-drive",
  });
  const wikiPolicy = buildWikiOrganizeApplyWritePolicy({
    spaceId: "space_123",
  });
  const rewritePolicy = buildDocumentCommentRewriteApplyWritePolicy({
    documentId: "doc_123",
  });
  const meetingPolicy = buildMeetingConfirmWritePolicy({
    confirmationId: "confirm_123",
    targetDocumentId: "doc_meeting",
  });
  const updatePolicy = buildUpdateDocWritePolicy({
    documentId: "doc_update",
    idempotencyKey: "idem-update",
  });
  const reviewPolicy = buildCompanyBrainReviewWritePolicy({
    docId: "cb_doc",
  });
  const approvalTransitionPolicy = buildCompanyBrainApprovalTransitionWritePolicy({
    docId: "cb_doc",
  });
  const applyPolicy = buildCompanyBrainApplyWritePolicy({
    docId: "cb_doc",
  });
  const learningIngestPolicy = buildCompanyBrainLearningIngestWritePolicy({
    docId: "cb_doc",
  });
  const mirrorIngestPolicy = buildCompanyBrainIngestWritePolicy({
    docId: "cb_doc",
  });

  assert.deepEqual(createPolicy, {
    policy_version: WRITE_POLICY_VERSION,
    source: "create_doc",
    owner: "document_http_route",
    intent: "create_doc",
    action_type: "create",
    external_write: true,
    confirm_required: true,
    review_required: "conditional",
    scope_key: "drive:fld_123",
    idempotency_key: "idem-create",
  });
  assert.equal(drivePolicy.action_type, "move");
  assert.equal(drivePolicy.review_required, "always");
  assert.equal(drivePolicy.scope_key, "drive:fld_ops");
  assert.equal(drivePolicy.idempotency_key, "idem-drive");
  assert.equal(wikiPolicy.scope_key, "wiki:space_123");
  assert.equal(rewritePolicy.scope_key, "doc-rewrite:doc_123");
  assert.equal(rewritePolicy.action_type, "replace");
  assert.equal(meetingPolicy.scope_key, "doc:doc_meeting");
  assert.equal(meetingPolicy.action_type, "writeback");
  assert.equal(updatePolicy.scope_key, "document:doc_update");
  assert.equal(updatePolicy.action_type, "update");
  assert.equal(updatePolicy.idempotency_key, "idem-update");
  assert.equal(reviewPolicy.action_type, "review");
  assert.equal(reviewPolicy.scope_key, "company-brain:cb_doc");
  assert.equal(approvalTransitionPolicy.action_type, "approval_transition");
  assert.equal(applyPolicy.action_type, "apply");
  assert.equal(learningIngestPolicy.action_type, "ingest");
  assert.equal(mirrorIngestPolicy.action_type, "ingest");
  assert.equal(mirrorIngestPolicy.review_required, "conditional");
  assert.deepEqual(collectWritePolicyMissingFields(meetingPolicy), []);
});

test("create_doc policy falls back to a stable root scope key", () => {
  const createPolicy = buildCreateDocWritePolicy();

  assert.equal(createPolicy.scope_key, "drive:root");
});

test("phase1 route contracts expose complete write policy metadata for each wired surface", () => {
  const fixtures = listPhase1RouteWritePolicyFixtures();
  const enforcementFixtures = listWritePolicyEnforcementFixtures();

  assert.equal(fixtures.length, 33);
  assert.equal(enforcementFixtures.length, 33);

  for (const fixture of fixtures) {
    const routeContract = getRouteContract(fixture.pathname, fixture.method);
    const enforcementFixture = enforcementFixtures.find((item) => (
      item.pathname === fixture.pathname && item.method === fixture.method
    ));

    assert.equal(routeContract?.action, fixture.action);
    assert.deepEqual(collectWritePolicyMissingFields(routeContract?.write_policy), []);
    assert.deepEqual(routeContract?.write_policy, fixture.write_policy);
    assert.deepEqual(routeContract?.write_policy_enforcement, enforcementFixture);
  }
});

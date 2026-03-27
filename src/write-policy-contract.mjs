import { cleanText } from "./message-intent-utils.mjs";
import {
  getExternalMutationSpec,
  listExternalMutationRouteFixtures,
} from "./external-mutation-registry.mjs";

export const WRITE_POLICY_VERSION = "write_policy_v1";
export const WRITE_POLICY_REVIEW_REQUIRED_VALUES = Object.freeze([
  "never",
  "conditional",
  "always",
]);
export const WRITE_POLICY_ACTION_TYPES = Object.freeze([
  "create",
  "update",
  "replace",
  "move",
  "delete",
  "reply",
  "apply",
  "writeback",
  "ingest",
  "review",
  "approval_transition",
  "upsert",
]);

function normalizeNullableText(value) {
  const normalized = cleanText(value);
  return normalized || null;
}

function normalizeReviewRequired(value = "") {
  const normalized = cleanText(value).toLowerCase();
  return WRITE_POLICY_REVIEW_REQUIRED_VALUES.includes(normalized)
    ? normalized
    : null;
}

function normalizeActionType(value = "") {
  const normalized = cleanText(value).toLowerCase();
  return WRITE_POLICY_ACTION_TYPES.includes(normalized)
    ? normalized
    : null;
}

function cloneRouteFixture(entry = {}) {
  return {
    pathname: cleanText(entry.pathname) || null,
    method: cleanText(entry.method).toUpperCase() || "POST",
    action: cleanText(entry.action) || null,
    write_policy: cloneWritePolicyRecord(entry.write_policy),
  };
}

export function buildWritePolicyRecord({
  source = "",
  owner = "",
  intent = "",
  actionType = "",
  externalWrite = false,
  confirmRequired = false,
  reviewRequired = "never",
  scopeKey = null,
  idempotencyKey = null,
} = {}) {
  return Object.freeze({
    policy_version: WRITE_POLICY_VERSION,
    source: normalizeNullableText(source),
    owner: normalizeNullableText(owner),
    intent: normalizeNullableText(intent),
    action_type: normalizeActionType(actionType),
    external_write: externalWrite === true,
    confirm_required: confirmRequired === true,
    review_required: normalizeReviewRequired(reviewRequired),
    scope_key: normalizeNullableText(scopeKey),
    idempotency_key: normalizeNullableText(idempotencyKey),
  });
}

export function buildExternalWritePolicy(action = "", {
  scopeKey = null,
  idempotencyKey = null,
  confirmRequired = null,
  reviewRequired = null,
} = {}) {
  const spec = getExternalMutationSpec(action);
  if (!spec) {
    return null;
  }

  return buildWritePolicyRecord({
    source: spec.source,
    owner: spec.owner,
    intent: spec.intent,
    actionType: spec.policy_action_type,
    externalWrite: true,
    confirmRequired: typeof confirmRequired === "boolean" ? confirmRequired : spec.confirm_required === true,
    reviewRequired: cleanText(reviewRequired) || spec.review_required || "never",
    scopeKey,
    idempotencyKey,
  });
}

export function cloneWritePolicyRecord(policy = null) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return null;
  }
  return buildWritePolicyRecord({
    source: policy.source,
    owner: policy.owner,
    intent: policy.intent,
    actionType: policy.action_type,
    externalWrite: policy.external_write === true,
    confirmRequired: policy.confirm_required === true,
    reviewRequired: policy.review_required,
    scopeKey: policy.scope_key,
    idempotencyKey: policy.idempotency_key,
  });
}

export function collectWritePolicyMissingFields(policy = null) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return [
      "policy_version",
      "source",
      "owner",
      "intent",
      "action_type",
      "external_write",
      "confirm_required",
      "review_required",
      "scope_key",
      "idempotency_key",
    ];
  }

  const missing = [];
  if (cleanText(policy.policy_version) !== WRITE_POLICY_VERSION) {
    missing.push("policy_version");
  }
  if (!cleanText(policy.source)) {
    missing.push("source");
  }
  if (!cleanText(policy.owner)) {
    missing.push("owner");
  }
  if (!cleanText(policy.intent)) {
    missing.push("intent");
  }
  if (!cleanText(policy.action_type)) {
    missing.push("action_type");
  }
  if (typeof policy.external_write !== "boolean") {
    missing.push("external_write");
  }
  if (typeof policy.confirm_required !== "boolean") {
    missing.push("confirm_required");
  }
  if (!cleanText(policy.review_required)) {
    missing.push("review_required");
  }
  if (!Object.prototype.hasOwnProperty.call(policy, "scope_key")) {
    missing.push("scope_key");
  }
  if (!Object.prototype.hasOwnProperty.call(policy, "idempotency_key")) {
    missing.push("idempotency_key");
  }
  return missing;
}

export function buildCreateDocWritePolicy({
  scopeKey = null,
  folderToken = "",
  idempotencyKey = null,
} = {}) {
  return buildExternalWritePolicy("create_doc", {
    scopeKey: normalizeNullableText(scopeKey) || (cleanText(folderToken) ? `drive:${cleanText(folderToken)}` : "drive:root"),
    idempotencyKey,
  });
}

export function buildUpdateDocWritePolicy({
  scopeKey = null,
  documentId = "",
  actionType = "update",
  confirmRequired = false,
  idempotencyKey = null,
} = {}) {
  const basePolicy = buildExternalWritePolicy("update_doc", {
    scopeKey: normalizeNullableText(scopeKey) || (cleanText(documentId) ? `document:${cleanText(documentId)}` : null),
    idempotencyKey,
    confirmRequired: confirmRequired === true,
    reviewRequired: "conditional",
  });
  if (!basePolicy) {
    return null;
  }
  return buildWritePolicyRecord({
    source: basePolicy.source,
    owner: basePolicy.owner,
    intent: basePolicy.intent,
    actionType: normalizeActionType(actionType),
    externalWrite: basePolicy.external_write === true,
    confirmRequired: basePolicy.confirm_required === true,
    reviewRequired: basePolicy.review_required,
    scopeKey: basePolicy.scope_key,
    idempotencyKey: basePolicy.idempotency_key,
  });
}

export function buildDriveOrganizeApplyWritePolicy({
  scopeKey = null,
  folderToken = "",
  idempotencyKey = null,
} = {}) {
  return buildExternalWritePolicy("drive_organize_apply", {
    scopeKey: normalizeNullableText(scopeKey) || (cleanText(folderToken) ? `drive:${cleanText(folderToken)}` : null),
    idempotencyKey,
  });
}

export function buildWikiOrganizeApplyWritePolicy({
  scopeKey = null,
  spaceId = "",
  parentNodeToken = "",
  spaceName = "",
  idempotencyKey = null,
} = {}) {
  const fallbackScope =
    cleanText(spaceId)
    || cleanText(parentNodeToken)
    || cleanText(spaceName);
  return buildExternalWritePolicy("wiki_organize_apply", {
    scopeKey: normalizeNullableText(scopeKey) || (fallbackScope ? `wiki:${fallbackScope}` : null),
    idempotencyKey,
  });
}

export function buildDocumentCommentRewriteApplyWritePolicy({
  documentId = "",
  idempotencyKey = null,
} = {}) {
  return buildExternalWritePolicy("document_comment_rewrite_apply", {
    scopeKey: cleanText(documentId) ? `doc-rewrite:${cleanText(documentId)}` : null,
    idempotencyKey,
  });
}

export function buildMeetingConfirmWritePolicy({
  confirmationId = "",
  targetDocumentId = "",
  idempotencyKey = null,
} = {}) {
  return buildExternalWritePolicy("meeting_confirm_write", {
    scopeKey: cleanText(targetDocumentId)
      ? `doc:${cleanText(targetDocumentId)}`
      : cleanText(confirmationId)
        ? `meeting-confirm:${cleanText(confirmationId)}`
        : null,
    idempotencyKey,
  });
}

export function buildCompanyBrainApplyWritePolicy({
  docId = "",
  idempotencyKey = null,
} = {}) {
  return buildWritePolicyRecord({
    source: "company_brain_apply",
    owner: "company_brain_review_runtime",
    intent: "formal_company_brain_apply",
    actionType: "apply",
    externalWrite: false,
    confirmRequired: false,
    reviewRequired: "always",
    scopeKey: cleanText(docId) ? `company-brain:${cleanText(docId)}` : null,
    idempotencyKey,
  });
}

export function buildCompanyBrainReviewWritePolicy({
  docId = "",
  idempotencyKey = null,
} = {}) {
  return buildWritePolicyRecord({
    source: "company_brain_review",
    owner: "company_brain_review_runtime",
    intent: "review_company_brain_doc",
    actionType: "review",
    externalWrite: false,
    confirmRequired: false,
    reviewRequired: "always",
    scopeKey: cleanText(docId) ? `company-brain:${cleanText(docId)}` : null,
    idempotencyKey,
  });
}

export function buildCompanyBrainConflictWritePolicy({
  docId = "",
  idempotencyKey = null,
} = {}) {
  return buildWritePolicyRecord({
    source: "company_brain_conflicts",
    owner: "company_brain_review_runtime",
    intent: "check_company_brain_conflicts",
    actionType: "review",
    externalWrite: false,
    confirmRequired: false,
    reviewRequired: "conditional",
    scopeKey: cleanText(docId) ? `company-brain:${cleanText(docId)}` : null,
    idempotencyKey,
  });
}

export function buildCompanyBrainApprovalTransitionWritePolicy({
  docId = "",
  idempotencyKey = null,
} = {}) {
  return buildWritePolicyRecord({
    source: "company_brain_approval_transition",
    owner: "company_brain_review_runtime",
    intent: "approval_transition_company_brain_doc",
    actionType: "approval_transition",
    externalWrite: false,
    confirmRequired: false,
    reviewRequired: "always",
    scopeKey: cleanText(docId) ? `company-brain:${cleanText(docId)}` : null,
    idempotencyKey,
  });
}

export function buildCompanyBrainLearningIngestWritePolicy({
  docId = "",
  idempotencyKey = null,
} = {}) {
  return buildWritePolicyRecord({
    source: "company_brain_learning_ingest",
    owner: "company_brain_learning_runtime",
    intent: "ingest_learning_doc",
    actionType: "ingest",
    externalWrite: false,
    confirmRequired: false,
    reviewRequired: "never",
    scopeKey: cleanText(docId) ? `company-brain:${cleanText(docId)}` : null,
    idempotencyKey,
  });
}

export function buildCompanyBrainLearningUpdateWritePolicy({
  docId = "",
  idempotencyKey = null,
} = {}) {
  return buildWritePolicyRecord({
    source: "company_brain_learning_update",
    owner: "company_brain_learning_runtime",
    intent: "update_learning_state",
    actionType: "upsert",
    externalWrite: false,
    confirmRequired: false,
    reviewRequired: "never",
    scopeKey: cleanText(docId) ? `company-brain:${cleanText(docId)}` : null,
    idempotencyKey,
  });
}

export function buildCompanyBrainIngestWritePolicy({
  docId = "",
  idempotencyKey = null,
} = {}) {
  return buildWritePolicyRecord({
    source: "company_brain_verified_ingest",
    owner: "company_brain_write_intake",
    intent: "ingest_doc",
    actionType: "ingest",
    externalWrite: false,
    confirmRequired: false,
    reviewRequired: "conditional",
    scopeKey: cleanText(docId) ? `company-brain:${cleanText(docId)}` : null,
    idempotencyKey,
  });
}

const PHASE1_ROUTE_WRITE_POLICY_FIXTURES = Object.freeze(
  listExternalMutationRouteFixtures().map((fixture) => Object.freeze({
    pathname: fixture.pathname,
    method: fixture.method,
    action: fixture.action,
    write_policy: buildExternalWritePolicy(fixture.action, {
      scopeKey: fixture.fixture_scope_key,
      idempotencyKey: fixture.fixture_idempotency_key,
    }),
  })),
);

export function listPhase1RouteWritePolicyFixtures() {
  return PHASE1_ROUTE_WRITE_POLICY_FIXTURES.map((entry) => cloneRouteFixture(entry));
}

export function getPhase1RouteWritePolicyFixture(pathname = "", method = "") {
  const normalizedPathname = cleanText(pathname);
  const normalizedMethod = cleanText(method).toUpperCase();
  if (!normalizedPathname) {
    return null;
  }
  const matched = PHASE1_ROUTE_WRITE_POLICY_FIXTURES.find((entry) => (
    entry.pathname === normalizedPathname
    && (!normalizedMethod || (cleanText(entry.method).toUpperCase() || "POST") === normalizedMethod)
  ));
  return matched ? cloneRouteFixture(matched) : null;
}

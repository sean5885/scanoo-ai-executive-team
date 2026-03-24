import { cleanText } from "./message-intent-utils.mjs";

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
  return buildWritePolicyRecord({
    source: "create_doc",
    owner: "document_http_route",
    intent: "create_doc",
    actionType: "create",
    externalWrite: true,
    confirmRequired: true,
    reviewRequired: "conditional",
    scopeKey: normalizeNullableText(scopeKey) || (cleanText(folderToken) ? `drive:${cleanText(folderToken)}` : "drive:root"),
    idempotencyKey,
  });
}

export function buildDriveOrganizeApplyWritePolicy({
  scopeKey = null,
  folderToken = "",
  idempotencyKey = null,
} = {}) {
  return buildWritePolicyRecord({
    source: "cloud_doc_workflow",
    owner: "cloud_doc_workflow",
    intent: "drive_organize_apply",
    actionType: "move",
    externalWrite: true,
    confirmRequired: true,
    reviewRequired: "always",
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
  return buildWritePolicyRecord({
    source: "cloud_doc_workflow",
    owner: "cloud_doc_workflow",
    intent: "wiki_organize_apply",
    actionType: "move",
    externalWrite: true,
    confirmRequired: true,
    reviewRequired: "always",
    scopeKey: normalizeNullableText(scopeKey) || (fallbackScope ? `wiki:${fallbackScope}` : null),
    idempotencyKey,
  });
}

export function buildDocumentCommentRewriteApplyWritePolicy({
  documentId = "",
  idempotencyKey = null,
} = {}) {
  return buildWritePolicyRecord({
    source: "doc_comment_rewrite",
    owner: "doc_rewrite_workflow",
    intent: "rewrite_apply",
    actionType: "replace",
    externalWrite: true,
    confirmRequired: true,
    reviewRequired: "never",
    scopeKey: cleanText(documentId) ? `doc-rewrite:${cleanText(documentId)}` : null,
    idempotencyKey,
  });
}

export function buildMeetingConfirmWritePolicy({
  confirmationId = "",
  targetDocumentId = "",
  idempotencyKey = null,
} = {}) {
  return buildWritePolicyRecord({
    source: "meeting_confirm",
    owner: "meeting_agent",
    intent: "meeting_writeback",
    actionType: "writeback",
    externalWrite: true,
    confirmRequired: true,
    reviewRequired: "never",
    scopeKey: cleanText(targetDocumentId)
      ? `doc:${cleanText(targetDocumentId)}`
      : cleanText(confirmationId)
        ? `meeting-confirm:${cleanText(confirmationId)}`
        : null,
    idempotencyKey,
  });
}

const PHASE1_ROUTE_WRITE_POLICY_FIXTURES = Object.freeze([
  Object.freeze({
    pathname: "/api/doc/create",
    action: "create_doc",
    write_policy: buildCreateDocWritePolicy(),
  }),
  Object.freeze({
    pathname: "/agent/docs/create",
    action: "create_doc",
    write_policy: buildCreateDocWritePolicy(),
  }),
  Object.freeze({
    pathname: "/api/drive/organize/apply",
    action: "drive_organize_apply",
    write_policy: buildDriveOrganizeApplyWritePolicy(),
  }),
  Object.freeze({
    pathname: "/api/wiki/organize/apply",
    action: "wiki_organize_apply",
    write_policy: buildWikiOrganizeApplyWritePolicy(),
  }),
  Object.freeze({
    pathname: "/api/doc/rewrite-from-comments",
    action: "document_comment_rewrite_apply",
    write_policy: buildDocumentCommentRewriteApplyWritePolicy(),
  }),
  Object.freeze({
    pathname: "/api/meeting/confirm",
    action: "meeting_confirm_write",
    write_policy: buildMeetingConfirmWritePolicy(),
  }),
  Object.freeze({
    pathname: "/meeting/confirm",
    action: "meeting_confirm_write",
    write_policy: buildMeetingConfirmWritePolicy(),
  }),
]);

export function listPhase1RouteWritePolicyFixtures() {
  return PHASE1_ROUTE_WRITE_POLICY_FIXTURES.map((entry) => cloneRouteFixture(entry));
}

export function getPhase1RouteWritePolicyFixture(pathname = "") {
  const normalizedPathname = cleanText(pathname);
  if (!normalizedPathname) {
    return null;
  }
  const matched = PHASE1_ROUTE_WRITE_POLICY_FIXTURES.find((entry) => entry.pathname === normalizedPathname);
  return matched ? cloneRouteFixture(matched) : null;
}

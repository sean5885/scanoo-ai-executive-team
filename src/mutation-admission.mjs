import { createHash } from "node:crypto";

import { cleanText } from "./message-intent-utils.mjs";
import { decideWriteGuard } from "./write-guard.mjs";
import {
  buildCompanyBrainApprovalTransitionWritePolicy,
  buildCompanyBrainApplyWritePolicy,
  buildCompanyBrainLearningIngestWritePolicy,
  buildCompanyBrainReviewWritePolicy,
  buildCreateDocWritePolicy,
  buildDocumentCommentRewriteApplyWritePolicy,
  buildDriveOrganizeApplyWritePolicy,
  buildMeetingConfirmWritePolicy,
  buildUpdateDocWritePolicy,
  buildWikiOrganizeApplyWritePolicy,
  buildWritePolicyRecord,
  cloneWritePolicyRecord,
} from "./write-policy-contract.mjs";

export const MUTATION_ADMISSION_CONTRACT_VERSION = "mutation_admission_contract_v1";
export const MUTATION_ADMISSION_ACTION_TYPES = Object.freeze([
  "create_doc",
  "update_doc",
  "meeting_confirm_write",
  "rewrite_apply",
  "organize_apply",
  "review_company_brain_doc",
  "approval_transition_company_brain_doc",
  "company_brain_apply",
  "ingest_learning_doc",
]);
export const MUTATION_ADMISSION_RESOURCE_TYPES = Object.freeze([
  "doc_container",
  "doc",
  "drive_folder",
  "wiki_space",
  "company_brain_doc",
]);

const MUTATION_ADMISSION_READY_ROUTE_FIXTURES = Object.freeze([
  Object.freeze({
    route_id: "create_doc_public",
    pathname: "/api/doc/create",
    method: "POST",
    builder: "buildCreateDocCanonicalRequest",
    action_type: "create_doc",
    resource_type: "doc_container",
  }),
  Object.freeze({
    route_id: "create_doc_agent",
    pathname: "/agent/docs/create",
    method: "POST",
    builder: "buildCreateDocCanonicalRequest",
    action_type: "create_doc",
    resource_type: "doc_container",
  }),
  Object.freeze({
    route_id: "update_doc",
    pathname: "/api/doc/update",
    method: "POST",
    builder: "buildUpdateDocCanonicalRequest",
    action_type: "update_doc",
    resource_type: "doc",
  }),
  Object.freeze({
    route_id: "meeting_confirm_api",
    pathname: "/api/meeting/confirm",
    method: "POST",
    builder: "buildMeetingConfirmWriteCanonicalRequest",
    action_type: "meeting_confirm_write",
    resource_type: "doc",
  }),
  Object.freeze({
    route_id: "meeting_confirm_page",
    pathname: "/meeting/confirm",
    method: "GET",
    builder: "buildMeetingConfirmWriteCanonicalRequest",
    action_type: "meeting_confirm_write",
    resource_type: "doc",
  }),
  Object.freeze({
    route_id: "doc_rewrite_apply",
    pathname: "/api/doc/rewrite-from-comments",
    method: "POST",
    builder: "buildDocumentCommentRewriteApplyCanonicalRequest",
    action_type: "rewrite_apply",
    resource_type: "doc",
  }),
  Object.freeze({
    route_id: "drive_organize_apply",
    pathname: "/api/drive/organize/apply",
    method: "POST",
    builder: "buildDriveOrganizeApplyCanonicalRequest",
    action_type: "organize_apply",
    resource_type: "drive_folder",
  }),
  Object.freeze({
    route_id: "wiki_organize_apply",
    pathname: "/api/wiki/organize/apply",
    method: "POST",
    builder: "buildWikiOrganizeApplyCanonicalRequest",
    action_type: "organize_apply",
    resource_type: "wiki_space",
  }),
  Object.freeze({
    route_id: "company_brain_review",
    pathname: "/agent/company-brain/review",
    method: "POST",
    builder: "buildCompanyBrainReviewCanonicalRequest",
    action_type: "review_company_brain_doc",
    resource_type: "company_brain_doc",
  }),
  Object.freeze({
    route_id: "company_brain_approval_transition",
    pathname: "/agent/company-brain/approval-transition",
    method: "POST",
    builder: "buildCompanyBrainApprovalTransitionCanonicalRequest",
    action_type: "approval_transition_company_brain_doc",
    resource_type: "company_brain_doc",
  }),
  Object.freeze({
    route_id: "company_brain_apply",
    pathname: "/agent/company-brain/docs/:doc_id/apply",
    method: "POST",
    builder: "buildCompanyBrainApplyCanonicalRequest",
    action_type: "company_brain_apply",
    resource_type: "company_brain_doc",
    ordering: "lifecycle_first_adapter_second",
  }),
  Object.freeze({
    route_id: "company_brain_learning_ingest",
    pathname: "/agent/company-brain/learning/ingest",
    method: "POST",
    builder: "buildIngestLearningDocCanonicalRequest",
    action_type: "ingest_learning_doc",
    resource_type: "company_brain_doc",
  }),
]);

function normalizeNullableText(value) {
  const normalized = cleanText(value);
  return normalized || null;
}

function normalizeActionType(value = "") {
  const normalized = cleanText(value);
  return MUTATION_ADMISSION_ACTION_TYPES.includes(normalized) ? normalized : null;
}

function normalizeResourceType(value = "") {
  const normalized = cleanText(value);
  return MUTATION_ADMISSION_RESOURCE_TYPES.includes(normalized) ? normalized : null;
}

function normalizeMethod(value = "") {
  const normalized = cleanText(value).toUpperCase();
  return normalized || null;
}

function normalizeBoolean(value = false) {
  return value === true;
}

function cloneOpaqueObject(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value)) {
    return [...value];
  }
  return { ...value };
}

function freezeCanonicalRequest(request = {}) {
  return Object.freeze({
    action_type: request.action_type,
    resource_type: request.resource_type,
    resource_id: request.resource_id,
    actor: Object.freeze({
      source: request.actor?.source ?? null,
      owner: request.actor?.owner ?? null,
      account_id: request.actor?.account_id ?? null,
    }),
    context: Object.freeze({
      pathname: request.context?.pathname ?? null,
      method: request.context?.method ?? null,
      scope_key: request.context?.scope_key ?? null,
      idempotency_key: request.context?.idempotency_key ?? null,
      external_write: request.context?.external_write === true,
      confirmed: request.context?.confirmed === true,
      verifier_completed: request.context?.verifier_completed === true,
      review_required_active: request.context?.review_required_active === true,
    }),
    original_request: request.original_request,
  });
}

function sanitizeGuardResult(guardResult = null) {
  return {
    decision: cleanText(guardResult?.decision) || "deny",
    reason: normalizeNullableText(guardResult?.reason),
    error_code: normalizeNullableText(guardResult?.error_code),
    policy_enforcement:
      guardResult?.policy_enforcement && typeof guardResult.policy_enforcement === "object" && !Array.isArray(guardResult.policy_enforcement)
        ? { ...guardResult.policy_enforcement }
        : null,
  };
}

function buildTraceId(canonicalRequest = null) {
  const seed = JSON.stringify({
    action_type: canonicalRequest?.action_type || null,
    resource_type: canonicalRequest?.resource_type || null,
    resource_id: canonicalRequest?.resource_id || null,
    actor: canonicalRequest?.actor || null,
    context: canonicalRequest?.context || null,
  });
  return `trace_mutation_admission_${createHash("sha256").update(seed).digest("hex").slice(0, 12)}`;
}

function buildEvidenceId({ canonicalRequest = null, traceId = null } = {}) {
  const seed = JSON.stringify({
    action_type: canonicalRequest?.action_type || null,
    resource_type: canonicalRequest?.resource_type || null,
    resource_id: canonicalRequest?.resource_id || null,
    actor: canonicalRequest?.actor || null,
    context: canonicalRequest?.context || null,
    trace_id: traceId || null,
  });
  return `evidence_mutation_admission_${createHash("sha256").update(seed).digest("hex").slice(0, 12)}`;
}

function buildPolicySnapshotFromCanonicalRequest(canonicalRequest = null) {
  const request = cloneCanonicalMutationRequest(canonicalRequest);
  const actionType = request?.action_type;
  const resourceId = request?.resource_id;
  const scopeKey = request?.context?.scope_key;
  const idempotencyKey = request?.context?.idempotency_key;

  let basePolicy = null;
  if (actionType === "create_doc") {
    basePolicy = buildCreateDocWritePolicy({
      scopeKey,
      folderToken: resourceId || "",
      idempotencyKey,
    });
  } else if (actionType === "update_doc") {
    basePolicy = buildUpdateDocWritePolicy({
      scopeKey,
      documentId: resourceId || "",
      idempotencyKey,
    });
  } else if (actionType === "meeting_confirm_write") {
    basePolicy = buildMeetingConfirmWritePolicy({
      targetDocumentId: resourceId || "",
      idempotencyKey,
    });
  } else if (actionType === "rewrite_apply") {
    basePolicy = buildDocumentCommentRewriteApplyWritePolicy({
      documentId: resourceId || "",
      idempotencyKey,
    });
  } else if (actionType === "organize_apply" && request?.resource_type === "drive_folder") {
    basePolicy = buildDriveOrganizeApplyWritePolicy({
      scopeKey,
      folderToken: resourceId || "",
      idempotencyKey,
    });
  } else if (actionType === "organize_apply" && request?.resource_type === "wiki_space") {
    basePolicy = buildWikiOrganizeApplyWritePolicy({
      scopeKey,
      spaceId: resourceId || "",
      idempotencyKey,
    });
  } else if (actionType === "company_brain_apply") {
    basePolicy = buildCompanyBrainApplyWritePolicy({
      docId: resourceId || "",
      idempotencyKey,
    });
  } else if (actionType === "review_company_brain_doc") {
    basePolicy = buildCompanyBrainReviewWritePolicy({
      docId: resourceId || "",
      idempotencyKey,
    });
  } else if (actionType === "approval_transition_company_brain_doc") {
    basePolicy = buildCompanyBrainApprovalTransitionWritePolicy({
      docId: resourceId || "",
      idempotencyKey,
    });
  } else if (actionType === "ingest_learning_doc") {
    basePolicy = buildCompanyBrainLearningIngestWritePolicy({
      docId: resourceId || "",
      idempotencyKey,
    });
  } else {
    basePolicy = buildWritePolicyRecord({
      source: request?.actor?.source || "",
      owner: request?.actor?.owner || "",
      intent: actionType || "",
      actionType: "",
      externalWrite: request?.context?.external_write === true,
      confirmRequired: false,
      reviewRequired: "never",
      scopeKey,
      idempotencyKey,
    });
  }

  return buildWritePolicyRecord({
    source: request?.actor?.source || basePolicy?.source || "",
    owner: request?.actor?.owner || basePolicy?.owner || "",
    intent: basePolicy?.intent || actionType || "",
    actionType: basePolicy?.action_type || "",
    externalWrite: request?.context?.external_write === true,
    confirmRequired: basePolicy?.confirm_required === true,
    reviewRequired: basePolicy?.review_required || "never",
    scopeKey: scopeKey || basePolicy?.scope_key || null,
    idempotencyKey: idempotencyKey || basePolicy?.idempotency_key || null,
  });
}

export function buildCanonicalMutationRequest({
  actionType = "",
  resourceType = "",
  resourceId = null,
  actor = {},
  context = {},
  originalRequest = null,
} = {}) {
  return freezeCanonicalRequest({
    action_type: normalizeActionType(actionType),
    resource_type: normalizeResourceType(resourceType),
    resource_id: normalizeNullableText(resourceId),
    actor: {
      source: normalizeNullableText(actor.source),
      owner: normalizeNullableText(actor.owner),
      account_id: normalizeNullableText(actor.accountId ?? actor.account_id),
    },
    context: {
      pathname: normalizeNullableText(context.pathname),
      method: normalizeMethod(context.method),
      scope_key: normalizeNullableText(context.scopeKey ?? context.scope_key),
      idempotency_key: normalizeNullableText(context.idempotencyKey ?? context.idempotency_key),
      external_write: normalizeBoolean(context.externalWrite ?? context.external_write),
      confirmed: normalizeBoolean(context.confirmed),
      verifier_completed: normalizeBoolean(context.verifierCompleted ?? context.verifier_completed),
      review_required_active: normalizeBoolean(context.reviewRequiredActive ?? context.review_required_active),
    },
    original_request: cloneOpaqueObject(originalRequest),
  });
}

export function cloneCanonicalMutationRequest(canonicalRequest = null) {
  if (!canonicalRequest || typeof canonicalRequest !== "object" || Array.isArray(canonicalRequest)) {
    return null;
  }
  return buildCanonicalMutationRequest({
    actionType: canonicalRequest.action_type,
    resourceType: canonicalRequest.resource_type,
    resourceId: canonicalRequest.resource_id,
    actor: canonicalRequest.actor,
    context: canonicalRequest.context,
    originalRequest: canonicalRequest.original_request,
  });
}

export function collectCanonicalMutationRequestSchemaIssues(canonicalRequest = null) {
  if (!canonicalRequest || typeof canonicalRequest !== "object" || Array.isArray(canonicalRequest)) {
    return ["canonical_request_missing"];
  }

  const issues = [];
  if (!normalizeActionType(canonicalRequest.action_type)) {
    issues.push("action_type");
  }
  if (!normalizeResourceType(canonicalRequest.resource_type)) {
    issues.push("resource_type");
  }
  if (!Object.prototype.hasOwnProperty.call(canonicalRequest, "resource_id")) {
    issues.push("resource_id");
  }
  if (!canonicalRequest.actor || typeof canonicalRequest.actor !== "object" || Array.isArray(canonicalRequest.actor)) {
    issues.push("actor");
  } else {
    if (!normalizeNullableText(canonicalRequest.actor.source)) {
      issues.push("actor.source");
    }
    if (!normalizeNullableText(canonicalRequest.actor.owner)) {
      issues.push("actor.owner");
    }
    if (!Object.prototype.hasOwnProperty.call(canonicalRequest.actor, "account_id")) {
      issues.push("actor.account_id");
    }
  }
  if (!canonicalRequest.context || typeof canonicalRequest.context !== "object" || Array.isArray(canonicalRequest.context)) {
    issues.push("context");
  } else {
    if (!Object.prototype.hasOwnProperty.call(canonicalRequest.context, "pathname")) {
      issues.push("context.pathname");
    }
    if (!Object.prototype.hasOwnProperty.call(canonicalRequest.context, "method")) {
      issues.push("context.method");
    }
    if (!Object.prototype.hasOwnProperty.call(canonicalRequest.context, "scope_key")) {
      issues.push("context.scope_key");
    }
    if (!Object.prototype.hasOwnProperty.call(canonicalRequest.context, "idempotency_key")) {
      issues.push("context.idempotency_key");
    }
    if (typeof canonicalRequest.context.external_write !== "boolean") {
      issues.push("context.external_write");
    }
    if (typeof canonicalRequest.context.confirmed !== "boolean") {
      issues.push("context.confirmed");
    }
    if (typeof canonicalRequest.context.verifier_completed !== "boolean") {
      issues.push("context.verifier_completed");
    }
    if (typeof canonicalRequest.context.review_required_active !== "boolean") {
      issues.push("context.review_required_active");
    }
  }
  if (!Object.prototype.hasOwnProperty.call(canonicalRequest, "original_request")) {
    issues.push("original_request");
  }
  return issues;
}

export function assertCanonicalMutationRequestSchema(canonicalRequest = null) {
  const issues = collectCanonicalMutationRequestSchemaIssues(canonicalRequest);
  if (issues.length > 0) {
    throw new TypeError(`invalid_mutation_admission_request:${issues.join(",")}`);
  }
  return cloneCanonicalMutationRequest(canonicalRequest);
}

export function buildCreateDocCanonicalRequest({
  pathname = "/api/doc/create",
  method = "POST",
  folderToken = "",
  actor = {},
  context = {},
  originalRequest = null,
} = {}) {
  const writePolicy = buildCreateDocWritePolicy({
    scopeKey: context.scopeKey ?? context.scope_key,
    folderToken,
    idempotencyKey: context.idempotencyKey ?? context.idempotency_key,
  });
  return buildCanonicalMutationRequest({
    actionType: "create_doc",
    resourceType: "doc_container",
    resourceId: folderToken,
    actor: {
      source: actor.source || writePolicy.source,
      owner: actor.owner || writePolicy.owner,
      accountId: actor.accountId ?? actor.account_id ?? null,
    },
    context: {
      pathname,
      method,
      scopeKey: context.scopeKey ?? context.scope_key ?? writePolicy.scope_key,
      idempotencyKey: context.idempotencyKey ?? context.idempotency_key ?? writePolicy.idempotency_key,
      externalWrite: context.externalWrite ?? context.external_write ?? writePolicy.external_write,
      confirmed: context.confirmed,
      verifierCompleted: context.verifierCompleted ?? context.verifier_completed,
      reviewRequiredActive: context.reviewRequiredActive ?? context.review_required_active,
    },
    originalRequest,
  });
}

export function buildUpdateDocCanonicalRequest({
  pathname = "/api/doc/update",
  method = "POST",
  documentId = "",
  actor = {},
  context = {},
  originalRequest = null,
} = {}) {
  const writePolicy = buildUpdateDocWritePolicy({
    scopeKey: context.scopeKey ?? context.scope_key,
    documentId,
    actionType: context.actionType ?? context.action_type ?? "update",
    confirmRequired: (context.confirmRequired ?? context.confirm_required) === true,
    idempotencyKey: context.idempotencyKey ?? context.idempotency_key,
  });
  return buildCanonicalMutationRequest({
    actionType: "update_doc",
    resourceType: "doc",
    resourceId: documentId,
    actor: {
      source: actor.source || writePolicy.source,
      owner: actor.owner || writePolicy.owner,
      accountId: actor.accountId ?? actor.account_id ?? null,
    },
    context: {
      pathname,
      method,
      scopeKey: context.scopeKey ?? context.scope_key ?? writePolicy.scope_key,
      idempotencyKey: context.idempotencyKey ?? context.idempotency_key ?? writePolicy.idempotency_key,
      externalWrite: context.externalWrite ?? context.external_write ?? writePolicy.external_write,
      confirmed: context.confirmed,
      verifierCompleted: context.verifierCompleted ?? context.verifier_completed,
      reviewRequiredActive: context.reviewRequiredActive ?? context.review_required_active,
    },
    originalRequest,
  });
}

export function buildMeetingConfirmWriteCanonicalRequest({
  pathname = "/api/meeting/confirm",
  method = "POST",
  confirmationId = "",
  targetDocumentId = "",
  actor = {},
  context = {},
  originalRequest = null,
} = {}) {
  const writePolicy = buildMeetingConfirmWritePolicy({
    confirmationId,
    targetDocumentId,
    idempotencyKey: context.idempotencyKey ?? context.idempotency_key,
  });
  return buildCanonicalMutationRequest({
    actionType: "meeting_confirm_write",
    resourceType: "doc",
    resourceId: targetDocumentId,
    actor: {
      source: actor.source || writePolicy.source,
      owner: actor.owner || writePolicy.owner,
      accountId: actor.accountId ?? actor.account_id ?? null,
    },
    context: {
      pathname,
      method,
      scopeKey: context.scopeKey ?? context.scope_key ?? writePolicy.scope_key,
      idempotencyKey: context.idempotencyKey ?? context.idempotency_key ?? writePolicy.idempotency_key,
      externalWrite: context.externalWrite ?? context.external_write ?? writePolicy.external_write,
      confirmed: context.confirmed,
      verifierCompleted: context.verifierCompleted ?? context.verifier_completed,
      reviewRequiredActive: context.reviewRequiredActive ?? context.review_required_active,
    },
    originalRequest,
  });
}

export function buildDocumentCommentRewriteApplyCanonicalRequest({
  pathname = "/api/doc/rewrite-from-comments",
  method = "POST",
  documentId = "",
  actor = {},
  context = {},
  originalRequest = null,
} = {}) {
  const writePolicy = buildDocumentCommentRewriteApplyWritePolicy({
    documentId,
    idempotencyKey: context.idempotencyKey ?? context.idempotency_key,
  });
  return buildCanonicalMutationRequest({
    actionType: "rewrite_apply",
    resourceType: "doc",
    resourceId: documentId,
    actor: {
      source: actor.source || writePolicy.source,
      owner: actor.owner || writePolicy.owner,
      accountId: actor.accountId ?? actor.account_id ?? null,
    },
    context: {
      pathname,
      method,
      scopeKey: context.scopeKey ?? context.scope_key ?? writePolicy.scope_key,
      idempotencyKey: context.idempotencyKey ?? context.idempotency_key ?? writePolicy.idempotency_key,
      externalWrite: context.externalWrite ?? context.external_write ?? writePolicy.external_write,
      confirmed: context.confirmed,
      verifierCompleted: context.verifierCompleted ?? context.verifier_completed,
      reviewRequiredActive: context.reviewRequiredActive ?? context.review_required_active,
    },
    originalRequest,
  });
}

export function buildDriveOrganizeApplyCanonicalRequest({
  pathname = "/api/drive/organize/apply",
  method = "POST",
  folderToken = "",
  actor = {},
  context = {},
  originalRequest = null,
} = {}) {
  const writePolicy = buildDriveOrganizeApplyWritePolicy({
    scopeKey: context.scopeKey ?? context.scope_key,
    folderToken,
    idempotencyKey: context.idempotencyKey ?? context.idempotency_key,
  });
  return buildCanonicalMutationRequest({
    actionType: "organize_apply",
    resourceType: "drive_folder",
    resourceId: folderToken,
    actor: {
      source: actor.source || writePolicy.source,
      owner: actor.owner || writePolicy.owner,
      accountId: actor.accountId ?? actor.account_id ?? null,
    },
    context: {
      pathname,
      method,
      scopeKey: context.scopeKey ?? context.scope_key ?? writePolicy.scope_key,
      idempotencyKey: context.idempotencyKey ?? context.idempotency_key ?? writePolicy.idempotency_key,
      externalWrite: context.externalWrite ?? context.external_write ?? writePolicy.external_write,
      confirmed: context.confirmed,
      verifierCompleted: context.verifierCompleted ?? context.verifier_completed,
      reviewRequiredActive: context.reviewRequiredActive ?? context.review_required_active,
    },
    originalRequest,
  });
}

export function buildWikiOrganizeApplyCanonicalRequest({
  pathname = "/api/wiki/organize/apply",
  method = "POST",
  resourceId = "",
  actor = {},
  context = {},
  originalRequest = null,
} = {}) {
  const writePolicy = buildWikiOrganizeApplyWritePolicy({
    scopeKey: context.scopeKey ?? context.scope_key,
    spaceId: resourceId,
    idempotencyKey: context.idempotencyKey ?? context.idempotency_key,
  });
  return buildCanonicalMutationRequest({
    actionType: "organize_apply",
    resourceType: "wiki_space",
    resourceId,
    actor: {
      source: actor.source || writePolicy.source,
      owner: actor.owner || writePolicy.owner,
      accountId: actor.accountId ?? actor.account_id ?? null,
    },
    context: {
      pathname,
      method,
      scopeKey: context.scopeKey ?? context.scope_key ?? writePolicy.scope_key,
      idempotencyKey: context.idempotencyKey ?? context.idempotency_key ?? writePolicy.idempotency_key,
      externalWrite: context.externalWrite ?? context.external_write ?? writePolicy.external_write,
      confirmed: context.confirmed,
      verifierCompleted: context.verifierCompleted ?? context.verifier_completed,
      reviewRequiredActive: context.reviewRequiredActive ?? context.review_required_active,
    },
    originalRequest,
  });
}

export function buildCompanyBrainApplyCanonicalRequest({
  pathname = "/agent/company-brain/docs/:doc_id/apply",
  method = "POST",
  docId = "",
  actor = {},
  context = {},
  originalRequest = null,
} = {}) {
  const writePolicy = buildCompanyBrainApplyWritePolicy({
    docId,
    idempotencyKey: context.idempotencyKey ?? context.idempotency_key,
  });
  return buildCanonicalMutationRequest({
    actionType: "company_brain_apply",
    resourceType: "company_brain_doc",
    resourceId: docId,
    actor: {
      source: actor.source || writePolicy.source,
      owner: actor.owner || writePolicy.owner,
      accountId: actor.accountId ?? actor.account_id ?? null,
    },
    context: {
      pathname,
      method,
      scopeKey: context.scopeKey ?? context.scope_key ?? writePolicy.scope_key,
      idempotencyKey: context.idempotencyKey ?? context.idempotency_key ?? writePolicy.idempotency_key,
      externalWrite: context.externalWrite ?? context.external_write ?? writePolicy.external_write,
      confirmed: context.confirmed,
      verifierCompleted: context.verifierCompleted ?? context.verifier_completed,
      reviewRequiredActive: context.reviewRequiredActive ?? context.review_required_active,
    },
    originalRequest,
  });
}

export function buildCompanyBrainReviewCanonicalRequest({
  pathname = "/agent/company-brain/review",
  method = "POST",
  docId = "",
  actor = {},
  context = {},
  originalRequest = null,
} = {}) {
  const writePolicy = buildCompanyBrainReviewWritePolicy({
    docId,
    idempotencyKey: context.idempotencyKey ?? context.idempotency_key,
  });
  return buildCanonicalMutationRequest({
    actionType: "review_company_brain_doc",
    resourceType: "company_brain_doc",
    resourceId: docId,
    actor: {
      source: actor.source || writePolicy.source,
      owner: actor.owner || writePolicy.owner,
      accountId: actor.accountId ?? actor.account_id ?? null,
    },
    context: {
      pathname,
      method,
      scopeKey: context.scopeKey ?? context.scope_key ?? writePolicy.scope_key,
      idempotencyKey: context.idempotencyKey ?? context.idempotency_key ?? writePolicy.idempotency_key,
      externalWrite: context.externalWrite ?? context.external_write ?? writePolicy.external_write,
      confirmed: context.confirmed,
      verifierCompleted: context.verifierCompleted ?? context.verifier_completed,
      reviewRequiredActive: context.reviewRequiredActive ?? context.review_required_active,
    },
    originalRequest,
  });
}

export function buildCompanyBrainApprovalTransitionCanonicalRequest({
  pathname = "/agent/company-brain/approval-transition",
  method = "POST",
  docId = "",
  actor = {},
  context = {},
  originalRequest = null,
} = {}) {
  const writePolicy = buildCompanyBrainApprovalTransitionWritePolicy({
    docId,
    idempotencyKey: context.idempotencyKey ?? context.idempotency_key,
  });
  return buildCanonicalMutationRequest({
    actionType: "approval_transition_company_brain_doc",
    resourceType: "company_brain_doc",
    resourceId: docId,
    actor: {
      source: actor.source || writePolicy.source,
      owner: actor.owner || writePolicy.owner,
      accountId: actor.accountId ?? actor.account_id ?? null,
    },
    context: {
      pathname,
      method,
      scopeKey: context.scopeKey ?? context.scope_key ?? writePolicy.scope_key,
      idempotencyKey: context.idempotencyKey ?? context.idempotency_key ?? writePolicy.idempotency_key,
      externalWrite: context.externalWrite ?? context.external_write ?? writePolicy.external_write,
      confirmed: context.confirmed,
      verifierCompleted: context.verifierCompleted ?? context.verifier_completed,
      reviewRequiredActive: context.reviewRequiredActive ?? context.review_required_active,
    },
    originalRequest,
  });
}

export function buildIngestLearningDocCanonicalRequest({
  pathname = "/agent/company-brain/learning/ingest",
  method = "POST",
  docId = "",
  actor = {},
  context = {},
  originalRequest = null,
} = {}) {
  const writePolicy = buildCompanyBrainLearningIngestWritePolicy({
    docId,
    idempotencyKey: context.idempotencyKey ?? context.idempotency_key,
  });
  return buildCanonicalMutationRequest({
    actionType: "ingest_learning_doc",
    resourceType: "company_brain_doc",
    resourceId: docId,
    actor: {
      source: actor.source || writePolicy.source,
      owner: actor.owner || writePolicy.owner,
      accountId: actor.accountId ?? actor.account_id ?? null,
    },
    context: {
      pathname,
      method,
      scopeKey: context.scopeKey ?? context.scope_key ?? writePolicy.scope_key,
      idempotencyKey: context.idempotencyKey ?? context.idempotency_key ?? writePolicy.idempotency_key,
      externalWrite: context.externalWrite ?? context.external_write ?? writePolicy.external_write,
      confirmed: context.confirmed,
      verifierCompleted: context.verifierCompleted ?? context.verifier_completed,
      reviewRequiredActive: context.reviewRequiredActive ?? context.review_required_active,
    },
    originalRequest,
  });
}

export function listMutationAdmissionReadyRoutes() {
  return MUTATION_ADMISSION_READY_ROUTE_FIXTURES.map((entry) => ({
    ...entry,
  }));
}

export function callMutationAdmissionWriteGuard({
  canonicalRequest,
  policySnapshot = null,
  logger = null,
  traceId = null,
} = {}) {
  const request = assertCanonicalMutationRequestSchema(canonicalRequest);
  const resolvedPolicySnapshot = cloneWritePolicyRecord(policySnapshot) || buildPolicySnapshotFromCanonicalRequest(request);
  const guardResult = decideWriteGuard({
    externalWrite: request.context.external_write,
    confirmed: request.context.confirmed,
    verifierCompleted: request.context.verifier_completed,
    pathname: request.context.pathname,
    writePolicy: resolvedPolicySnapshot,
    reviewRequirementActive: request.context.review_required_active,
    scopeKey: request.context.scope_key,
    idempotencyKey: request.context.idempotency_key,
    logger,
    owner: request.actor.owner || "",
    workflow: "mutation_admission_adapter",
    operation: request.action_type || "",
    traceId,
  });
  return sanitizeGuardResult(guardResult);
}

export function admitMutation({
  canonicalRequest,
  logger = null,
  traceId = null,
} = {}) {
  const request = assertCanonicalMutationRequestSchema(canonicalRequest);
  const resolvedTraceId = normalizeNullableText(traceId) || buildTraceId(request);
  const policySnapshot = buildPolicySnapshotFromCanonicalRequest(request);
  const guardResult = callMutationAdmissionWriteGuard({
    canonicalRequest: request,
    policySnapshot,
    logger,
    traceId: resolvedTraceId,
  });

  return Object.freeze({
    allowed: guardResult.decision === "allow",
    reason: guardResult.reason,
    policy_snapshot: policySnapshot,
    guard_result: guardResult,
    evidence: Object.freeze({
      evidence_id: buildEvidenceId({
        canonicalRequest: request,
        traceId: resolvedTraceId,
      }),
    }),
    trace: Object.freeze({
      trace_id: resolvedTraceId,
    }),
  });
}

export function collectMutationAdmissionOutputSchemaIssues(output = null) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return ["mutation_admission_output_missing"];
  }

  const issues = [];
  if (typeof output.allowed !== "boolean") {
    issues.push("allowed");
  }
  if (!Object.prototype.hasOwnProperty.call(output, "reason")) {
    issues.push("reason");
  }
  if (cloneWritePolicyRecord(output.policy_snapshot) == null) {
    issues.push("policy_snapshot");
  }
  if (!output.guard_result || typeof output.guard_result !== "object" || Array.isArray(output.guard_result)) {
    issues.push("guard_result");
  } else {
    if (cleanText(output.guard_result.decision) !== "allow" && cleanText(output.guard_result.decision) !== "deny") {
      issues.push("guard_result.decision");
    }
    if (!Object.prototype.hasOwnProperty.call(output.guard_result, "reason")) {
      issues.push("guard_result.reason");
    }
    if (!Object.prototype.hasOwnProperty.call(output.guard_result, "error_code")) {
      issues.push("guard_result.error_code");
    }
    if (!Object.prototype.hasOwnProperty.call(output.guard_result, "policy_enforcement")) {
      issues.push("guard_result.policy_enforcement");
    }
  }
  if (!output.evidence || typeof output.evidence !== "object" || Array.isArray(output.evidence)) {
    issues.push("evidence");
  } else if (!normalizeNullableText(output.evidence.evidence_id)) {
    issues.push("evidence.evidence_id");
  }
  if (!output.trace || typeof output.trace !== "object" || Array.isArray(output.trace)) {
    issues.push("trace");
  } else if (!normalizeNullableText(output.trace.trace_id)) {
    issues.push("trace.trace_id");
  }
  return issues;
}

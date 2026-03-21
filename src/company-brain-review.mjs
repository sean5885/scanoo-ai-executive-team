import { resolveCompanyBrainWriteIntake } from "./company-brain-write-intake.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import {
  getCompanyBrainApprovedKnowledge,
  getCompanyBrainDoc,
  getCompanyBrainReviewState,
  upsertCompanyBrainApprovedKnowledge,
  upsertCompanyBrainReviewState,
} from "./rag-repository.mjs";

export const COMPANY_BRAIN_REVIEW_STATUSES = Object.freeze([
  "pending_review",
  "conflict_detected",
  "approved",
  "rejected",
]);

const REVIEW_STATUS_SET = new Set(COMPANY_BRAIN_REVIEW_STATUSES);

function buildUnifiedResult(success, data, error = null) {
  return {
    success,
    data: data && typeof data === "object" && !Array.isArray(data) ? data : {},
    error: cleanText(error) || null,
  };
}

function normalizeReviewStatus(status = "") {
  const normalized = cleanText(status).toLowerCase();
  return REVIEW_STATUS_SET.has(normalized) ? normalized : null;
}

function parseConflictItems(row = {}) {
  try {
    const parsed = row?.conflict_items_json ? JSON.parse(row.conflict_items_json) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseCompanyBrainReviewState(row = {}) {
  const reviewStatus = normalizeReviewStatus(row?.review_status);
  if (!reviewStatus) {
    return null;
  }

  return {
    status: reviewStatus,
    source_stage: cleanText(row?.source_stage) || null,
    proposed_action: cleanText(row?.proposed_action) || null,
    conflict_items: parseConflictItems(row),
    review_notes: cleanText(row?.review_notes) || "",
    decided_by: cleanText(row?.decided_by) || null,
    decided_at: cleanText(row?.decided_at) || null,
    updated_at: cleanText(row?.updated_at) || null,
  };
}

export function parseCompanyBrainApprovedKnowledge(row = {}) {
  if (!cleanText(row?.approved_at)) {
    return null;
  }

  return {
    status: "approved",
    source_stage: cleanText(row?.source_stage) || null,
    approved_by: cleanText(row?.approved_by) || null,
    approved_at: cleanText(row?.approved_at) || null,
    updated_at: cleanText(row?.updated_at) || null,
  };
}

export function deriveCompanyBrainReviewStatus(intakeBoundary = {}) {
  const explicitStatus = normalizeReviewStatus(intakeBoundary?.review_status);
  if (explicitStatus) {
    return explicitStatus;
  }
  if (intakeBoundary?.review_required !== true) {
    return null;
  }
  return Array.isArray(intakeBoundary?.matched_docs) && intakeBoundary.matched_docs.length > 0
    ? "conflict_detected"
    : "pending_review";
}

export function stageCompanyBrainReviewState({
  accountId = "",
  docId = "",
  sourceStage = "mirror",
  proposedAction = "ingest_doc",
  reviewStatus = "pending_review",
  conflictItems = [],
  reviewNotes = "",
} = {}) {
  const normalizedAccountId = cleanText(accountId);
  const normalizedDocId = cleanText(docId);
  const normalizedReviewStatus = normalizeReviewStatus(reviewStatus);
  if (!normalizedAccountId) {
    return buildUnifiedResult(false, {}, "missing_account_id");
  }
  if (!normalizedDocId) {
    return buildUnifiedResult(false, {}, "missing_doc_id");
  }
  if (!normalizedReviewStatus) {
    return buildUnifiedResult(false, {}, "invalid_review_status");
  }

  const doc = getCompanyBrainDoc(normalizedAccountId, normalizedDocId);
  if (!doc) {
    return buildUnifiedResult(false, {}, "not_found");
  }

  const stored = upsertCompanyBrainReviewState({
    account_id: normalizedAccountId,
    doc_id: normalizedDocId,
    review_status: normalizedReviewStatus,
    source_stage: cleanText(sourceStage) || "mirror",
    proposed_action: cleanText(proposedAction) || "ingest_doc",
    conflict_items: Array.isArray(conflictItems) ? conflictItems : [],
    review_notes: reviewNotes,
  });

  return buildUnifiedResult(true, {
    doc_id: normalizedDocId,
    review_state: parseCompanyBrainReviewState(stored),
  });
}

export function stageCompanyBrainReviewFromIntake({
  accountId = "",
  action = "ingest_doc",
  targetStage = "mirror",
  candidate = {},
  limit = 6,
  searchDocs,
} = {}) {
  const intakeBoundary = resolveCompanyBrainWriteIntake({
    accountId,
    action,
    targetStage,
    candidate,
    limit,
    searchDocs,
  });

  if (intakeBoundary.ok !== true) {
    return buildUnifiedResult(false, {
      intake_boundary: intakeBoundary,
    }, "invalid_candidate");
  }

  const reviewStatus = deriveCompanyBrainReviewStatus(intakeBoundary);
  if (!reviewStatus) {
    return buildUnifiedResult(true, {
      doc_id: intakeBoundary.doc_id,
      intake_boundary: intakeBoundary,
      review_state: null,
    });
  }

  const staged = stageCompanyBrainReviewState({
    accountId,
    docId: intakeBoundary.doc_id,
    sourceStage: intakeBoundary.target_stage,
    proposedAction: intakeBoundary.action,
    reviewStatus,
    conflictItems: intakeBoundary.matched_docs,
    reviewNotes: reviewStatus === "conflict_detected"
      ? "conflict evidence detected during company-brain intake"
      : "",
  });

  if (staged.success !== true) {
    return buildUnifiedResult(false, {
      intake_boundary: intakeBoundary,
    }, staged.error || "review_state_write_failed");
  }

  return buildUnifiedResult(true, {
    doc_id: intakeBoundary.doc_id,
    intake_boundary: intakeBoundary,
    review_state: staged.data.review_state,
  });
}

export function resolveCompanyBrainReviewDecision({
  accountId = "",
  docId = "",
  approved = false,
  notes = "",
  actor = "unknown",
} = {}) {
  const normalizedAccountId = cleanText(accountId);
  const normalizedDocId = cleanText(docId);
  if (!normalizedAccountId) {
    return buildUnifiedResult(false, {}, "missing_account_id");
  }
  if (!normalizedDocId) {
    return buildUnifiedResult(false, {}, "missing_doc_id");
  }

  const doc = getCompanyBrainDoc(normalizedAccountId, normalizedDocId);
  if (!doc) {
    return buildUnifiedResult(false, {}, "not_found");
  }

  const existing = getCompanyBrainReviewState(normalizedAccountId, normalizedDocId);
  const stored = upsertCompanyBrainReviewState({
    account_id: normalizedAccountId,
    doc_id: normalizedDocId,
    review_status: approved ? "approved" : "rejected",
    source_stage: cleanText(existing?.source_stage) || "mirror",
    proposed_action: cleanText(existing?.proposed_action) || "review_doc",
    conflict_items: parseConflictItems(existing),
    review_notes: notes,
    decided_by: cleanText(actor) || "unknown",
    decided_at: new Date().toISOString(),
  });

  return buildUnifiedResult(true, {
    doc_id: normalizedDocId,
    review_state: parseCompanyBrainReviewState(stored),
  });
}

export function promoteApprovedCompanyBrainKnowledge({
  accountId = "",
  docId = "",
  actor = "unknown",
  sourceStage = "mirror",
} = {}) {
  const normalizedAccountId = cleanText(accountId);
  const normalizedDocId = cleanText(docId);
  if (!normalizedAccountId) {
    return buildUnifiedResult(false, {}, "missing_account_id");
  }
  if (!normalizedDocId) {
    return buildUnifiedResult(false, {}, "missing_doc_id");
  }

  const doc = getCompanyBrainDoc(normalizedAccountId, normalizedDocId);
  if (!doc) {
    return buildUnifiedResult(false, {}, "not_found");
  }

  const reviewState = parseCompanyBrainReviewState(getCompanyBrainReviewState(normalizedAccountId, normalizedDocId) || {});
  if (reviewState?.status !== "approved") {
    return buildUnifiedResult(false, {
      doc_id: normalizedDocId,
      review_state: reviewState,
    }, "approval_required");
  }

  const stored = upsertCompanyBrainApprovedKnowledge({
    account_id: normalizedAccountId,
    doc_id: normalizedDocId,
    source_stage: cleanText(sourceStage) || reviewState.source_stage || "mirror",
    approved_by: cleanText(actor) || "unknown",
    approved_at: new Date().toISOString(),
  });

  return buildUnifiedResult(true, {
    doc_id: normalizedDocId,
    review_state: reviewState,
    approval: parseCompanyBrainApprovedKnowledge(stored),
  });
}

export function getCompanyBrainApprovalState({
  accountId = "",
  docId = "",
} = {}) {
  const normalizedAccountId = cleanText(accountId);
  const normalizedDocId = cleanText(docId);
  if (!normalizedAccountId || !normalizedDocId) {
    return null;
  }

  return {
    review_state: parseCompanyBrainReviewState(getCompanyBrainReviewState(normalizedAccountId, normalizedDocId) || {}),
    approval: parseCompanyBrainApprovedKnowledge(getCompanyBrainApprovedKnowledge(normalizedAccountId, normalizedDocId) || {}),
  };
}

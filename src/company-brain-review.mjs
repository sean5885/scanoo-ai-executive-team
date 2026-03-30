import { resolveCompanyBrainWriteIntake } from "./company-brain-write-intake.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import {
  upsertCompanyBrainApprovedKnowledge,
  upsertCompanyBrainReviewState,
} from "./rag-repository.mjs";
import {
  getCompanyBrainApprovalStateFromRuntimeSync,
  getCompanyBrainDocRecordFromRuntimeSync,
} from "./read-runtime.mjs";

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

  const doc = getCompanyBrainDocRecordFromRuntimeSync({
    accountId: normalizedAccountId,
    docId: normalizedDocId,
  });
  if (!doc?.doc?.doc_id) {
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

  const doc = getCompanyBrainDocRecordFromRuntimeSync({
    accountId: normalizedAccountId,
    docId: normalizedDocId,
  });
  if (!doc?.doc?.doc_id) {
    return buildUnifiedResult(false, {}, "not_found");
  }

  const existing = getCompanyBrainApprovalStateFromRuntimeSync({
    accountId: normalizedAccountId,
    docId: normalizedDocId,
  })?.review_state;
  const stored = upsertCompanyBrainReviewState({
    account_id: normalizedAccountId,
    doc_id: normalizedDocId,
    review_status: approved ? "approved" : "rejected",
    source_stage: cleanText(existing?.source_stage) || "mirror",
    proposed_action: cleanText(existing?.proposed_action) || "review_doc",
    conflict_items: Array.isArray(existing?.conflict_items) ? existing.conflict_items : [],
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

  const doc = getCompanyBrainDocRecordFromRuntimeSync({
    accountId: normalizedAccountId,
    docId: normalizedDocId,
  });
  if (!doc?.doc?.doc_id) {
    return buildUnifiedResult(false, {}, "not_found");
  }

  const reviewState = getCompanyBrainApprovalStateFromRuntimeSync({
    accountId: normalizedAccountId,
    docId: normalizedDocId,
  })?.review_state || null;
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

function buildApprovalStateEnvelope(accountId = "", docId = "") {
  return getCompanyBrainApprovalState({ accountId, docId }) || {
    review_state: null,
    approval: null,
  };
}

export function reviewCompanyBrainDocAction({
  accountId = "",
  docId = "",
  title = "",
  action = "ingest_doc",
  targetStage = "approved_knowledge",
  limit = 6,
  overlapSignal = false,
  replacesExisting = false,
} = {}) {
  const normalizedAccountId = cleanText(accountId);
  const normalizedDocId = cleanText(docId);
  if (!normalizedAccountId) {
    return buildUnifiedResult(false, {}, "missing_account_id");
  }
  if (!normalizedDocId) {
    return buildUnifiedResult(false, {}, "missing_doc_id");
  }

  const staged = stageCompanyBrainReviewFromIntake({
    accountId: normalizedAccountId,
    action,
    targetStage,
    limit,
    candidate: {
      doc_id: normalizedDocId,
      title: cleanText(title) || null,
      overlap_signal: overlapSignal === true,
      replaces_existing: replacesExisting === true,
    },
  });

  if (staged.success !== true) {
    return buildUnifiedResult(false, {
      doc_id: normalizedDocId,
      intake_boundary: staged?.data?.intake_boundary || null,
      approval_state: buildApprovalStateEnvelope(normalizedAccountId, normalizedDocId),
    }, staged.error || "review_stage_failed");
  }

  return buildUnifiedResult(true, {
    doc_id: normalizedDocId,
    intake_boundary: staged.data.intake_boundary,
    review_state: staged.data.review_state,
    approval_state: buildApprovalStateEnvelope(normalizedAccountId, normalizedDocId),
  });
}

export function checkCompanyBrainConflictAction({
  accountId = "",
  docId = "",
  title = "",
  action = "ingest_doc",
  targetStage = "approved_knowledge",
  limit = 6,
  overlapSignal = false,
  replacesExisting = false,
} = {}) {
  const normalizedAccountId = cleanText(accountId);
  const normalizedDocId = cleanText(docId);
  if (!normalizedAccountId) {
    return buildUnifiedResult(false, {}, "missing_account_id");
  }
  if (!normalizedDocId) {
    return buildUnifiedResult(false, {}, "missing_doc_id");
  }

  const doc = getCompanyBrainDocRecordFromRuntimeSync({
    accountId: normalizedAccountId,
    docId: normalizedDocId,
  });
  if (!doc?.doc?.doc_id) {
    return buildUnifiedResult(false, {}, "not_found");
  }

  const effectiveTitle = cleanText(title) || cleanText(doc.title || doc.doc?.title) || null;
  const intakeBoundary = resolveCompanyBrainWriteIntake({
    accountId: normalizedAccountId,
    action,
    targetStage,
    limit,
    candidate: {
      doc_id: normalizedDocId,
      title: effectiveTitle,
      overlap_signal: overlapSignal === true,
      replaces_existing: replacesExisting === true,
    },
  });

  if (intakeBoundary.ok !== true) {
    return buildUnifiedResult(false, {
      doc_id: normalizedDocId,
      approval_state: buildApprovalStateEnvelope(normalizedAccountId, normalizedDocId),
    }, "invalid_candidate");
  }

  const conflictItems = Array.isArray(intakeBoundary.matched_docs) ? intakeBoundary.matched_docs : [];
  const explicitConflict = overlapSignal === true || replacesExisting === true;
  const hasExactOverlap = conflictItems.some((item) => cleanText(item?.match_type) === "same_title");
  const conflictState = intakeBoundary.conflict_check_required !== true
    ? "none"
    : explicitConflict || hasExactOverlap
      ? "confirmed"
      : conflictItems.length > 0
        ? "possible"
        : "none";

  const existingApprovalState = buildApprovalStateEnvelope(normalizedAccountId, normalizedDocId);
  let reviewState = existingApprovalState.review_state;
  if (
    conflictState !== "none"
    && reviewState?.status !== "approved"
    && reviewState?.status !== "rejected"
  ) {
    const staged = stageCompanyBrainReviewState({
      accountId: normalizedAccountId,
      docId: normalizedDocId,
      sourceStage: intakeBoundary.target_stage,
      proposedAction: intakeBoundary.action,
      reviewStatus: "conflict_detected",
      conflictItems,
      reviewNotes: "explicit conflict_check detected overlap before company-brain admission",
    });
    if (staged.success !== true) {
      return buildUnifiedResult(false, {
        doc_id: normalizedDocId,
        title: effectiveTitle,
        conflict_state: conflictState,
        conflict_items: conflictItems,
        intake_boundary: intakeBoundary,
        review_state: reviewState,
        approval_state: buildApprovalStateEnvelope(normalizedAccountId, normalizedDocId),
      }, staged.error || "review_state_write_failed");
    }
    reviewState = staged.data.review_state;
  }

  return buildUnifiedResult(true, {
    doc_id: normalizedDocId,
    title: effectiveTitle,
    conflict_state: conflictState,
    conflict_items: conflictItems,
    intake_boundary: intakeBoundary,
    review_state: reviewState,
    approval_state: buildApprovalStateEnvelope(normalizedAccountId, normalizedDocId),
  });
}

export function approvalTransitionCompanyBrainDocAction({
  accountId = "",
  docId = "",
  decision = "",
  notes = "",
  actor = "unknown",
} = {}) {
  const normalizedAccountId = cleanText(accountId);
  const normalizedDocId = cleanText(docId);
  const normalizedDecision = cleanText(decision).toLowerCase();
  if (!normalizedAccountId) {
    return buildUnifiedResult(false, {}, "missing_account_id");
  }
  if (!normalizedDocId) {
    return buildUnifiedResult(false, {}, "missing_doc_id");
  }
  if (normalizedDecision !== "approve" && normalizedDecision !== "reject") {
    return buildUnifiedResult(false, {}, "invalid_decision");
  }

  const resolved = resolveCompanyBrainReviewDecision({
    accountId: normalizedAccountId,
    docId: normalizedDocId,
    approved: normalizedDecision === "approve",
    notes,
    actor,
  });

  if (resolved.success !== true) {
    return buildUnifiedResult(false, {
      doc_id: normalizedDocId,
      approval_state: buildApprovalStateEnvelope(normalizedAccountId, normalizedDocId),
    }, resolved.error || "approval_transition_failed");
  }

  return buildUnifiedResult(true, {
    doc_id: normalizedDocId,
    decision: normalizedDecision,
    review_state: resolved.data.review_state,
    approval_state: buildApprovalStateEnvelope(normalizedAccountId, normalizedDocId),
  });
}

export function applyApprovedCompanyBrainKnowledgeAction({
  accountId = "",
  docId = "",
  actor = "unknown",
  sourceStage = "approved_knowledge",
} = {}) {
  const normalizedAccountId = cleanText(accountId);
  const normalizedDocId = cleanText(docId);
  if (!normalizedAccountId) {
    return buildUnifiedResult(false, {}, "missing_account_id");
  }
  if (!normalizedDocId) {
    return buildUnifiedResult(false, {}, "missing_doc_id");
  }

  const promoted = promoteApprovedCompanyBrainKnowledge({
    accountId: normalizedAccountId,
    docId: normalizedDocId,
    actor,
    sourceStage,
  });

  if (promoted.success !== true) {
    return buildUnifiedResult(false, {
      doc_id: normalizedDocId,
      review_state: promoted?.data?.review_state || null,
      approval_state: buildApprovalStateEnvelope(normalizedAccountId, normalizedDocId),
    }, promoted.error || "approval_apply_failed");
  }

  return buildUnifiedResult(true, {
    doc_id: normalizedDocId,
    review_state: promoted.data.review_state,
    approval: promoted.data.approval,
    approval_state: buildApprovalStateEnvelope(normalizedAccountId, normalizedDocId),
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

  const runtimeState = getCompanyBrainApprovalStateFromRuntimeSync({
    accountId: normalizedAccountId,
    docId: normalizedDocId,
  });
  if (!runtimeState) {
    return {
      review_state: null,
      approval: null,
    };
  }

  return {
    review_state: runtimeState.review_state || null,
    approval: runtimeState.approval || null,
  };
}

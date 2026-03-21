import { searchCompanyBrainDocs } from "./rag-repository.mjs";

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeTargetStage(targetStage = "") {
  const normalized = normalizeText(targetStage).toLowerCase();
  if (normalized === "approved" || normalized === "approved_knowledge" || normalized === "formal") {
    return "approved_knowledge";
  }
  return "mirror";
}

function parseCreator(row = {}) {
  try {
    const parsed = row?.creator_json ? JSON.parse(row.creator_json) : null;
    if (parsed && typeof parsed === "object") {
      return {
        account_id: normalizeText(parsed.account_id) || null,
        open_id: normalizeText(parsed.open_id) || null,
      };
    }
  } catch {
    // Ignore malformed historical creator_json rows and fall back to nulls.
  }

  return {
    account_id: null,
    open_id: null,
  };
}

function buildMatchedDoc(row = {}, matchType = "search_match") {
  return {
    doc_id: normalizeText(row?.doc_id) || null,
    title: normalizeText(row?.title) || null,
    source: normalizeText(row?.source) || null,
    created_at: row?.created_at || null,
    creator: parseCreator(row),
    match_type: matchType,
  };
}

export function collectCompanyBrainConflictCandidates({
  accountId = "",
  docId = "",
  title = "",
  limit = 6,
  searchDocs = searchCompanyBrainDocs,
} = {}) {
  const normalizedAccountId = normalizeText(accountId);
  const normalizedDocId = normalizeText(docId);
  const normalizedTitle = normalizeText(title);
  if (!normalizedAccountId) {
    return [];
  }

  const maxItems = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 20)) : 6;
  const seen = new Set();
  const items = [];

  if (normalizedTitle) {
    const searched = searchDocs(normalizedAccountId, normalizedTitle, maxItems + 4);
    const titleMatches = Array.isArray(searched) ? searched : [];
    for (const row of titleMatches) {
      const rowDocId = normalizeText(row?.doc_id);
      if (!rowDocId || rowDocId === normalizedDocId || seen.has(rowDocId)) {
        continue;
      }
      seen.add(rowDocId);
      const exactTitle = normalizeText(row?.title).toLowerCase() === normalizedTitle.toLowerCase();
      items.push(buildMatchedDoc(row, exactTitle ? "same_title" : "search_match"));
      if (items.length >= maxItems) {
        break;
      }
    }
  }

  return items;
}

export function resolveCompanyBrainWriteIntake({
  accountId = "",
  action = "ingest_doc",
  targetStage = "mirror",
  candidate = {},
  limit = 6,
  searchDocs = searchCompanyBrainDocs,
} = {}) {
  const docId = normalizeText(candidate?.doc_id || candidate?.document_id);
  const title = normalizeText(candidate?.title);
  const normalizedAction = normalizeText(action || "ingest_doc") || "ingest_doc";
  const normalizedTargetStage = normalizeTargetStage(targetStage);
  const matchedDocs = collectCompanyBrainConflictCandidates({
    accountId,
    docId,
    title,
    limit,
    searchDocs,
  });

  const promotionRequested = normalizedTargetStage === "approved_knowledge";
  const overlapDetected =
    matchedDocs.length > 0 ||
    candidate?.overlap_signal === true ||
    candidate?.replaces_existing === true;
  const updateLikeAction = normalizedAction === "update_doc";
  const reviewRequired = updateLikeAction || overlapDetected || promotionRequested;
  const conflictCheckRequired = overlapDetected || (updateLikeAction && promotionRequested);
  const directIntakeAllowed = !reviewRequired && normalizedTargetStage === "mirror";
  const reviewStatus = !reviewRequired
    ? null
    : overlapDetected
      ? "conflict_detected"
      : "pending_review";

  const rationale = [];
  if (directIntakeAllowed) {
    rationale.push("verified mirror candidate has no overlap signal, so direct mirror intake is allowed");
  }
  if (updateLikeAction) {
    rationale.push("update_doc remains review-gated by default before any stable company-brain promotion");
  }
  if (overlapDetected) {
    rationale.push("existing company-brain matches require conflict_check before stable promotion");
  }
  if (promotionRequested) {
    rationale.push("formal company-brain admission remains approval-gated after review/conflict handling");
  }

  return {
    ok: Boolean(accountId && docId),
    doc_id: docId || null,
    title: title || null,
    action: normalizedAction,
    target_stage: normalizedTargetStage,
    intake_state: directIntakeAllowed ? "mirrored" : "pending_review",
    review_status: reviewStatus,
    direct_intake_allowed: directIntakeAllowed,
    review_required: reviewRequired,
    conflict_check_required: conflictCheckRequired,
    approval_required_for_formal_source: promotionRequested,
    formal_source_state: promotionRequested ? "approval_required" : "mirror_only",
    matched_docs: matchedDocs,
    rationale,
  };
}

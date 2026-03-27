import {
  getApprovedCompanyBrainKnowledgeDetailAction,
  listApprovedCompanyBrainKnowledgeAction,
  searchApprovedCompanyBrainKnowledgeAction,
} from "./company-brain-query.mjs";
import {
  buildStructuredSummary,
  parseLearningStateRow,
} from "./company-brain-learning-core.mjs";
import {
  getCompanyBrainApprovedKnowledge,
  getCompanyBrainDocQueryRecord,
  getCompanyBrainReviewState,
  listCompanyBrainDocQueryRecords,
} from "./rag-repository.mjs";
import { cleanText } from "./message-intent-utils.mjs";

function buildUnifiedResult(success, data, error = null) {
  return {
    success,
    data: data && typeof data === "object" && !Array.isArray(data) ? data : {},
    error: cleanText(error) || null,
  };
}

function normalizeCreator(row = {}) {
  let parsed = null;
  try {
    parsed = row?.creator_json ? JSON.parse(row.creator_json) : null;
  } catch {
    parsed = null;
  }

  return {
    account_id: cleanText(parsed?.account_id) || null,
    open_id: cleanText(parsed?.open_id) || null,
  };
}

function buildDerivedDocMeta(row = {}) {
  return {
    doc_id: cleanText(row?.doc_id) || null,
    title: cleanText(row?.title) || null,
    source: cleanText(row?.source) || null,
    created_at: cleanText(row?.created_at) || null,
    creator: normalizeCreator(row),
    url: cleanText(row?.url) || null,
  };
}

function buildDerivedState(stage = "") {
  return {
    stage: cleanText(stage) || "derived",
  };
}

function buildLearningStateItem(row = {}) {
  return {
    ...buildDerivedDocMeta(row),
    learning_state: parseLearningStateRow(row),
    summary: buildStructuredSummary({
      rawText: row?.raw_text,
      title: row?.title,
    }),
    derived_state: buildDerivedState("learning_state"),
  };
}

export function listApprovedCompanyBrainKnowledgeDerivedAction(args = {}) {
  return listApprovedCompanyBrainKnowledgeAction(args);
}

export function searchApprovedCompanyBrainKnowledgeDerivedAction(args = {}) {
  return searchApprovedCompanyBrainKnowledgeAction(args);
}

export function getApprovedCompanyBrainKnowledgeDetailDerivedAction(args = {}) {
  return getApprovedCompanyBrainKnowledgeDetailAction(args);
}

export function listCompanyBrainLearningStateAction({
  accountId = "",
  limit = 20,
} = {}) {
  const normalizedAccountId = cleanText(accountId);
  if (!normalizedAccountId) {
    return buildUnifiedResult(false, {}, "missing_account_id");
  }

  const cappedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 20;
  const items = listCompanyBrainDocQueryRecords(normalizedAccountId)
    .filter((row) => cleanText(row?.learning_status))
    .slice(0, cappedLimit)
    .map(buildLearningStateItem);

  return buildUnifiedResult(true, {
    total: items.length,
    items,
  });
}

export function getCompanyBrainLearningStateDetailAction({
  accountId = "",
  docId = "",
} = {}) {
  const normalizedAccountId = cleanText(accountId);
  const normalizedDocId = cleanText(docId);
  if (!normalizedAccountId) {
    return buildUnifiedResult(false, {}, "missing_account_id");
  }
  if (!normalizedDocId) {
    return buildUnifiedResult(false, {}, "missing_doc_id");
  }

  const row = getCompanyBrainDocQueryRecord(normalizedAccountId, normalizedDocId);
  if (!row) {
    return buildUnifiedResult(false, {}, "not_found");
  }
  if (!cleanText(row?.learning_status)) {
    return buildUnifiedResult(false, {}, "not_found");
  }

  return buildUnifiedResult(true, {
    doc: buildDerivedDocMeta(row),
    learning_state: parseLearningStateRow(row),
    summary: buildStructuredSummary({
      rawText: row?.raw_text,
      title: row?.title,
    }),
    derived_state: buildDerivedState("learning_state"),
  });
}

export function getCompanyBrainApprovalStateAction({
  accountId = "",
  docId = "",
} = {}) {
  const normalizedAccountId = cleanText(accountId);
  const normalizedDocId = cleanText(docId);
  if (!normalizedAccountId) {
    return buildUnifiedResult(false, {}, "missing_account_id");
  }
  if (!normalizedDocId) {
    return buildUnifiedResult(false, {}, "missing_doc_id");
  }

  const reviewState = getCompanyBrainReviewState(normalizedAccountId, normalizedDocId);
  const approval = getCompanyBrainApprovedKnowledge(normalizedAccountId, normalizedDocId);

  return buildUnifiedResult(true, {
    review_state: reviewState
      ? {
          status: cleanText(reviewState.review_status) || null,
          source_stage: cleanText(reviewState.source_stage) || null,
          proposed_action: cleanText(reviewState.proposed_action) || null,
          conflict_items: (() => {
            try {
              const parsed = reviewState.conflict_items_json
                ? JSON.parse(reviewState.conflict_items_json)
                : [];
              return Array.isArray(parsed) ? parsed : [];
            } catch {
              return [];
            }
          })(),
          review_notes: cleanText(reviewState.review_notes) || "",
          decided_by: cleanText(reviewState.decided_by) || null,
          decided_at: cleanText(reviewState.decided_at) || null,
          updated_at: cleanText(reviewState.updated_at) || null,
        }
      : null,
    approval: approval?.approved_at
      ? {
          status: "approved",
          source_stage: cleanText(approval.source_stage) || null,
          approved_by: cleanText(approval.approved_by) || null,
          approved_at: cleanText(approval.approved_at) || null,
          updated_at: cleanText(approval.updated_at) || null,
        }
      : null,
    derived_state: buildDerivedState("approval_state"),
  });
}

import { cleanText } from "./message-intent-utils.mjs";
import {
  upsertCompanyBrainLearningState,
} from "./rag-repository.mjs";
import {
  buildEmptyLearningState,
  buildEmptyStructuredSummary,
  buildLearningDerivatives,
  buildLearningSearchText,
  buildStructuredSummary,
  normalizeLearningState,
  parseLearningStateRow,
} from "./company-brain-learning-core.mjs";
import {
  getCompanyBrainDocRecordFromRuntimeSync,
  getCompanyBrainLearningStateFromRuntimeSync,
} from "./read-runtime.mjs";
import { guardedMemorySet } from "./memory-write-guard.mjs";

export {
  buildEmptyLearningState,
  buildEmptyStructuredSummary,
  buildLearningDerivatives,
  buildLearningSearchText,
  buildStructuredSummary,
  normalizeLearningState,
  parseLearningStateRow,
} from "./company-brain-learning-core.mjs";

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

function buildDocMeta(row = {}) {
  return {
    doc_id: cleanText(row?.doc_id) || null,
    title: cleanText(row?.title) || null,
    source: cleanText(row?.source) || null,
    created_at: cleanText(row?.created_at) || null,
    creator: normalizeCreator(row),
  };
}

function buildUnifiedResult(success, data, error = null) {
  return {
    success,
    data: data && typeof data === "object" && !Array.isArray(data) ? data : {},
    error: cleanText(error) || null,
  };
}

export function ingestLearningDocAction({
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

  const runtimeDoc = getCompanyBrainDocRecordFromRuntimeSync({
    accountId: normalizedAccountId,
    docId: normalizedDocId,
  });
  if (!runtimeDoc) {
    return buildUnifiedResult(false, {}, "not_found");
  }
  const derivatives = buildLearningDerivatives({
    title: runtimeDoc.title,
    rawText: runtimeDoc.raw_text,
  });
  const existing = getCompanyBrainLearningStateFromRuntimeSync({
    accountId: normalizedAccountId,
    docId: normalizedDocId,
  })?.learning_state || buildEmptyLearningState();
  const learnedAt = existing.learned_at || new Date().toISOString();
  const stored = upsertCompanyBrainLearningState({
    account_id: normalizedAccountId,
    doc_id: normalizedDocId,
    learning_status: "learned",
    structured_summary: derivatives.structured_summary,
    key_concepts: derivatives.key_concepts,
    tags: derivatives.tags,
    notes: existing.notes,
    learned_at: learnedAt,
  });
  const nextLearningState = parseLearningStateRow(stored);
  guardedMemorySet({
    key: `company_brain_learning:${normalizedAccountId}:${normalizedDocId}`,
    value: nextLearningState,
    source: "company-brain-learning",
  });

  return buildUnifiedResult(true, {
    doc: buildDocMeta(runtimeDoc.doc),
    learning_state: nextLearningState,
  });
}

export function updateLearningStateAction({
  accountId = "",
  docId = "",
  status = "",
  notes = "",
  tags = null,
  key_concepts = null,
} = {}) {
  const normalizedAccountId = cleanText(accountId);
  const normalizedDocId = cleanText(docId);
  if (!normalizedAccountId) {
    return buildUnifiedResult(false, {}, "missing_account_id");
  }
  if (!normalizedDocId) {
    return buildUnifiedResult(false, {}, "missing_doc_id");
  }

  const runtimeDoc = getCompanyBrainDocRecordFromRuntimeSync({
    accountId: normalizedAccountId,
    docId: normalizedDocId,
  });
  if (!runtimeDoc) {
    return buildUnifiedResult(false, {}, "not_found");
  }
  const fallback = buildLearningDerivatives({
    title: runtimeDoc.title,
    rawText: runtimeDoc.raw_text,
  });
  const existing = getCompanyBrainLearningStateFromRuntimeSync({
    accountId: normalizedAccountId,
    docId: normalizedDocId,
  })?.learning_state || buildEmptyLearningState();
  const nextStatus = cleanText(status) || existing.status || "learned";
  const nextState = normalizeLearningState({
    status: nextStatus,
    structured_summary: existing.status === "not_learned"
      ? fallback.structured_summary
      : existing.structured_summary,
    key_concepts: Array.isArray(key_concepts) ? key_concepts : (
      existing.status === "not_learned"
        ? fallback.key_concepts
        : existing.key_concepts
    ),
    tags: Array.isArray(tags) ? tags : (
      existing.status === "not_learned"
        ? fallback.tags
        : existing.tags
    ),
    notes: notes === null || notes === undefined ? existing.notes : notes,
    learned_at: existing.learned_at || (nextStatus === "not_learned" ? null : new Date().toISOString()),
  });

  const stored = upsertCompanyBrainLearningState({
    account_id: normalizedAccountId,
    doc_id: normalizedDocId,
    learning_status: nextState.status,
    structured_summary: nextState.structured_summary,
    key_concepts: nextState.key_concepts,
    tags: nextState.tags,
    notes: nextState.notes,
    learned_at: nextState.learned_at,
  });
  const persistedLearningState = parseLearningStateRow(stored);
  guardedMemorySet({
    key: `company_brain_learning:${normalizedAccountId}:${normalizedDocId}`,
    value: persistedLearningState,
    source: "company-brain-learning",
  });

  return buildUnifiedResult(true, {
    doc: buildDocMeta(runtimeDoc.doc),
    learning_state: persistedLearningState,
  });
}

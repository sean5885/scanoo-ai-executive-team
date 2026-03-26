import { buildCloudDocStructuredResult } from "./cloud-doc-organization-workflow.mjs";
import { evaluateCompanyBrainApplyGate } from "./company-brain-lifecycle-contract.mjs";
import { EVIDENCE_TYPES, verifyTaskCompletion } from "./executive-verifier.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import {
  getCompanyBrainApprovedKnowledge,
  getCompanyBrainDoc,
  getCompanyBrainLearningState,
  getCompanyBrainReviewState,
} from "./rag-repository.mjs";

export const MUTATION_VERIFIER_PROFILES = Object.freeze([
  "cloud_doc_v1",
  "knowledge_write_v1",
]);

function normalizeProfile(profile = "") {
  const normalized = cleanText(profile);
  return MUTATION_VERIFIER_PROFILES.includes(normalized) ? normalized : null;
}

function normalizeObject(value = null) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeEvidence(items = []) {
  return Array.isArray(items)
    ? items.filter((item) => item && typeof item === "object" && !Array.isArray(item))
    : [];
}

function buildVerifierResult({
  phase = "pre",
  profile = "",
  pass = false,
  skipped = false,
  reason = "",
  issues = [],
  verification = null,
  message = "",
} = {}) {
  return {
    phase,
    profile,
    pass: pass === true,
    skipped: skipped === true,
    reason: cleanText(reason) || null,
    issues: Array.isArray(issues) ? [...issues] : [],
    verification: verification && typeof verification === "object" ? { ...verification } : null,
    message: cleanText(message) || null,
  };
}

function verifyCloudDocPre({
  canonicalRequest = null,
  verifierInput = null,
} = {}) {
  const input = normalizeObject(verifierInput);
  const issues = [];
  const scopeKey = cleanText(input.scope_key) || cleanText(canonicalRequest?.context?.scope_key);
  const previewPlan = normalizeObject(input.preview_plan);
  const hasPreviewPlan =
    Array.isArray(previewPlan.target_folders)
    && Array.isArray(previewPlan.moves);

  if (!scopeKey) {
    issues.push("missing_scope_key");
  }
  if (!hasPreviewPlan) {
    issues.push("missing_preview_plan");
  }

  return buildVerifierResult({
    phase: "pre",
    profile: "cloud_doc_v1",
    pass: issues.length === 0,
    reason: issues[0] || "allowed",
    issues,
    message: hasPreviewPlan
      ? ""
      : "Cloud-doc apply requires preview_plan evidence before execution.",
  });
}

function verifyCloudDocPost({
  canonicalRequest = null,
  verifierInput = null,
  executeResult = null,
} = {}) {
  const input = normalizeObject(verifierInput);
  const execution = normalizeObject(executeResult);
  if (execution.ok !== true) {
    return buildVerifierResult({
      phase: "post",
      profile: "cloud_doc_v1",
      pass: true,
      skipped: true,
      reason: "write_not_completed",
    });
  }

  const scopeKey = cleanText(input.scope_key) || cleanText(canonicalRequest?.context?.scope_key);
  const scopeType = cleanText(input.scope_type) || "cloud_doc";
  const previewPlan = normalizeObject(input.preview_plan);
  const structuredResult = buildCloudDocStructuredResult({
    scopeKey,
    scopeType,
    preview: previewPlan,
    apply: execution.result,
    mode: "apply",
  });
  const verification = verifyTaskCompletion({
    taskType: "cloud_doc",
    structuredResult,
    evidence: normalizeEvidence(input.evidence),
  });

  return buildVerifierResult({
    phase: "post",
    profile: "cloud_doc_v1",
    pass: verification.pass === true,
    reason: verification.pass === true ? "allowed" : (verification.issues[0] || "verifier_failed"),
    issues: verification.issues,
    verification,
    message: verification.pass === true
      ? ""
      : "Cloud-doc apply is blocked until preview/evidence verification is complete.",
  });
}

function deriveKnowledgeWriteExpectation({
  canonicalRequest = null,
  verifierInput = null,
} = {}) {
  const input = normalizeObject(verifierInput);
  const explicitExpectation = cleanText(input.expected_write);
  if (explicitExpectation) {
    return explicitExpectation;
  }

  const actionType = cleanText(canonicalRequest?.action_type);
  if (actionType === "review_company_brain_doc" || actionType === "approval_transition_company_brain_doc") {
    return "review_state";
  }
  if (actionType === "company_brain_apply") {
    return "approved_knowledge";
  }
  if (actionType === "ingest_doc") {
    return "mirror_doc";
  }
  if (actionType === "ingest_learning_doc") {
    return "learning_state";
  }
  return "";
}

function verifyKnowledgeWritePre({
  canonicalRequest = null,
  verifierInput = null,
} = {}) {
  const input = normalizeObject(verifierInput);
  const issues = [];
  const accountId = cleanText(input.account_id) || cleanText(canonicalRequest?.actor?.account_id);
  const docId = cleanText(input.doc_id) || cleanText(canonicalRequest?.resource_id);
  const expectedWrite = deriveKnowledgeWriteExpectation({
    canonicalRequest,
    verifierInput: input,
  });

  if (!accountId) {
    issues.push("missing_account_id");
  }
  if (!docId) {
    issues.push("missing_doc_id");
  }
  if (!expectedWrite) {
    issues.push("missing_expected_write");
  }
  if (!issues.length && cleanText(canonicalRequest?.action_type) === "company_brain_apply") {
    const reviewState = getCompanyBrainReviewState(accountId, docId);
    const approvedKnowledge = getCompanyBrainApprovedKnowledge(accountId, docId);
    const applyGate = evaluateCompanyBrainApplyGate({
      approvalState: {
        review_state: reviewState
          ? {
              status: cleanText(reviewState.review_status) || null,
            }
          : null,
        approval: approvedKnowledge?.approved_at
          ? {
              status: "approved",
            }
          : null,
      },
    });
    if (applyGate.can_apply !== true) {
      issues.push(cleanText(applyGate.blocked_reason) || "approval_required");
    }
  }

  return buildVerifierResult({
    phase: "pre",
    profile: "knowledge_write_v1",
    pass: issues.length === 0,
    reason: issues[0] || "allowed",
    issues,
    message: issues.length > 0
      ? (
          cleanText(canonicalRequest?.action_type) === "company_brain_apply"
            ? "Company-brain apply is blocked until review/approval state satisfies the apply gate."
            : "Knowledge write requires account/doc identity and an expected write target before execution."
        )
      : "",
  });
}

function verifyKnowledgeWritePost({
  canonicalRequest = null,
  verifierInput = null,
  executeResult = null,
} = {}) {
  const input = normalizeObject(verifierInput);
  const execution = normalizeObject(executeResult);
  if (execution.success !== true) {
    return buildVerifierResult({
      phase: "post",
      profile: "knowledge_write_v1",
      pass: true,
      skipped: true,
      reason: "write_not_completed",
    });
  }

  const accountId = cleanText(input.account_id) || cleanText(canonicalRequest?.actor?.account_id);
  const docId = cleanText(input.doc_id) || cleanText(canonicalRequest?.resource_id);
  const expectedWrite = deriveKnowledgeWriteExpectation({
    canonicalRequest,
    verifierInput: input,
  });
  const issues = [];
  let evidence = [];

  if (expectedWrite === "review_state") {
    const reviewState = getCompanyBrainReviewState(accountId, docId);
    const expectedStatus = cleanText(execution?.data?.review_state?.status || input.expected_status);
    const actualStatus = cleanText(reviewState?.review_status);
    if (!reviewState) {
      issues.push("db_write_missing");
    } else if (expectedStatus && actualStatus !== expectedStatus) {
      issues.push("db_write_mismatch");
    } else {
      evidence.push({
        type: EVIDENCE_TYPES.DB_write_confirmed,
        summary: `company_brain_review_state:${docId}`,
      });
    }
  } else if (expectedWrite === "approved_knowledge") {
    const approvedKnowledge = getCompanyBrainApprovedKnowledge(accountId, docId);
    if (!approvedKnowledge?.approved_at) {
      issues.push("db_write_missing");
    } else {
      evidence.push({
        type: EVIDENCE_TYPES.DB_write_confirmed,
        summary: `company_brain_approved_knowledge:${docId}`,
      });
    }
  } else if (expectedWrite === "mirror_doc") {
    const mirroredDoc = getCompanyBrainDoc(accountId, docId);
    if (!mirroredDoc?.doc_id) {
      issues.push("db_write_missing");
    } else {
      evidence.push({
        type: EVIDENCE_TYPES.DB_write_confirmed,
        summary: `company_brain_docs:${docId}`,
      });
    }
  } else if (expectedWrite === "learning_state") {
    const learningState = getCompanyBrainLearningState(accountId, docId);
    if (!cleanText(learningState?.learning_status) || cleanText(learningState?.learning_status) === "not_learned") {
      issues.push("db_write_missing");
    } else {
      evidence.push({
        type: EVIDENCE_TYPES.DB_write_confirmed,
        summary: `company_brain_learning_state:${docId}`,
      });
    }
  } else {
    issues.push("unsupported_expected_write");
  }

  const verification = verifyTaskCompletion({
    taskType: "knowledge_write",
    structuredResult: {
      doc_id: docId,
      write_target: expectedWrite,
    },
    evidence,
  });
  const mergedIssues = [
    ...issues,
    ...verification.issues,
  ].filter(Boolean);

  return buildVerifierResult({
    phase: "post",
    profile: "knowledge_write_v1",
    pass: issues.length === 0 && verification.pass === true,
    reason: issues[0] || (verification.pass === true ? "allowed" : (verification.issues[0] || "verifier_failed")),
    issues: mergedIssues,
    verification,
    message: issues.length === 0 && verification.pass === true
      ? ""
      : "Knowledge write is blocked until durable write evidence is confirmed.",
  });
}

export function runMutationVerification({
  phase = "pre",
  profile = "",
  canonicalRequest = null,
  verifierInput = null,
  executeResult = null,
} = {}) {
  const normalizedProfile = normalizeProfile(profile);
  if (!normalizedProfile) {
    return null;
  }

  if (normalizedProfile === "cloud_doc_v1" && phase === "pre") {
    return verifyCloudDocPre({
      canonicalRequest,
      verifierInput,
    });
  }
  if (normalizedProfile === "cloud_doc_v1" && phase === "post") {
    return verifyCloudDocPost({
      canonicalRequest,
      verifierInput,
      executeResult,
    });
  }
  if (normalizedProfile === "knowledge_write_v1" && phase === "pre") {
    return verifyKnowledgeWritePre({
      canonicalRequest,
      verifierInput,
    });
  }
  if (normalizedProfile === "knowledge_write_v1" && phase === "post") {
    return verifyKnowledgeWritePost({
      canonicalRequest,
      verifierInput,
      executeResult,
    });
  }

  return null;
}

export {
  EVIDENCE_TYPES,
};

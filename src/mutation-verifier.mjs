import { buildCloudDocStructuredResult } from "./cloud-doc-organization-workflow.mjs";
import { EVIDENCE_TYPES, verifyTaskCompletion } from "./executive-verifier.mjs";
import { cleanText } from "./message-intent-utils.mjs";

export const MUTATION_VERIFIER_PROFILES = Object.freeze([
  "cloud_doc_v1",
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

  return null;
}

export {
  EVIDENCE_TYPES,
};

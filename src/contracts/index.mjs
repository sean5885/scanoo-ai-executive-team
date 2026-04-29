import { cleanText } from "../message-intent-utils.mjs";

export const CAPABILITY_CONTRACTS_VERSION = "capability-contracts-skeleton-v1";

export const CAPABILITY_CONTRACT_REGISTRY = Object.freeze({
  decision: Object.freeze({
    capability: "decision",
    goal: "Select a stable next action from normalized planner input.",
    required_evidence: ["structured_output"],
    failure_taxonomy: ["contract_violation", "runtime_exception"],
  }),
  dispatch: Object.freeze({
    capability: "dispatch",
    goal: "Execute a selected action through the checked-in tool bridge.",
    required_evidence: ["tool_output"],
    failure_taxonomy: ["tool_error", "runtime_exception", "business_error"],
  }),
  recovery: Object.freeze({
    capability: "recovery",
    goal: "Resolve retry/rollback/blocked/escalated transitions after execution failures.",
    required_evidence: ["structured_output"],
    failure_taxonomy: ["runtime_exception", "permission_denied", "not_found"],
  }),
  formatter: Object.freeze({
    capability: "formatter",
    goal: "Render stable user-facing output contracts without leaking machine envelopes.",
    required_evidence: ["structured_output", "summary_generated"],
    failure_taxonomy: ["contract_violation", "runtime_exception"],
  }),
});

export const FAILURE_TAXONOMY = Object.freeze([
  "contract_violation",
  "tool_error",
  "runtime_exception",
  "business_error",
  "not_found",
  "permission_denied",
]);

export const EVIDENCE_SCHEMA_REGISTRY = Object.freeze({
  tool_output: Object.freeze({
    required_fields: ["type", "summary"],
  }),
  structured_output: Object.freeze({
    required_fields: ["type", "summary"],
  }),
  summary_generated: Object.freeze({
    required_fields: ["type", "summary"],
  }),
});

export function isKnownFailureCode(errorCode = "") {
  return FAILURE_TAXONOMY.includes(cleanText(errorCode || ""));
}

export function getEvidenceSchema(evidenceType = "") {
  return EVIDENCE_SCHEMA_REGISTRY[cleanText(evidenceType || "")] || null;
}

export function getCapabilityRequiredEvidence(capability = "") {
  const contract = getCapabilityContract(capability);
  return Array.isArray(contract?.required_evidence) ? contract.required_evidence : [];
}

export function validateCapabilityRequiredEvidence({
  capability = "",
  observedEvidenceTypes = [],
} = {}) {
  const requiredEvidence = getCapabilityRequiredEvidence(capability);
  if (!requiredEvidence.length) {
    return {
      pass: true,
      required_evidence: [],
      missing_required_evidence: [],
    };
  }
  const observed = new Set(
    (Array.isArray(observedEvidenceTypes) ? observedEvidenceTypes : [])
      .map((item) => cleanText(item || ""))
      .filter(Boolean),
  );
  const missing = requiredEvidence.filter((type) => !observed.has(type));
  return {
    pass: missing.length === 0,
    required_evidence: requiredEvidence,
    missing_required_evidence: missing,
  };
}

export function getCapabilityContract(capability = "") {
  const key = cleanText(String(capability || "").toLowerCase());
  return CAPABILITY_CONTRACT_REGISTRY[key] || null;
}

export function listCapabilityContracts() {
  return Object.values(CAPABILITY_CONTRACT_REGISTRY);
}

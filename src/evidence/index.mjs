import { cleanText } from "../message-intent-utils.mjs";
import {
  getEvidenceSchema,
  validateCapabilityRequiredEvidence,
} from "../contracts/index.mjs";

export const EVIDENCE_PLANE_VERSION = "evidence-plane-skeleton-v1";

function normalizeEvidenceItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const type = cleanText(item.type || "");
      const summary = cleanText(item.summary || "");
      if (!type || !summary) {
        return null;
      }
      return {
        ...item,
        type,
        summary,
      };
    })
    .filter(Boolean);
}

function validateEvidenceSchema(items = []) {
  const normalizedItems = Array.isArray(items) ? items : [];
  const invalid = [];
  for (const item of normalizedItems) {
    const schema = getEvidenceSchema(item?.type);
    if (!schema) {
      invalid.push({
        type: cleanText(item?.type || ""),
        reason: "unknown_evidence_type",
      });
      continue;
    }
    const requiredFields = Array.isArray(schema.required_fields) ? schema.required_fields : [];
    const missingFields = requiredFields.filter((field) => !cleanText(item?.[field] || ""));
    if (missingFields.length > 0) {
      invalid.push({
        type: cleanText(item?.type || ""),
        reason: "missing_required_fields",
        missing_fields: missingFields,
      });
    }
  }
  return {
    pass: invalid.length === 0,
    invalid,
  };
}

export function createEvidencePlaneFacade({
  verifier = null,
} = {}) {
  return {
    version: EVIDENCE_PLANE_VERSION,
    collectEvidence(items = []) {
      return normalizeEvidenceItems(items);
    },
    verify(payload = {}) {
      const evidenceItems = normalizeEvidenceItems(payload?.evidence || []);
      const evidenceTypes = evidenceItems.map((item) => item.type);
      const schemaValidation = validateEvidenceSchema(evidenceItems);
      const requiredEvidenceValidation = validateCapabilityRequiredEvidence({
        capability: cleanText(payload?.capability || ""),
        observedEvidenceTypes: evidenceTypes,
      });
      if (!schemaValidation.pass || !requiredEvidenceValidation.pass) {
        return {
          pass: false,
          reason: "evidence_validation_failed",
          required_evidence_present: requiredEvidenceValidation.pass,
          required_evidence: requiredEvidenceValidation.required_evidence,
          missing_required_evidence: requiredEvidenceValidation.missing_required_evidence,
          evidence_schema_valid: schemaValidation.pass,
          evidence_schema_violations: schemaValidation.invalid,
        };
      }
      if (typeof verifier === "function") {
        return verifier({
          ...payload,
          evidence: evidenceItems,
          evidence_types: evidenceTypes,
        });
      }
      return {
        pass: null,
        reason: "evidence_plane_verifier_not_configured",
        required_evidence_present: true,
      };
    },
  };
}

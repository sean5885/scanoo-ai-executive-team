import { cleanText } from "../message-intent-utils.mjs";

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

export function createEvidencePlaneFacade({
  verifier = null,
} = {}) {
  return {
    version: EVIDENCE_PLANE_VERSION,
    collectEvidence(items = []) {
      return normalizeEvidenceItems(items);
    },
    verify(payload = {}) {
      if (typeof verifier === "function") {
        return verifier(payload);
      }
      return {
        pass: null,
        reason: "evidence_plane_verifier_not_configured",
      };
    },
  };
}

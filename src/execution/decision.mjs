import { cleanText } from "../message-intent-utils.mjs";
import { FAILURE_TAXONOMY, getCapabilityContract } from "../contracts/index.mjs";

function normalizeErrorCode(value = "") {
  const normalized = cleanText(value);
  return FAILURE_TAXONOMY.includes(normalized) ? normalized : "runtime_exception";
}

export function createDecisionCapability({
  selector = null,
} = {}) {
  const contract = getCapabilityContract("decision");
  return {
    contract,
    select(input = {}) {
      if (typeof selector !== "function") {
        return {
          selected_action: "",
          reason: "execution_plane_selector_not_configured",
          routing_reason: "execution_plane_selector_not_configured",
          error: "runtime_exception",
        };
      }
      try {
        return selector(input);
      } catch (error) {
        return {
          selected_action: "",
          reason: cleanText(error?.message || "") || "decision_selector_runtime_exception",
          routing_reason: "decision_selector_runtime_exception",
          error: normalizeErrorCode(error?.code || ""),
        };
      }
    },
  };
}

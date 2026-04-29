import { cleanText } from "../message-intent-utils.mjs";
import { FAILURE_TAXONOMY, getCapabilityContract } from "../contracts/index.mjs";

function normalizeErrorCode(value = "") {
  const normalized = cleanText(value);
  return FAILURE_TAXONOMY.includes(normalized) ? normalized : "runtime_exception";
}

export function createRecoveryCapability({
  resolver = null,
} = {}) {
  const contract = getCapabilityContract("recovery");
  return {
    contract,
    resolve(input = {}) {
      if (typeof resolver !== "function") {
        return {
          next_state: "blocked",
          next_status: "blocked",
          reason: "execution_plane_recovery_not_configured",
          error: "runtime_exception",
        };
      }
      try {
        return resolver(input);
      } catch (error) {
        return {
          next_state: "blocked",
          next_status: "blocked",
          reason: cleanText(error?.message || "") || "execution_plane_recovery_runtime_exception",
          error: normalizeErrorCode(error?.code || ""),
        };
      }
    },
  };
}

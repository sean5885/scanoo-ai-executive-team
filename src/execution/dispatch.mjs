import { cleanText } from "../message-intent-utils.mjs";
import { FAILURE_TAXONOMY, getCapabilityContract } from "../contracts/index.mjs";

function normalizeErrorCode(value = "") {
  const normalized = cleanText(value);
  return FAILURE_TAXONOMY.includes(normalized) ? normalized : "runtime_exception";
}

export function createDispatchCapability({
  dispatcher = null,
} = {}) {
  const contract = getCapabilityContract("dispatch");
  return {
    contract,
    run(input = {}) {
      if (typeof dispatcher !== "function") {
        return {
          ok: false,
          error: "runtime_exception",
          reason: "execution_plane_dispatcher_not_configured",
        };
      }
      try {
        return dispatcher(input);
      } catch (error) {
        return {
          ok: false,
          error: normalizeErrorCode(error?.code || ""),
          reason: cleanText(error?.message || "") || "execution_plane_dispatch_runtime_exception",
        };
      }
    },
  };
}

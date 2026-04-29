import { cleanText } from "../message-intent-utils.mjs";
import { FAILURE_TAXONOMY, getCapabilityContract } from "../contracts/index.mjs";

function normalizeErrorCode(value = "") {
  const normalized = cleanText(value);
  return FAILURE_TAXONOMY.includes(normalized) ? normalized : "runtime_exception";
}

export function createFormatterCapability({
  renderer = null,
} = {}) {
  const contract = getCapabilityContract("formatter");
  return {
    contract,
    render(input = {}) {
      if (typeof renderer !== "function") {
        return input;
      }
      try {
        return renderer(input);
      } catch (error) {
        return {
          ok: false,
          error: normalizeErrorCode(error?.code || ""),
          reason: cleanText(error?.message || "") || "execution_plane_formatter_runtime_exception",
        };
      }
    },
  };
}

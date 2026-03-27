import { cleanText } from "./message-intent-utils.mjs";
import { writeMemory } from "./company-brain-memory-authority.mjs";

export function guardedMemorySet({ key, value, source } = {}) {
  const normalizedKey = cleanText(key);
  if (!normalizedKey) {
    return { ok: false, error: "missing_key" };
  }

  return writeMemory({
    key: normalizedKey,
    value,
    source: cleanText(source) || "unknown",
  });
}

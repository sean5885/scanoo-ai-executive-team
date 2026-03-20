import { runtimeMessageDedupWindowMs } from "./config.mjs";

export function createMessageEventDeduper({ windowMs = runtimeMessageDedupWindowMs } = {}) {
  const seen = new Map();

  function sweep(now) {
    for (const [messageId, expiresAt] of seen.entries()) {
      if (expiresAt <= now) {
        seen.delete(messageId);
      }
    }
  }

  return {
    shouldProcess(messageId, now = Date.now()) {
      const normalized = String(messageId || "").trim();
      if (!normalized) {
        return true;
      }

      sweep(now);
      const existingExpiry = seen.get(normalized);
      if (existingExpiry && existingExpiry > now) {
        return false;
      }

      seen.set(normalized, now + windowMs);
      return true;
    },
  };
}

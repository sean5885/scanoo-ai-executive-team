import { cleanText } from "../message-intent-utils.mjs";

function normalizeSideEffects(items = []) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => ({
      mode: cleanText(item?.mode) || null,
      action: cleanText(item?.action) || null,
      runtime: cleanText(item?.runtime) || null,
      authority: cleanText(item?.authority) || null,
    }))
    .filter((item) => item.mode || item.action || item.runtime || item.authority);
}

export function emitSkillReflection(payload = {}) {
  try {
    const appendReflectionLog = globalThis.appendReflectionLog;
    if (typeof appendReflectionLog !== "function") {
      return false;
    }

    appendReflectionLog({
      type: "skill_bridge_failure",
      skill: cleanText(payload?.skill) || null,
      action: cleanText(payload?.action) || null,
      error: cleanText(payload?.error) || null,
      failure_mode: cleanText(payload?.failure_mode) || null,
      phase: cleanText(payload?.phase) || null,
      intent_unfulfilled: payload?.intent_unfulfilled === true,
      criteria_failed: cleanText(payload?.criteria_failed) || null,
      side_effects: normalizeSideEffects(payload?.side_effects),
      trace_id: cleanText(payload?.trace_id) || null,
      ts: Date.now(),
    });
    return true;
  } catch {
    return false;
  }
}

import { cleanText } from "./message-intent-utils.mjs";

export const TASK_LIFECYCLE_STATES = Object.freeze([
  "created",
  "clarified",
  "planned",
  "executing",
  "awaiting_result",
  "verifying",
  "completed",
  "failed",
  "blocked",
  "escalated",
  "reflected",
  "improvement_proposed",
  "improved",
]);

export const TERMINAL_TASK_STATES = Object.freeze(["completed", "failed", "escalated", "improved"]);

const ALLOWED_TRANSITIONS = Object.freeze({
  created: ["clarified", "planned", "blocked"],
  clarified: ["planned", "blocked"],
  planned: ["executing", "blocked"],
  executing: ["awaiting_result", "blocked", "failed"],
  awaiting_result: ["verifying", "blocked", "failed"],
  verifying: ["completed", "executing", "blocked", "escalated"],
  completed: ["reflected"],
  failed: ["reflected", "executing"],
  blocked: ["executing", "escalated", "failed"],
  escalated: ["reflected"],
  reflected: ["improvement_proposed", "improved"],
  improvement_proposed: ["improved", "executing"],
  improved: [],
});

export function getAllowedTaskTransitions(state = "") {
  const normalized = cleanText(state) || "created";
  return ALLOWED_TRANSITIONS[normalized] || [];
}

export function canTransitionTaskState(from = "", to = "") {
  const current = cleanText(from) || "created";
  const next = cleanText(to);
  return Boolean(next) && getAllowedTaskTransitions(current).includes(next);
}

export function buildLifecycleTransition({ from = "", to = "", reason = "", actor = "system" } = {}) {
  const current = cleanText(from) || "created";
  const next = cleanText(to);
  if (!next) {
    return {
      ok: false,
      error: "missing_target_state",
    };
  }
  if (!canTransitionTaskState(current, next)) {
    return {
      ok: false,
      error: "invalid_transition",
      from: current,
      to: next,
      allowed: getAllowedTaskTransitions(current),
    };
  }
  return {
    ok: true,
    patch: {
      lifecycle_state: next,
      lifecycle_last_transition: {
        from: current,
        to: next,
        reason: cleanText(reason),
        actor: cleanText(actor) || "system",
        at: new Date().toISOString(),
      },
    },
  };
}

export function isTerminalTaskState(state = "") {
  return TERMINAL_TASK_STATES.includes(cleanText(state));
}

export const ROUTING_NO_MATCH = "ROUTING_NO_MATCH";
export const INVALID_ACTION = "INVALID_ACTION";
export const FALLBACK_DISABLED = "FALLBACK_DISABLED";

export function isRoutingNoMatch(value = "") {
  return value === ROUTING_NO_MATCH;
}

export function buildRoutingNoMatchError() {
  return {
    ok: false,
    error: ROUTING_NO_MATCH,
    message: "No deterministic route matched",
  };
}

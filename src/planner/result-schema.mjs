export function buildResultEnvelope(kind, payload = {}) {
  return {
    kind,
    status: payload.status || "ok",
    summary: payload.summary || "",
    actionable_items: payload.actionable_items || [],
    confidence: payload.confidence ?? 0.8,
    data: payload.data || {},
  };
}

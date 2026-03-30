import { cleanText } from "./message-intent-utils.mjs";

function normalizeEnvelopeObject(value = null) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...value };
  }
  return value ?? null;
}

export function buildExecutionEnvelope({
  ok = false,
  action = "",
  data = null,
  meta = null,
  error = null,
} = {}) {
  return {
    ok: ok === true,
    action: cleanText(action) || null,
    data: normalizeEnvelopeObject(data),
    meta: normalizeEnvelopeObject(meta),
    error: ok === true ? null : cleanText(error?.message || error?.error || error) || "runtime_exception",
  };
}

// Local process-only helper for experimental company-brain memory writes (v1)

export function writeMemory({ key, value, source } = {}) {
  if (!key) {
    return { ok: false, error: "missing_key" };
  }

  // v1 uses an in-process Map only; it is not durable storage.
  globalThis.__company_brain_memory__ =
    globalThis.__company_brain_memory__ || new Map();

  globalThis.__company_brain_memory__.set(key, {
    value,
    source: source || "unknown",
    updated_at: Date.now(),
  });

  return { ok: true };
}

export function readMemory({ key } = {}) {
  const store = globalThis.__company_brain_memory__;
  if (!store || !store.has(key)) {
    return { ok: false, error: "not_found" };
  }

  return {
    ok: true,
    data: store.get(key),
  };
}

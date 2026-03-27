// Local process-only helper for experimental company-brain memory writes (v1)

function getMemoryStore() {
  globalThis.__company_brain_memory__ =
    globalThis.__company_brain_memory__ || new Map();

  return globalThis.__company_brain_memory__;
}

export function writeMemory({ key, value, source } = {}) {
  if (!key) {
    return { ok: false, error: "missing_key" };
  }

  // v1 uses an in-process Map only; it is not durable storage.
  const store = getMemoryStore();
  store.set(key, {
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

export function listMemoryByPrefix({ prefix } = {}) {
  const store = globalThis.__company_brain_memory__;
  if (!store) {
    return { ok: true, data: [] };
  }

  const normalizedPrefix = typeof prefix === "string" ? prefix : "";
  const rows = [];

  for (const [key, value] of store.entries()) {
    if (!normalizedPrefix || key.startsWith(normalizedPrefix)) {
      rows.push({
        key,
        ...value,
      });
    }
  }

  return {
    ok: true,
    data: rows,
  };
}

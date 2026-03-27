// Dev-time guard for process-local company-brain memory writes (v1)

const MEMORY_AUTHORITY_STACK_HINT = "company-brain-memory-authority.mjs";
const ORIGINAL_MAP_SET = Map.prototype.set;

function shouldInspectMap(target) {
  return Boolean(globalThis.__company_brain_memory__) && target === globalThis.__company_brain_memory__;
}

function shouldAllowStack(stack = "") {
  return stack.includes(MEMORY_AUTHORITY_STACK_HINT);
}

export function installMemoryWriteDetector() {
  if (process.env.NODE_ENV === "production") {
    return { ok: true, installed: false, reason: "production_skip" };
  }

  if (globalThis.__memory_write_detector_installed__ === true) {
    return { ok: true, installed: true, reason: "already_installed" };
  }

  Map.prototype.set = function patchedMemorySet(key, value) {
    if (!shouldInspectMap(this)) {
      return ORIGINAL_MAP_SET.call(this, key, value);
    }

    const stack = new Error().stack || "";
    if (shouldAllowStack(stack)) {
      return ORIGINAL_MAP_SET.call(this, key, value);
    }

    console.warn("[memory-write-detector] direct company-brain memory Map.set detected", { key });
    console.warn(stack.split("\n").slice(0, 5).join("\n"));
    return ORIGINAL_MAP_SET.call(this, key, value);
  };

  globalThis.__memory_write_detector_installed__ = true;
  return { ok: true, installed: true };
}

export function uninstallMemoryWriteDetector() {
  if (globalThis.__memory_write_detector_installed__ !== true) {
    return { ok: true, installed: false, reason: "not_installed" };
  }

  Map.prototype.set = ORIGINAL_MAP_SET;
  delete globalThis.__memory_write_detector_installed__;
  return { ok: true, installed: false };
}

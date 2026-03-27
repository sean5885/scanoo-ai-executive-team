import test from "node:test";
import assert from "node:assert/strict";

import { writeMemory } from "../src/company-brain-memory-authority.mjs";
import {
  installMemoryWriteDetector,
  uninstallMemoryWriteDetector,
} from "../src/memory-write-detector.mjs";

function resetMemoryState() {
  delete globalThis.__company_brain_memory__;
}

test.beforeEach(() => {
  uninstallMemoryWriteDetector();
  resetMemoryState();
});

test.after(() => {
  uninstallMemoryWriteDetector();
  resetMemoryState();
});

test("memory write detector does not warn for authority-managed writes", () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);

  try {
    installMemoryWriteDetector();
    const result = writeMemory({
      key: "detector:test:authority",
      value: { ok: true },
      source: "test",
    });

    assert.equal(result.ok, true);
    assert.equal(warnings.length, 0);
  } finally {
    console.warn = originalWarn;
  }
});

test("memory write detector warns for direct company-brain map writes", () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);

  try {
    installMemoryWriteDetector();
    writeMemory({
      key: "detector:test:seed",
      value: { ok: true },
      source: "test",
    });
    warnings.length = 0;

    globalThis.__company_brain_memory__.set("detector:test:direct", {
      value: { ok: false },
      source: "direct-test",
    });

    assert.equal(warnings.length >= 1, true);
    assert.equal(String(warnings[0][0]).includes("direct company-brain memory Map.set detected"), true);
  } finally {
    console.warn = originalWarn;
  }
});

test("memory write detector ignores unrelated map writes", () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);

  try {
    installMemoryWriteDetector();
    const otherMap = new Map();
    otherMap.set("plain", 1);

    assert.equal(otherMap.get("plain"), 1);
    assert.equal(warnings.length, 0);
  } finally {
    console.warn = originalWarn;
  }
});

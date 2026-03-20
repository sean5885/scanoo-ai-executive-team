import test from "node:test";
import assert from "node:assert/strict";

test("runtime guard defaults include legacy lobster launch agents", async () => {
  const original = {
    LARK_APP_ID: process.env.LARK_APP_ID,
    LARK_APP_SECRET: process.env.LARK_APP_SECRET,
    RUNTIME_GUARD_COMPETING_LAUNCH_LABELS: process.env.RUNTIME_GUARD_COMPETING_LAUNCH_LABELS,
  };

  process.env.LARK_APP_ID = original.LARK_APP_ID || "test-app-id";
  process.env.LARK_APP_SECRET = original.LARK_APP_SECRET || "test-app-secret";
  delete process.env.RUNTIME_GUARD_COMPETING_LAUNCH_LABELS;

  try {
    const config = await import(`../src/config.mjs?runtime-guard-defaults=${Date.now()}`);
    assert.deepEqual(config.runtimeGuardCompetingLaunchLabels, [
      "ai.openclaw.gateway",
      "lobster.core",
      "lobster.gateway",
      "lobster.worker",
    ]);
  } finally {
    if (original.LARK_APP_ID == null) {
      delete process.env.LARK_APP_ID;
    } else {
      process.env.LARK_APP_ID = original.LARK_APP_ID;
    }
    if (original.LARK_APP_SECRET == null) {
      delete process.env.LARK_APP_SECRET;
    } else {
      process.env.LARK_APP_SECRET = original.LARK_APP_SECRET;
    }
    if (original.RUNTIME_GUARD_COMPETING_LAUNCH_LABELS == null) {
      delete process.env.RUNTIME_GUARD_COMPETING_LAUNCH_LABELS;
    } else {
      process.env.RUNTIME_GUARD_COMPETING_LAUNCH_LABELS = original.RUNTIME_GUARD_COMPETING_LAUNCH_LABELS;
    }
  }
});

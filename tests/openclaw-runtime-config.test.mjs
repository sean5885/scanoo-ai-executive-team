import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const {
  sanitizeOpenClawRuntimeConfig,
} = await import("../src/openclaw-runtime-config.mjs");

test.after(() => {
  testDb.close();
});

test("sanitizeOpenClawRuntimeConfig removes feishu-only runtime coupling and forces the configured primary agent model", () => {
  const sanitized = sanitizeOpenClawRuntimeConfig({
    channels: {
      feishu: {
        enabled: true,
      },
    },
    models: {
      providers: {
        deepseek: {
          models: [
            { id: "deepseek-v4-pro" },
          ],
        },
      },
    },
    tools: {
      alsoAllow: ["lark_kb_answer", "feishu_chat"],
    },
    plugins: {
      allow: ["lark-kb", "feishu"],
      entries: {
        feishu: { enabled: true },
        "lark-kb": { enabled: true },
      },
    },
    agents: {
      defaults: {
        model: {
          primary: "kimi/kimi-for-coding",
        },
      },
      list: [
        {
          id: "lobster-backend",
          model: "kimi/kimi-for-coding",
          tools: {
            alsoAllow: ["lark_kb_answer", "feishu_chat"],
          },
        },
      ],
    },
  });

  assert.equal("channels" in sanitized, false);
  assert.deepEqual(sanitized.plugins.allow, ["lark-kb"]);
  assert.equal("feishu" in sanitized.plugins.entries, false);
  assert.deepEqual(sanitized.tools.alsoAllow, ["lark_kb_answer"]);
  assert.equal(sanitized.agents.defaults.model.primary, "deepseek/deepseek-v4-pro");
  assert.equal(sanitized.agents.list[0].model, "deepseek/deepseek-v4-pro");
  assert.deepEqual(sanitized.agents.list[0].tools.alsoAllow, ["lark_kb_answer"]);
});

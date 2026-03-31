import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const [
  { executeCapabilityLane, resolveLaneExecutionPlan },
  { resolveCapabilityLane },
  { setLarkAuthServiceOverridesForTests },
  { upsertAccount, saveToken },
  { disposeLarkContentClientForTests },
  { tasks: realUserTasks },
] = await Promise.all([
  import("../src/lane-executor.mjs"),
  import("../src/capability-lane.mjs"),
  import("../src/lark-user-auth.mjs"),
  import("../src/rag-repository.mjs"),
  import("../src/lark-content.mjs"),
  import("../evals/real-user-tasks.mjs"),
]);

const INTERNAL_LEAK_PATTERN = /\b(?:internal|routing|lane|trace|chosen_action|fallback_reason)\b|ROUTING_NO_MATCH/i;
const SYSTEM_STYLE_PATTERN = /任務已啟動|正在處理|請提供資料/i;

const quietLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  compactError(error) {
    return error?.message || String(error);
  },
};

test.after(() => {
  setLarkAuthServiceOverridesForTests({});
  disposeLarkContentClientForTests();
  testDb.close();
});

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function seedAccount(authMode = "user") {
  const account = upsertAccount({
    open_id: `ou-real-user-${crypto.randomUUID()}`,
    name: `real-user-${authMode}`,
  }, "offline_access");

  if (authMode === "tenant") {
    saveToken(account.id, {
      access_token: `expired-${account.id}`,
      refresh_token: null,
      token_type: "Bearer",
      scope: "offline_access",
      expires_at: nowSeconds() - 3600,
      refresh_expires_at: null,
    });
    setLarkAuthServiceOverridesForTests({
      postAuthenJson: async (pathname) => {
        assert.equal(pathname, "/open-apis/auth/v3/tenant_access_token/internal");
        return {
          tenant_access_token: `tenant-${account.id}`,
          expire: 7200,
        };
      },
    });
    return account;
  }

  saveToken(account.id, {
    access_token: `access-${account.id}`,
    refresh_token: `refresh-${account.id}`,
    token_type: "Bearer",
    scope: "offline_access",
    expires_at: nowSeconds() + 3600,
    refresh_expires_at: nowSeconds() + 7200,
  });
  setLarkAuthServiceOverridesForTests({});
  return account;
}

function buildEvent({ account, message, chatId }) {
  return {
    sender: {
      sender_id: {
        open_id: account.open_id,
      },
    },
    message: {
      chat_id: chatId,
      content: JSON.stringify({ text: message }),
    },
  };
}

function buildScope(event) {
  const baseScope = {
    chat_type: "p2p",
    chat_id: event.message.chat_id,
    session_key: `session:${event.message.chat_id}`,
    workspace_key: "workspace:test",
  };
  return {
    ...baseScope,
    ...resolveCapabilityLane(baseScope, event),
  };
}

test("real-user usability regression pack keeps assistant-like behavior stable", async (t) => {
  for (const entry of realUserTasks) {
    await t.test(entry.id, async () => {
      const account = seedAccount(entry.auth_mode || "user");
      const event = buildEvent({
        account,
        message: entry.message,
        chatId: `chat-${entry.id}-${Date.now()}`,
      });
      const scope = buildScope(event);
      const plan = resolveLaneExecutionPlan({ event, scope });
      const reply = await executeCapabilityLane({
        event,
        scope,
        logger: quietLogger,
      });

      assert.equal(scope.capability_lane, entry.expected.capability_lane);
      assert.equal(plan.chosen_lane, entry.expected.capability_lane);
      assert.equal(plan.chosen_action, entry.expected.chosen_action);
      assert.equal(plan.fallback_reason, null);

      assert.equal(typeof reply?.text, "string");
      assert.equal(reply.text, entry.expected.reply_snapshot);
      assert.match(reply.text, /^結論\n/);
      assert.match(reply.text, /\n\n重點\n/);
      assert.match(reply.text, /\n\n下一步\n/);
      assert.doesNotMatch(reply.text, INTERNAL_LEAK_PATTERN);
      assert.doesNotMatch(reply.text, SYSTEM_STYLE_PATTERN);

      for (const marker of entry.expected.help_markers || []) {
        assert.equal(reply.text.includes(marker), true, `missing help marker: ${marker}`);
      }
    });
  }
});

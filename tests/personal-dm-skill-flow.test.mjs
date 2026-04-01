import test from "node:test";
import assert from "node:assert/strict";

import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const {
  maybeExecutePersonalDMSkillTask,
} = await import("../src/lane-executor.mjs");
const {
  sendLaneReply,
} = await import("../src/runtime-message-reply.mjs");

test.after(() => {
  testDb.close();
});

function createDmEvent(text, {
  chatId = "oc_dm_chat_1",
  messageId = "om_dm_message_1",
  openId = "ou_dm_user_1",
} = {}) {
  return {
    sender: {
      sender_id: {
        open_id: openId,
      },
    },
    message: {
      chat_id: chatId,
      message_id: messageId,
      chat_type: "p2p",
      content: JSON.stringify({
        text,
      }),
    },
  };
}

function createDmScope() {
  return {
    capability_lane: "personal-assistant",
    chat_type: "dm",
    session_key: "session:lark:dm:ou_dm_user_1",
  };
}

function createLoggerCalls() {
  const calls = [];
  return {
    calls,
    logger: {
      info(event, payload) {
        calls.push({ level: "info", event, payload });
      },
      warn(event, payload) {
        calls.push({ level: "warn", event, payload });
      },
      error(event, payload) {
        calls.push({ level: "error", event, payload });
      },
    },
  };
}

test("personal DM explicit find-skill request enters planner and hits the bounded find action", async () => {
  const captured = [];
  const reply = await maybeExecutePersonalDMSkillTask({
    event: createDmEvent("幫我找 find-skills skill"),
    scope: createDmScope(),
    intentPlanner: async () => ({
      ok: true,
      is_delegated_task: true,
      intent: "skill_find_request",
      skill_query: "find-skills",
      reason: "explicit_find",
    }),
    skillActionExecutor: async (input) => {
      captured.push(input);
      return {
        ok: true,
        action: "find_local_skill",
        public_reply: {
          answer: "找到 1 個 skill。",
          sources: ["`find-skills`：可安裝"],
          limitations: ["目前只搜尋受控本機 skill 目錄。"],
        },
      };
    },
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].intent, "skill_find_request");
  assert.equal(captured[0].query, "find-skills");
  assert.match(reply.text, /^結論\n/);
  assert.match(reply.text, /找到 1 個 skill/);
});

test("personal DM explicit install-skill request enters planner and hits install_local_skill", async () => {
  const captured = [];
  const reply = await maybeExecutePersonalDMSkillTask({
    event: createDmEvent("幫我安裝 playwright-cli skill"),
    scope: createDmScope(),
    intentPlanner: async () => ({
      ok: true,
      is_delegated_task: true,
      intent: "skill_install_request",
      skill_query: "playwright-cli",
      reason: "explicit_install",
    }),
    skillActionExecutor: async (input) => {
      captured.push(input);
      return {
        ok: true,
        action: "install_local_skill",
        public_reply: {
          answer: "已安裝本機 skill「playwright-cli」。",
          sources: ["安裝位置：~/.codex/skills/playwright-cli"],
          limitations: ["目前只支援受控本機安裝。"],
        },
      };
    },
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].intent, "skill_install_request");
  assert.equal(captured[0].query, "playwright-cli");
  assert.match(reply.text, /已安裝本機 skill/);
});

test("personal DM explicit verify-skill request enters planner and hits verify_local_skill", async () => {
  const captured = [];
  const reply = await maybeExecutePersonalDMSkillTask({
    event: createDmEvent("幫我驗證 playwright-cli skill 有沒有裝好"),
    scope: createDmScope(),
    intentPlanner: async () => ({
      ok: true,
      is_delegated_task: true,
      intent: "skill_verify_request",
      skill_query: "playwright-cli",
      reason: "explicit_verify",
    }),
    skillActionExecutor: async (input) => {
      captured.push(input);
      return {
        ok: true,
        action: "verify_local_skill",
        public_reply: {
          answer: "已驗證「playwright-cli」目前已安裝。",
          sources: ["驗證依據：已找到 `SKILL.md`"],
          limitations: ["這次只驗證本機目錄與 `SKILL.md` 是否存在。"],
        },
      };
    },
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].intent, "skill_verify_request");
  assert.equal(captured[0].query, "playwright-cli");
  assert.match(reply.text, /目前已安裝/);
});

test("general chat or non-skill DM keeps the original general assistant fallback path", async () => {
  const reply = await maybeExecutePersonalDMSkillTask({
    event: createDmEvent("你好"),
    scope: createDmScope(),
    intentPlanner: async () => ({
      ok: true,
      is_delegated_task: false,
      intent: "not_skill_task",
      skill_query: "",
      reason: "greeting",
    }),
  });

  assert.equal(reply, null);
});

test("skill action failure stays user-facing readable without leaking raw internal error details", async () => {
  const reply = await maybeExecutePersonalDMSkillTask({
    event: createDmEvent("幫我安裝 broken-skill"),
    scope: createDmScope(),
    intentPlanner: async () => ({
      ok: true,
      is_delegated_task: true,
      intent: "skill_install_request",
      skill_query: "broken-skill",
      reason: "explicit_install",
    }),
    skillActionExecutor: async () => ({
      ok: false,
      action: "install_local_skill",
      public_reply: {
        answer: "沒能安裝「broken-skill」。失敗在複製到安裝目錄這一步。",
        sources: ["安裝目標：~/.codex/skills/broken-skill"],
        limitations: ["這次已隱藏內部例外細節，只保留對外可讀的失敗說明。"],
      },
      details: {
        internal_error: "EACCES: permission denied\nstack...",
      },
    }),
  });

  assert.match(reply.text, /失敗在複製到安裝目錄這一步/);
  assert.doesNotMatch(reply.text, /EACCES|stack|runtime_exception/);
});

test("personal DM skill reply remains compatible with the existing Lark reply send path", async () => {
  const { calls, logger } = createLoggerCalls();
  const reply = await maybeExecutePersonalDMSkillTask({
    event: createDmEvent("幫我找 find-skills skill", {
      chatId: "oc_dm_chat_compat",
      messageId: "om_dm_message_compat",
      openId: "ou_dm_user_compat",
    }),
    scope: {
      ...createDmScope(),
      session_key: "session:lark:dm:ou_dm_user_compat",
    },
    intentPlanner: async () => ({
      ok: true,
      is_delegated_task: true,
      intent: "skill_find_request",
      skill_query: "find-skills",
      reason: "explicit_find",
    }),
    skillActionExecutor: async () => ({
      ok: true,
      action: "find_local_skill",
      public_reply: {
        answer: "找到 1 個 skill。",
        sources: ["`find-skills`：可安裝"],
        limitations: ["目前只搜尋受控本機 skill 目錄。"],
      },
    }),
  });

  await sendLaneReply({
    event: createDmEvent("幫我找 find-skills skill", {
      chatId: "oc_dm_chat_compat",
      messageId: "om_dm_message_compat",
      openId: "ou_dm_user_compat",
    }),
    reply,
    logger,
    async resolveReplyAuth() {
      return {
        accountId: "acct_dm_compat",
        accessToken: { accessToken: "tenant-token", tokenType: "tenant" },
        tokenType: "tenant",
        source: "tenant_bot_token",
      };
    },
    async executeMessageSend() {
      return {
        ok: true,
        result: {
          message_id: "om_reply_dm_compat",
          chat_id: "oc_dm_chat_compat",
          msg_type: "text",
        },
      };
    },
  });

  assert.equal(calls[0].event, "reply_send_attempted");
  assert.equal(calls[1].event, "reply_send_succeeded");
});

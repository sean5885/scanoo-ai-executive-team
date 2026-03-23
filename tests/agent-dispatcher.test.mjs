import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRegisteredAgentPrompt,
  dispatchRegisteredAgentCommand,
  executeRegisteredAgent,
} from "../src/agent-dispatcher.mjs";
import { getRegisteredAgent } from "../src/agent-registry.mjs";

test("buildRegisteredAgentPrompt keeps persona goal, image context, and retrieval context compact", () => {
  const result = buildRegisteredAgentPrompt({
    agent: getRegisteredAgent("ceo"),
    userRequest: "請幫我整合這份決策背景與風險",
    items: [
      {
        title: "董事會紀錄",
        url: "https://example.com/doc-1",
        content: "這是一段很長的決策背景。".repeat(120),
      },
      {
        title: "產品策略",
        url: "https://example.com/doc-2",
        content: "這是一段很長的產品策略與風險。".repeat(120),
      },
    ],
    checkpoint: {
      goal: "持續回答 CEO 決策問題",
      completed: ["已整理董事會背景"],
      pending: ["本輪要回答風險與取捨"],
      constraints: ["只能根據來源回答"],
      facts: ["已知有產品優先級衝突"],
      risks: ["不要亂猜未確認決策"],
    },
    imageContext: "scene_summary: 白板拍照；visible_text: Q2 目標；key_entities: CEO, PM",
  });

  assert.match(result.prompt, /<lobster_prompt/);
  assert.match(result.prompt, /\/ceo agent/);
  assert.match(result.prompt, /<section name="image_context"/);
  assert.match(result.prompt, /白板拍照/);
  assert.match(result.prompt, /董事會紀錄/);
  assert.ok(result.prompt.length < 5000);
});

test("buildRegisteredAgentPrompt forces single-voice three-part synthesis when supporting context exists", () => {
  const result = buildRegisteredAgentPrompt({
    agent: getRegisteredAgent("ceo"),
    userRequest: "請收斂這輪多角色意見",
    items: [
      {
        title: "董事會紀錄",
        url: "https://example.com/doc-1",
        content: "決策背景與風險整理。",
      },
    ],
    supportingContext: "/consult\n- 子任務：拆解問題\n- 輸出：先確認決策邊界",
  });

  assert.match(result.systemPrompt, /單一口吻/);
  assert.match(result.systemPrompt, /結論 \/ 重點 \/ 下一步/);
  assert.match(result.prompt, /supporting_context/);
});

test("executeRegisteredAgent can use injected text generator without direct LLM api key", async () => {
  const agent = getRegisteredAgent("cmo");
  const result = await executeRegisteredAgent({
    accountId: "acct-1",
    agent,
    requestText: "請整理這批 OKR 文檔缺什麼",
    scope: { session_key: "session-1" },
    searchFn() {
      return {
        items: [
          {
            title: "公司 OKR 運作方式說明",
            url: "https://example.com/okr",
            content: "說明公司 OKR 範圍與跨角色週會。",
          },
        ],
      };
    },
    async textGenerator() {
      return "結論\n這裡是 cmo 的正式回答。";
    },
  });

  assert.match(result.text, /正式回答/);
  assert.equal(result.agentId, "cmo");
  assert.equal(result.metadata.retrieval_count, 1);
  assert.equal(result.metadata.fallback_used, false);
});

test("executeRegisteredAgent intercepts raw JSON string payload before it reaches user-facing text", async () => {
  const agent = getRegisteredAgent("cmo");
  const result = await executeRegisteredAgent({
    accountId: "acct-1",
    agent,
    requestText: "請整理這批 OKR 文檔缺什麼",
    scope: { session_key: "session-json-string" },
    searchFn() {
      return {
        items: [
          {
            title: "公司 OKR 運作方式說明",
            url: "https://example.com/okr",
            content: "說明公司 OKR 範圍與跨角色週會。",
          },
        ],
      };
    },
    async textGenerator() {
      return JSON.stringify({
        ok: true,
        answer: "目前最缺 owner、deadline，還有跨部門依賴欄位。",
        sources: ["OKR 運作方式說明：目前流程只描述週會，沒有 owner/deadline 欄位要求。"],
        limitations: ["如果你要，我可以直接整理成缺欄 checklist。"],
      });
    },
  });

  assert.match(result.text, /^結論/m);
  assert.match(result.text, /最缺 owner、deadline/);
  assert.doesNotMatch(result.text, /^{|```json|\"ok\"|\"answer\"|\"sources\"|\"limitations\"/);
});

test("executeRegisteredAgent intercepts raw JSON object payload and keeps machine-readable fields", async () => {
  const agent = getRegisteredAgent("cmo");
  const result = await executeRegisteredAgent({
    accountId: "acct-1",
    agent,
    requestText: "請整理這批 OKR 文檔缺什麼",
    scope: { session_key: "session-json-object" },
    searchFn() {
      return {
        items: [
          {
            title: "公司 OKR 運作方式說明",
            url: "https://example.com/okr",
            content: "說明公司 OKR 範圍與跨角色週會。",
          },
        ],
      };
    },
    async textGenerator() {
      return {
        answer: "這輪先補 owner 與驗收條件，否則 OKR 追蹤會持續鬆散。",
        details: { missing_fields: ["owner", "acceptance_criteria"] },
        context: { source: "mock-structured-object" },
      };
    },
  });

  assert.match(result.text, /^結論/m);
  assert.match(result.text, /先補 owner 與驗收條件/);
  assert.doesNotMatch(result.text, /missing_fields|mock-structured-object|^{|\"details\"|\"context\"/);
  assert.deepEqual(result.details, {
    missing_fields: ["owner", "acceptance_criteria"],
  });
  assert.deepEqual(result.context, {
    source: "mock-structured-object",
  });
  assert.equal("error" in result, false);
});

test("executeRegisteredAgent fallback reply no longer exposes extractive wording", async () => {
  const agent = getRegisteredAgent("cmo");
  const result = await executeRegisteredAgent({
    accountId: "acct-1",
    agent,
    requestText: "請整理這批 OKR 文檔缺什麼",
    scope: { session_key: "session-2" },
    searchFn() {
      return {
        items: [
          {
            title: "公司 OKR 運作方式說明",
            url: "https://example.com/okr",
            content: "說明公司 OKR 範圍與跨角色週會。",
          },
        ],
      };
    },
    async textGenerator() {
      throw new Error("mock_failure");
    },
  });

  assert.doesNotMatch(result.text, /extractive/);
  assert.doesNotMatch(result.text, /FALLBACK_DISABLED|registered_agent_generation_fallback_disabled|\"ok\"|\"error\"|\"details\"/);
  if (result.metadata.fallback_used === false) {
    assert.match(result.text, /沒有可用的生成路徑|內部錯誤/);
    assert.equal(result.metadata.fallback_used, false);
  } else {
    assert.match(result.text, /先按目前找到的資料替你整理/);
    assert.equal(result.metadata.fallback_used, true);
  }
});

test("executeRegisteredAgent intercepts fenced JSON error blob and preserves program-facing error details", async () => {
  const agent = getRegisteredAgent("cmo");
  const result = await executeRegisteredAgent({
    accountId: "acct-1",
    agent,
    requestText: "請整理這批 OKR 文檔缺什麼",
    scope: { session_key: "session-fenced-json-error" },
    searchFn() {
      return {
        items: [
          {
            title: "公司 OKR 運作方式說明",
            url: "https://example.com/okr",
            content: "說明公司 OKR 範圍與跨角色週會。",
          },
        ],
      };
    },
    async textGenerator() {
      return `\`\`\`json
{"ok":false,"error":"registered_agent_generation_failed","details":{"message":"schema_invalid"},"context":{"provider":"mock"}}
\`\`\``;
    },
  });

  assert.match(result.text, /^結論/m);
  assert.match(result.text, /結構化錯誤結果|自然語言摘要/);
  assert.doesNotMatch(result.text, /```json|registered_agent_generation_failed|schema_invalid|\"error\"|\"details\"|\"context\"/);
  assert.equal(result.error, "registered_agent_generation_failed");
  assert.deepEqual(result.details, {
    message: "schema_invalid",
  });
  assert.deepEqual(result.context, {
    provider: "mock",
  });
});

test("executeRegisteredAgent leaves ordinary JSON string output on the normal success path", async () => {
  const agent = getRegisteredAgent("cmo");
  const result = await executeRegisteredAgent({
    accountId: "acct-1",
    agent,
    requestText: "請整理這批 OKR 文檔缺什麼",
    scope: { session_key: "session-plain-json-string" },
    searchFn() {
      return {
        items: [
          {
            title: "公司 OKR 運作方式說明",
            url: "https://example.com/okr",
            content: "說明公司 OKR 範圍與跨角色週會。",
          },
        ],
      };
    },
    async textGenerator() {
      return "\"這是一段直接可讀的回答\"";
    },
  });

  assert.doesNotMatch(result.text, /^結論/m);
  assert.match(result.text, /這是一段直接可讀的回答/);
  assert.equal("error" in result, false);
  assert.equal("details" in result, false);
  assert.equal("context" in result, false);
});

test("dispatchRegisteredAgentCommand no-match reply is natural language instead of raw JSON", async () => {
  const result = await dispatchRegisteredAgentCommand({
    accountId: "acct-1",
    scope: {
      session_key: "session-agent-no-match",
      trace_id: "trace-agent-no-match",
    },
    event: {
      trace_id: "trace-agent-no-match",
      message: {
        content: JSON.stringify({
          text: "/knowledge unknown-subcommand 幫我看看",
        }),
      },
    },
  });

  assert.ok(result);
  assert.match(result.text, /^結論/m);
  assert.match(result.text, /registered agent|slash 指令/);
  assert.doesNotMatch(result.text, /ROUTING_NO_MATCH|registered_agent_command_no_match|\"ok\"|\"error\"|\"details\"/);
});

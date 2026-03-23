import test from "node:test";
import assert from "node:assert/strict";

import { buildRegisteredAgentPrompt, executeRegisteredAgent } from "../src/agent-dispatcher.mjs";
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
  if (result.text.includes("registered_agent_generation_fallback_disabled")) {
    assert.match(result.text, /FALLBACK_DISABLED/);
    assert.equal(result.metadata.fallback_used, false);
  } else {
    assert.match(result.text, /先按目前找到的資料替你整理/);
    assert.equal(result.metadata.fallback_used, true);
  }
});

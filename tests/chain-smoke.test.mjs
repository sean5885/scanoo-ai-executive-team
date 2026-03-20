import test from "node:test";
import assert from "node:assert/strict";

import { parseRegisteredAgentCommand } from "../src/agent-registry.mjs";
import { executeRegisteredAgent } from "../src/agent-dispatcher.mjs";
import { getRegisteredAgent } from "../src/agent-registry.mjs";

const PERSONA_CASES = [
  ["/generalist", "generalist"],
  ["/ceo", "ceo"],
  ["/product", "product"],
  ["/prd", "prd"],
  ["/cmo", "cmo"],
  ["/consult", "consult"],
  ["/cdo", "cdo"],
];

test("major slash commands route to the expected agents", () => {
  for (const [slash, id] of PERSONA_CASES) {
    const parsed = parseRegisteredAgentCommand(`${slash} 測試任務`);
    assert.equal(parsed?.agent?.id, id);
  }
  assert.equal(parseRegisteredAgentCommand("/knowledge audit 盤點一下")?.agent?.id, "knowledge-audit");
});

test("registered agent smoke path returns stable schema", async () => {
  const result = await executeRegisteredAgent({
    accountId: "acct-1",
    agent: getRegisteredAgent("ceo"),
    requestText: "幫我整理決策重點",
    scope: { session_key: "smoke-session" },
    searchFn() {
      return {
        items: [
          {
            title: "董事會決策紀錄",
            url: "https://example.com/board",
            content: "先完成 beta，再決定是否擴編。",
          },
        ],
      };
    },
    async textGenerator() {
      return "決策建議\n先完成 beta，再決定是否擴編。";
    },
  });

  assert.equal(result.agentId, "ceo");
  assert.match(result.text, /beta/);
});

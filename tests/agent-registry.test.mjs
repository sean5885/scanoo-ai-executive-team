import test from "node:test";
import assert from "node:assert/strict";

import {
  getRegisteredAgent,
  listAgentCapabilityMatrix,
  parseRegisteredAgentCommand,
} from "../src/agent-registry.mjs";

test("parseRegisteredAgentCommand resolves persona slash commands", () => {
  const parsed = parseRegisteredAgentCommand("/ceo 幫我做這個決策整理");

  assert.equal(parsed?.agent?.id, "ceo");
  assert.equal(parsed?.body, "幫我做這個決策整理");
});

test("parseRegisteredAgentCommand resolves knowledge subcommands", () => {
  const parsed = parseRegisteredAgentCommand("/knowledge conflicts 幫我找衝突");

  assert.equal(parsed?.agent?.id, "knowledge-conflicts");
  assert.equal(parsed?.body, "幫我找衝突");
});

test("parseRegisteredAgentCommand falls back knowledge without subcommand to brain", () => {
  const parsed = parseRegisteredAgentCommand("/knowledge 請整理這批知識");

  assert.equal(parsed?.agent?.id, "knowledge-brain");
  assert.equal(parsed?.body, "請整理這批知識");
});

test("registered future agents are also available", () => {
  assert.equal(getRegisteredAgent("delivery")?.slash, "/delivery");
  assert.equal(getRegisteredAgent("ops")?.slash, "/ops");
  assert.equal(getRegisteredAgent("tech")?.slash, "/tech");
});

test("registered agents expose minimum capability contract", () => {
  const matrix = listAgentCapabilityMatrix();
  const ceo = matrix.find((item) => item.agent_name === "ceo");
  const knowledge = matrix.find((item) => item.agent_name === "knowledge-conflicts");

  assert.equal(ceo?.command, "/ceo");
  assert.ok(Array.isArray(ceo?.allowed_tools));
  assert.equal(ceo?.downstream_consumer, "lark_reply");
  assert.equal(ceo?.status, "ready");

  assert.equal(knowledge?.command, "/knowledge conflicts");
  assert.ok(Array.isArray(knowledge?.allowed_tools));
  assert.equal(knowledge?.fallback_behavior, "fallback_to_grounded_retrieval_summary");
});

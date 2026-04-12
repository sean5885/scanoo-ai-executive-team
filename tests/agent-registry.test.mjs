import test from "node:test";
import assert from "node:assert/strict";

import {
  getRegisteredAgent,
  listAgentCapabilityMatrix,
  parseRegisteredAgentCommand,
  resolveRegisteredAgentFamilyRequest,
} from "../src/agent-registry.mjs";

test("parseRegisteredAgentCommand resolves core slash commands", () => {
  const parsed = parseRegisteredAgentCommand("/planner 幫我做這個決策整理");

  assert.equal(parsed?.agent?.id, "planner_agent");
  assert.equal(parsed?.body, "幫我做這個決策整理");
});

test("parseRegisteredAgentCommand resolves knowledge subcommands", () => {
  const parsed = parseRegisteredAgentCommand("/knowledge conflicts 幫我找衝突");

  assert.equal(parsed?.error, "ROUTING_NO_MATCH");
  assert.equal(parsed?.body, "conflicts 幫我找衝突");
});

test("parseRegisteredAgentCommand fail-closes knowledge without subcommand", () => {
  const parsed = parseRegisteredAgentCommand("/knowledge 請整理這批知識");

  assert.equal(parsed?.error, "ROUTING_NO_MATCH");
  assert.equal(parsed?.body, "請整理這批知識");
});

test("resolveRegisteredAgentFamilyRequest matches embedded slash and rejects old persona-style mentions", () => {
  const embeddedSlash = resolveRegisteredAgentFamilyRequest("把這輪改交給 /planner");
  const personaStyle = resolveRegisteredAgentFamilyRequest("請 consult agent 做方案比較");

  assert.equal(embeddedSlash?.agent?.id, "planner_agent");
  assert.equal(embeddedSlash?.surface, "slash_command");
  assert.equal(personaStyle, null);
});

test("registered future agents are also available", () => {
  assert.equal(getRegisteredAgent("generalist")?.slash, "/generalist");
  assert.equal(getRegisteredAgent("planner_agent")?.slash, "/planner");
  assert.equal(getRegisteredAgent("company_brain_agent")?.slash, "/company-brain");
});

test("registered agents expose minimum capability contract", () => {
  const matrix = listAgentCapabilityMatrix();
  const planner = matrix.find((item) => item.agent_name === "planner_agent");
  const companyBrain = matrix.find((item) => item.agent_name === "company_brain_agent");

  assert.equal(planner?.command, "/planner");
  assert.ok(Array.isArray(planner?.allowed_tools));
  assert.equal(planner?.downstream_consumer, "lark_reply");
  assert.equal(planner?.status, "ready");

  assert.equal(companyBrain?.command, "/company-brain");
  assert.ok(Array.isArray(companyBrain?.allowed_tools));
  assert.equal(companyBrain?.fallback_behavior, "fail_closed");
});

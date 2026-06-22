import { cleanText } from "./message-intent-utils.mjs";
import { ROUTING_NO_MATCH } from "./planner-error-codes.mjs";
import { legacyPersonaAgentConfigs, legacyPersonaAgentIds } from "./legacy-agent-personas.mjs";

const BASE_AGENT_RULES = [
  "優先引用檢索到的 Lark 文件與知識片段。",
  "輸出要直接可執行，不要先寫長篇自我分析。",
  "沒有足夠證據時，明確標示待確認。",
];

const DEFAULT_INPUT_SCHEMA = Object.freeze({
  request_text: "string",
  scope: "object",
  event: "object|null",
  image_context: "string|optional",
  supporting_context: "string|optional",
});

const DEFAULT_OUTPUT_SCHEMA = Object.freeze({
  text: "string",
  agentId: "string",
});

const DEFAULT_GRAPH_INPUT_CONTRACT = Object.freeze({
  required_fields: ["request_text", "context_refs"],
});

const DEFAULT_GRAPH_OUTPUT_CONTRACT = Object.freeze({
  type: "structured_output",
  schema: {
    answer: "string",
    sources: "array",
    limitations: "array",
  },
});

function createCoreAgent({
  id,
  slash = "",
  kind = "core",
  subcommand = "",
  label,
  role,
  goal,
  outputContract,
  extraRules = [],
  retrievalQueryPrefix = "",
  downstreamConsumer = "lark_reply",
  allowedTools = ["knowledge_search", "image_understanding", "text_generation"],
  fallbackBehavior = "fail_closed",
  status = "ready",
}) {
  const normalizedSlash = cleanText(slash);
  return {
    id,
    slash: normalizedSlash || null,
    kind,
    subcommand: cleanText(subcommand) || null,
    label,
    role,
    goal,
    outputContract,
    retrievalQueryPrefix,
    rules: [...BASE_AGENT_RULES, ...extraRules],
    contract: {
      trigger: normalizedSlash || id,
      expected_input_schema: DEFAULT_INPUT_SCHEMA,
      expected_output_schema: DEFAULT_OUTPUT_SCHEMA,
      downstream_consumer: downstreamConsumer,
      allowed_tools: allowedTools,
      graph_input_contract: DEFAULT_GRAPH_INPUT_CONTRACT,
      graph_output_contract: DEFAULT_GRAPH_OUTPUT_CONTRACT,
      fallback_behavior: fallbackBehavior,
      status,
    },
  };
}

export const agentRegistry = Object.freeze({
  generalist: createCoreAgent({
    id: "generalist",
    slash: "/generalist",
    label: "Generalist Agent",
    role: "你是 generalist_agent，負責 planner/executive default 回覆整合與可執行輸出。",
    goal: "先回答眼前問題；若有明確限制、決策、待辦或風險，直接整理出來。",
    outputContract: "輸出三段：結論 / 重點 / 下一步。",
    extraRules: [
      "不要輸出舊版角色分工或多角色協作段落。",
      "若證據不足，明確標示待確認。",
    ],
  }),
  planner_agent: createCoreAgent({
    id: "planner_agent",
    slash: "/planner",
    label: "Planner Agent",
    role: "你是 planner_agent，負責嚴格 JSON planner 決策與受控 action/preset 路由。",
    goal: "維持 action 選擇可驗證、可追蹤、可回放。",
    outputContract: "僅輸出 planner contract 定義欄位，不輸出多餘自然語言。",
    allowedTools: ["planner_tool_dispatch", "runtime_info_read"],
  }),
  company_brain_agent: createCoreAgent({
    id: "company_brain_agent",
    slash: "/company-brain",
    label: "Company Brain Agent",
    role: "你是 company_brain_agent，負責 mirror list/search/detail 的受控 read-side 查詢。",
    goal: "回傳可追蹤的 read-side 結果，不宣稱未驗證 write 完成。",
    outputContract: "輸出 answer -> sources -> limitations 固定順序。",
    allowedTools: ["company_brain_list", "company_brain_search", "company_brain_detail"],
  }),
  ...Object.fromEntries(
    legacyPersonaAgentConfigs.map((config) => [config.id, createCoreAgent(config)]),
  ),
  "knowledge-audit": createCoreAgent({
    id: "knowledge-audit",
    slash: "/knowledge",
    subcommand: "audit",
    kind: "knowledge",
    label: "Knowledge Audit",
    role: "你是 /knowledge audit agent，負責盤點知識覆蓋、缺口與重複。",
    goal: "只根據檢索到的文件找出知識覆蓋、缺口、重複與後續動作。",
    outputContract: "輸出四段：盤點結論 / 主要缺口 / 重複或分散點 / 建議下一步。",
    retrievalQueryPrefix: "盤點知識覆蓋、缺口、重複：",
    allowedTools: ["knowledge_search", "semantic_classifier", "image_understanding", "text_generation"],
  }),
  "knowledge-conflicts": createCoreAgent({
    id: "knowledge-conflicts",
    slash: "/knowledge",
    subcommand: "conflicts",
    kind: "knowledge",
    label: "Knowledge Conflicts",
    role: "你是 /knowledge conflicts agent，負責找出互相衝突的知識與文件片段。",
    goal: "找出真正的衝突、衝突來源與建議確認版。",
    outputContract: "輸出四段：衝突摘要 / 涉及文件 / 建議確認版 / 待決策問題。",
    retrievalQueryPrefix: "找出知識衝突：",
    allowedTools: ["knowledge_search", "semantic_classifier", "image_understanding", "text_generation"],
  }),
  "knowledge-distill": createCoreAgent({
    id: "knowledge-distill",
    slash: "/knowledge",
    subcommand: "distill",
    kind: "knowledge",
    label: "Knowledge Distill",
    role: "你是 /knowledge distill agent，負責把分散知識蒸餾成短版核心結論。",
    goal: "把檢索結果壓成最小必要知識卡。",
    outputContract: "輸出三段：核心結論 / 關鍵依據 / 建議保存方式。",
    retrievalQueryPrefix: "蒸餾知識：",
    allowedTools: ["knowledge_search", "semantic_classifier", "image_understanding", "text_generation"],
  }),
});

const PUBLIC_REGISTERED_AGENT_IDS = Object.freeze([
  "generalist",
  "planner_agent",
  "company_brain_agent",
]);

const LEGACY_AGENT_ALIAS_MAP = Object.freeze({
  ...Object.fromEntries(legacyPersonaAgentIds.map((agentId) => [agentId, "generalist"])),
});

export const knowledgeAgentSubcommands = Object.freeze(
  Object.values(agentRegistry)
    .filter((agent) => agent.kind === "knowledge" && cleanText(agent.subcommand))
    .map((agent) => cleanText(agent.subcommand)),
);

function listRegisteredCoreAgents() {
  return PUBLIC_REGISTERED_AGENT_IDS
    .map((agentId) => agentRegistry[agentId])
    .filter(Boolean);
}

function findRegisteredSlashMentionIndex(text = "", slash = "") {
  const normalizedText = cleanText(String(text || "").toLowerCase());
  const normalizedSlash = cleanText(String(slash || "").toLowerCase());
  if (!normalizedText || !normalizedSlash) {
    return -1;
  }
  return normalizedText.indexOf(normalizedSlash);
}

export function listRegisteredAgents() {
  return listRegisteredCoreAgents();
}

export function canonicalizeRegisteredAgentId(agentId = "") {
  const normalizedAgentId = cleanText(agentId);
  if (!normalizedAgentId) {
    return "";
  }
  if (LEGACY_AGENT_ALIAS_MAP[normalizedAgentId]) {
    return LEGACY_AGENT_ALIAS_MAP[normalizedAgentId];
  }
  return agentRegistry[normalizedAgentId] ? normalizedAgentId : "";
}

export function resolveKnownRegisteredAgentId(agentId = "") {
  const normalizedAgentId = cleanText(agentId);
  if (!normalizedAgentId) {
    return "";
  }
  if (agentRegistry[normalizedAgentId]) {
    return normalizedAgentId;
  }
  return canonicalizeRegisteredAgentId(normalizedAgentId);
}

export function listAgentCapabilityMatrix() {
  return listRegisteredAgents().map((agent) => ({
    agent_name: agent.id,
    command: agent.contract?.trigger || agent.slash,
    input_schema: agent.contract?.expected_input_schema || DEFAULT_INPUT_SCHEMA,
    output_schema: agent.contract?.expected_output_schema || DEFAULT_OUTPUT_SCHEMA,
    allowed_tools: agent.contract?.allowed_tools || [],
    graph_input_contract: agent.contract?.graph_input_contract || DEFAULT_GRAPH_INPUT_CONTRACT,
    graph_output_contract: agent.contract?.graph_output_contract || DEFAULT_GRAPH_OUTPUT_CONTRACT,
    downstream_consumer: agent.contract?.downstream_consumer || "lark_reply",
    fallback_behavior: agent.contract?.fallback_behavior || "fail_closed",
    status: agent.contract?.status || "ready",
  }));
}

export function getAgentGraphContract(agentId = "") {
  const agent = getRegisteredAgent(agentId);
  return {
    input_contract: agent?.contract?.graph_input_contract || DEFAULT_GRAPH_INPUT_CONTRACT,
    allowed_tools: Array.isArray(agent?.contract?.allowed_tools) ? agent.contract.allowed_tools : [],
    output_contract: agent?.contract?.graph_output_contract || DEFAULT_GRAPH_OUTPUT_CONTRACT,
  };
}

export function getRegisteredAgent(agentId = "") {
  const normalizedAgentId = cleanText(agentId);
  return normalizedAgentId ? agentRegistry[normalizedAgentId] || null : null;
}

function resolveKnowledgeAgentBySubcommand(subcommand = "") {
  const normalizedSubcommand = cleanText(subcommand).toLowerCase();
  if (!normalizedSubcommand) {
    return null;
  }
  return Object.values(agentRegistry).find((agent) => (
    agent.kind === "knowledge" && cleanText(agent.subcommand).toLowerCase() === normalizedSubcommand
  )) || null;
}

export function parseRegisteredAgentCommand(text = "", {
  includeKnowledgeSubcommands = false,
} = {}) {
  const normalized = cleanText(text);
  if (!normalized.startsWith("/")) {
    return null;
  }

  const match = normalized.match(/^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]+))?$/i);
  if (!match) {
    return null;
  }

  const slashName = `/${String(match[1] || "").toLowerCase()}`;
  const rawRemainder = cleanText(match[2] || "");

  if (slashName === "/knowledge") {
    if (!includeKnowledgeSubcommands) {
      return {
        error: ROUTING_NO_MATCH,
        body: rawRemainder,
        raw: normalized,
      };
    }
    const [rawSubcommand = "", ...rest] = rawRemainder.split(/\s+/).filter(Boolean);
    const subcommand = cleanText(rawSubcommand).toLowerCase();
    const knowledgeAgent = resolveKnowledgeAgentBySubcommand(subcommand);
    if (!knowledgeAgent) {
      return {
        error: ROUTING_NO_MATCH,
        body: rawRemainder,
        raw: normalized,
      };
    }
    return {
      agent: knowledgeAgent,
      body: cleanText(rest.join(" ")),
      raw: normalized,
    };
  }

  const directAgent = listRegisteredCoreAgents()
    .find((item) => cleanText(item?.slash || "").toLowerCase() === slashName);
  if (directAgent) {
    return {
      agent: directAgent,
      body: rawRemainder,
      raw: normalized,
    };
  }

  const aliasMatch = Object.entries(LEGACY_AGENT_ALIAS_MAP)
    .find(([legacyAgentId]) => cleanText(agentRegistry[legacyAgentId]?.slash || "").toLowerCase() === slashName);
  if (!aliasMatch) {
    return null;
  }

  return {
    agent: agentRegistry[aliasMatch[1]] || agentRegistry.generalist,
    body: rawRemainder,
    raw: normalized,
  };
}

export function resolveRegisteredAgentFamilyRequest(text = "", {
  includeSlashCommand = true,
  includeKnowledgeSubcommands = false,
  includePersonaStyleMention = false,
} = {}) {
  const normalized = cleanText(text);
  if (!normalized) {
    return null;
  }

  if (includeSlashCommand && normalized.startsWith("/")) {
    const parsed = parseRegisteredAgentCommand(normalized, {
      includeKnowledgeSubcommands,
    });
    if (parsed?.error) {
      return {
        error: parsed.error,
        body: parsed.body || "",
        raw: parsed.raw || normalized,
        surface: "slash_command",
      };
    }
    if (parsed?.agent) {
      return {
        agent: parsed.agent,
        body: parsed.body || "",
        raw: parsed.raw || normalized,
        surface: "slash_command",
      };
    }
  }

  if (includeSlashCommand) {
    const embeddedSlashMatch = [
      ...listRegisteredCoreAgents().map((agent, order) => ({
        agent,
        order,
        slash: agent?.slash || "",
      })),
      ...Object.keys(LEGACY_AGENT_ALIAS_MAP).map((legacyAgentId, order) => ({
        agent: agentRegistry.generalist,
        order: order + listRegisteredCoreAgents().length,
        slash: agentRegistry[legacyAgentId]?.slash || "",
      })),
    ]
      .map((agent, order) => ({
        agent: agent.agent,
        order: agent.order ?? order,
        index: findRegisteredSlashMentionIndex(normalized, agent?.slash || ""),
      }))
      .filter((item) => item.index >= 0)
      .sort((left, right) => left.index - right.index || left.order - right.order)[0];
    if (embeddedSlashMatch?.agent) {
      return {
        agent: embeddedSlashMatch.agent,
        body: normalized,
        raw: normalized,
        surface: "slash_command",
      };
    }
  }

  if (includePersonaStyleMention) {
    const personaMentionRules = [
      /\bconsult(?:\s+agent)?\b/i,
      /\bproduct(?:\s+agent)?\b/i,
      /\bcmo(?:\s+agent)?\b/i,
      /\btech(?:\s+agent)?\b/i,
      /\bceo(?:\s+agent)?\b/i,
      /\bops(?:\s+agent)?\b/i,
      /\bcdo(?:\s+agent)?\b/i,
      /\bdelivery(?:\s+agent)?\b/i,
      /\bprd(?:\s+agent)?\b/i,
    ];
    if (personaMentionRules.some((pattern) => pattern.test(normalized))) {
      return {
        agent: agentRegistry.generalist,
        body: normalized,
        raw: normalized,
        surface: "persona_style_alias",
      };
    }
  }

  return null;
}

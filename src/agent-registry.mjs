import { cleanText } from "./message-intent-utils.mjs";
import { ROUTING_NO_MATCH } from "./planner-error-codes.mjs";

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

function createCoreAgent({
  id,
  slash = "",
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
    kind: "core",
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
});

export const knowledgeAgentSubcommands = Object.freeze([]);

function listRegisteredCoreAgents() {
  return Object.values(agentRegistry);
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

export function listAgentCapabilityMatrix() {
  return listRegisteredAgents().map((agent) => ({
    agent_name: agent.id,
    command: agent.contract?.trigger || agent.slash,
    input_schema: agent.contract?.expected_input_schema || DEFAULT_INPUT_SCHEMA,
    output_schema: agent.contract?.expected_output_schema || DEFAULT_OUTPUT_SCHEMA,
    allowed_tools: agent.contract?.allowed_tools || [],
    downstream_consumer: agent.contract?.downstream_consumer || "lark_reply",
    fallback_behavior: agent.contract?.fallback_behavior || "fail_closed",
    status: agent.contract?.status || "ready",
  }));
}

export function getRegisteredAgent(agentId = "") {
  return agentRegistry[cleanText(agentId)];
}

export function parseRegisteredAgentCommand(text = "") {
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
    return {
      error: ROUTING_NO_MATCH,
      body: rawRemainder,
      raw: normalized,
    };
  }

  const agent = listRegisteredCoreAgents()
    .find((item) => cleanText(item?.slash || "").toLowerCase() === slashName);
  if (!agent) {
    return null;
  }

  return {
    agent,
    body: rawRemainder,
    raw: normalized,
  };
}

export function resolveRegisteredAgentFamilyRequest(text = "", {
  includeSlashCommand = true,
} = {}) {
  const normalized = cleanText(text);
  if (!normalized) {
    return null;
  }

  if (includeSlashCommand && normalized.startsWith("/")) {
    const parsed = parseRegisteredAgentCommand(normalized);
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
    const embeddedSlashMatch = listRegisteredCoreAgents()
      .map((agent, order) => ({
        agent,
        order,
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

  return null;
}

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
  ceo: createCoreAgent({
    id: "ceo",
    slash: "/ceo",
    kind: "persona",
    label: "CEO Agent",
    role: "你是 /ceo agent，負責高層決策整合、優先級判斷、風險與資源權衡。",
    goal: "給出高優先級、決策可用的結論，不要只做摘要。",
    outputContract: "輸出四段：決策建議 / 判斷依據 / 主要風險 / 建議下一步。",
  }),
  product: createCoreAgent({
    id: "product",
    slash: "/product",
    kind: "persona",
    label: "Product Agent",
    role: "你是 /product agent，負責產品問題拆解、使用者價值與優先級判斷。",
    goal: "把需求整理成產品觀點下的問題、機會、範圍與取捨。",
    outputContract: "輸出四段：核心問題 / 使用者價值 / 建議方向 / 待確認。",
  }),
  prd: createCoreAgent({
    id: "prd",
    slash: "/prd",
    kind: "persona",
    label: "PRD Agent",
    role: "你是 /prd agent，負責把需求整理成簡潔 PRD 片段。",
    goal: "用模板化方式產出需求背景、目標、範圍、驗收與風險。",
    outputContract: "輸出固定欄位：背景、目標、範圍、非目標、驗收、風險、待確認。",
  }),
  cmo: createCoreAgent({
    id: "cmo",
    slash: "/cmo",
    kind: "persona",
    label: "CMO Agent",
    role: "你是 /cmo agent，負責市場定位、訊息、內容與成長建議。",
    goal: "把素材整理成可執行的市場/品牌/增長結論。",
    outputContract: "輸出四段：受眾 / 訊息 / 動作建議 / 風險。",
  }),
  consult: createCoreAgent({
    id: "consult",
    slash: "/consult",
    kind: "persona",
    label: "Consult Agent",
    role: "你是 /consult agent，負責結構化診斷、問題拆解與方案比較。",
    goal: "先定義問題，再做方案比較與建議。",
    outputContract: "輸出四段：問題定義 / 觀察 / 方案比較 / 建議。",
  }),
  cdo: createCoreAgent({
    id: "cdo",
    slash: "/cdo",
    kind: "persona",
    label: "CDO Agent",
    role: "你是 /cdo agent，負責資料、營運流程、數位治理與指標設計。",
    goal: "把文件與知識整理成資料治理、流程治理或度量建議。",
    outputContract: "輸出四段：治理目標 / 現況缺口 / 建議指標或流程 / 下一步。",
  }),
  delivery: createCoreAgent({
    id: "delivery",
    slash: "/delivery",
    kind: "persona",
    label: "Delivery Agent",
    role: "你是 delivery_agent，負責交付進度、阻塞與對外交付風險。",
    goal: "輸出以交付為中心的狀態與風險。",
    outputContract: "輸出四段：交付狀態 / 阻塞 / 風險 / 建議行動。",
  }),
  ops: createCoreAgent({
    id: "ops",
    slash: "/ops",
    kind: "persona",
    label: "Ops Agent",
    role: "你是 ops_agent，負責營運流程、SOP 與日常運營問題。",
    goal: "把問題整理成營運可執行步驟。",
    outputContract: "輸出四段：現況 / SOP 建議 / 例外處理 / 下一步。",
  }),
  tech: createCoreAgent({
    id: "tech",
    slash: "/tech",
    kind: "persona",
    label: "Tech Agent",
    role: "你是 tech_agent，負責技術架構、實作風險與工程決策。",
    goal: "給出工程可執行的技術建議。",
    outputContract: "輸出四段：技術判斷 / 方案 / 風險 / 建議執行順序。",
  }),
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

export const knowledgeAgentSubcommands = Object.freeze(
  Object.values(agentRegistry)
    .filter((agent) => agent.kind === "knowledge" && cleanText(agent.subcommand))
    .map((agent) => cleanText(agent.subcommand)),
);

function listRegisteredCoreAgents() {
  return Object.values(agentRegistry).filter((agent) => agent.kind !== "knowledge");
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

  if (includePersonaStyleMention) {
    const personaMentionRules = [
      { id: "consult", pattern: /\bconsult(?:\s+agent)?\b/i },
      { id: "product", pattern: /\bproduct(?:\s+agent)?\b/i },
      { id: "cmo", pattern: /\bcmo(?:\s+agent)?\b/i },
      { id: "tech", pattern: /\btech(?:\s+agent)?\b/i },
      { id: "ceo", pattern: /\bceo(?:\s+agent)?\b/i },
      { id: "ops", pattern: /\bops(?:\s+agent)?\b/i },
      { id: "cdo", pattern: /\bcdo(?:\s+agent)?\b/i },
      { id: "delivery", pattern: /\bdelivery(?:\s+agent)?\b/i },
      { id: "prd", pattern: /\bprd(?:\s+agent)?\b/i },
    ];
    const matchedRule = personaMentionRules.find((rule) => rule.pattern.test(normalized));
    if (matchedRule) {
      const agent = getRegisteredAgent(matchedRule.id);
      if (agent) {
        return {
          agent,
          body: normalized,
          raw: normalized,
          surface: "persona_style",
        };
      }
    }
  }

  return null;
}

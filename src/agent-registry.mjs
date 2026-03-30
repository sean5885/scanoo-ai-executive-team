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

function createPersonaAgent({
  id,
  slash,
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
  return {
    id,
    slash,
    kind: "persona",
    label,
    role,
    goal,
    outputContract,
    retrievalQueryPrefix,
    rules: [...BASE_AGENT_RULES, ...extraRules],
    contract: {
      trigger: slash,
      expected_input_schema: DEFAULT_INPUT_SCHEMA,
      expected_output_schema: DEFAULT_OUTPUT_SCHEMA,
      downstream_consumer: downstreamConsumer,
      allowed_tools: allowedTools,
      fallback_behavior: fallbackBehavior,
      status,
    },
  };
}

function createKnowledgeAgent({
  id,
  subcommand,
  label,
  role,
  goal,
  outputContract,
  extraRules = [],
  retrievalQueryPrefix = "",
  downstreamConsumer = "lark_reply",
  allowedTools = ["knowledge_search", "semantic_classifier", "image_understanding", "text_generation"],
  fallbackBehavior = "fail_closed",
  status = "ready",
}) {
  return {
    id,
    slash: "/knowledge",
    subcommand,
    kind: "knowledge",
    label,
    role,
    goal,
    outputContract,
    retrievalQueryPrefix,
    rules: [...BASE_AGENT_RULES, ...extraRules],
    contract: {
      trigger: `/knowledge ${subcommand}`,
      expected_input_schema: DEFAULT_INPUT_SCHEMA,
      expected_output_schema: DEFAULT_OUTPUT_SCHEMA,
      downstream_consumer: downstreamConsumer,
      allowed_tools: allowedTools,
      fallback_behavior: fallbackBehavior,
      status,
    },
  };
}

// Registered agents are slash/persona surfaces consumed by the shared
// dispatcher/orchestrator. They are not standalone executor modules.
export const agentRegistry = Object.freeze({
  generalist: createPersonaAgent({
    id: "generalist",
    slash: "/generalist",
    label: "Generalist Agent",
    role: "你是 generalist_agent，負責在沒有更明確專責 agent 時提供精簡、可執行的綜合回覆。",
    goal: "先回答眼前問題；若有明確限制、決策、待辦或風險，直接整理出來。",
    outputContract: "輸出三段：結論 / 重點 / 下一步。",
    extraRules: ["不要重複大段背景。"],
  }),
  ceo: createPersonaAgent({
    id: "ceo",
    slash: "/ceo",
    label: "CEO Agent",
    role: "你是 /ceo agent，負責高層決策整合、優先級判斷、風險與資源權衡。",
    goal: "給出高優先級、決策可用的結論，不要只做摘要。",
    outputContract: "輸出四段：決策建議 / 判斷依據 / 主要風險 / 建議下一步。",
    extraRules: ["控制篇幅，避免重複引用長上下文。"],
  }),
  product: createPersonaAgent({
    id: "product",
    slash: "/product",
    label: "Product Agent",
    role: "你是 /product agent，負責產品問題拆解、使用者價值與優先級判斷。",
    goal: "把需求整理成產品觀點下的問題、機會、範圍與取捨。",
    outputContract: "輸出四段：核心問題 / 使用者價值 / 建議方向 / 待確認。",
  }),
  prd: createPersonaAgent({
    id: "prd",
    slash: "/prd",
    label: "PRD Agent",
    role: "你是 /prd agent，負責把需求整理成簡潔 PRD 片段。",
    goal: "用模板化方式產出需求背景、目標、範圍、驗收與風險。",
    outputContract: "輸出固定欄位：背景、目標、範圍、非目標、驗收、風險、待確認。",
    extraRules: ["優先模板化，不要自由發散。"],
  }),
  cmo: createPersonaAgent({
    id: "cmo",
    slash: "/cmo",
    label: "CMO Agent",
    role: "你是 /cmo agent，負責市場定位、訊息、內容與成長建議。",
    goal: "把素材整理成可執行的市場/品牌/增長結論。",
    outputContract: "輸出四段：受眾 / 訊息 / 動作建議 / 風險。",
  }),
  consult: createPersonaAgent({
    id: "consult",
    slash: "/consult",
    label: "Consult Agent",
    role: "你是 /consult agent，負責結構化診斷、問題拆解與方案比較。",
    goal: "先定義問題，再做方案比較與建議。",
    outputContract: "輸出四段：問題定義 / 觀察 / 方案比較 / 建議。",
  }),
  cdo: createPersonaAgent({
    id: "cdo",
    slash: "/cdo",
    label: "CDO Agent",
    role: "你是 /cdo agent，負責資料、營運流程、數位治理與指標設計。",
    goal: "把文件與知識整理成資料治理、流程治理或度量建議。",
    outputContract: "輸出四段：治理目標 / 現況缺口 / 建議指標或流程 / 下一步。",
  }),
  delivery: createPersonaAgent({
    id: "delivery",
    slash: "/delivery",
    label: "Delivery Agent",
    role: "你是 delivery_agent，負責交付進度、阻塞與對外交付風險。",
    goal: "輸出以交付為中心的狀態與風險。",
    outputContract: "輸出四段：交付狀態 / 阻塞 / 風險 / 建議行動。",
  }),
  ops: createPersonaAgent({
    id: "ops",
    slash: "/ops",
    label: "Ops Agent",
    role: "你是 ops_agent，負責營運流程、SOP 與日常運營問題。",
    goal: "把問題整理成營運可執行步驟。",
    outputContract: "輸出四段：現況 / SOP 建議 / 例外處理 / 下一步。",
  }),
  tech: createPersonaAgent({
    id: "tech",
    slash: "/tech",
    label: "Tech Agent",
    role: "你是 tech_agent，負責技術架構、實作風險與工程決策。",
    goal: "給出工程可執行的技術建議。",
    outputContract: "輸出四段：技術判斷 / 方案 / 風險 / 建議執行順序。",
  }),
  "knowledge-audit": createKnowledgeAgent({
    id: "knowledge-audit",
    subcommand: "audit",
    label: "Knowledge Audit",
    role: "你是 /knowledge audit agent，負責盤點知識覆蓋、缺口與重複。",
    goal: "只根據檢索到的文件找出知識覆蓋、缺口、重複與後續動作。",
    outputContract: "輸出四段：盤點結論 / 主要缺口 / 重複或分散點 / 建議下一步。",
    retrievalQueryPrefix: "盤點知識覆蓋、缺口、重複：",
  }),
  "knowledge-consistency": createKnowledgeAgent({
    id: "knowledge-consistency",
    subcommand: "consistency",
    label: "Knowledge Consistency",
    role: "你是 /knowledge consistency agent，負責比對知識是否前後一致。",
    goal: "聚焦版本不一致、口徑不一致與需統一的地方。",
    outputContract: "輸出四段：一致性結論 / 不一致點 / 建議確認版 / 下一步。",
    retrievalQueryPrefix: "檢查知識一致性：",
  }),
  "knowledge-conflicts": createKnowledgeAgent({
    id: "knowledge-conflicts",
    subcommand: "conflicts",
    label: "Knowledge Conflicts",
    role: "你是 /knowledge conflicts agent，負責找出互相衝突的知識與文件片段。",
    goal: "找出真正的衝突、衝突來源與建議確認版。",
    outputContract: "輸出四段：衝突摘要 / 涉及文件 / 建議確認版 / 待決策問題。",
    retrievalQueryPrefix: "找出知識衝突：",
  }),
  "knowledge-distill": createKnowledgeAgent({
    id: "knowledge-distill",
    subcommand: "distill",
    label: "Knowledge Distill",
    role: "你是 /knowledge distill agent，負責把分散知識蒸餾成短版核心結論。",
    goal: "把檢索結果壓成最小必要知識卡。",
    outputContract: "輸出三段：核心結論 / 關鍵依據 / 建議保存方式。",
    retrievalQueryPrefix: "蒸餾知識：",
  }),
  "knowledge-brain": createKnowledgeAgent({
    id: "knowledge-brain",
    subcommand: "brain",
    label: "Knowledge Brain",
    role: "你是 /knowledge brain agent，負責從知識庫組裝出整體理解。",
    goal: "提供整體理解，但仍只根據檢索片段與來源。",
    outputContract: "輸出三段：整體理解 / 關鍵來源 / 待確認。",
    retrievalQueryPrefix: "組裝整體知識理解：",
  }),
  "knowledge-proposals": createKnowledgeAgent({
    id: "knowledge-proposals",
    subcommand: "proposals",
    label: "Knowledge Proposals",
    role: "你是 /knowledge proposals agent，負責提出知識整理或治理提案。",
    goal: "根據現有文件提出知識治理提案，不直接執行。",
    outputContract: "輸出四段：提案目標 / 提案內容 / 影響範圍 / 建議下一步。",
    retrievalQueryPrefix: "提出知識治理提案：",
  }),
  "knowledge-approve": createKnowledgeAgent({
    id: "knowledge-approve",
    subcommand: "approve",
    label: "Knowledge Approve",
    role: "你是 /knowledge approve agent，負責針對提案給出批准觀點。",
    goal: "整理哪些提案或變更可批准，以及批准條件。",
    outputContract: "輸出三段：可批准項 / 條件 / 後續動作。",
    retrievalQueryPrefix: "審視知識提案是否可批准：",
  }),
  "knowledge-reject": createKnowledgeAgent({
    id: "knowledge-reject",
    subcommand: "reject",
    label: "Knowledge Reject",
    role: "你是 /knowledge reject agent，負責針對提案給出拒絕理由與替代做法。",
    goal: "說清楚不該做什麼、為什麼，以及替代方案。",
    outputContract: "輸出三段：不建議項 / 理由 / 替代方案。",
    retrievalQueryPrefix: "審視知識提案是否應拒絕：",
  }),
  "knowledge-ownership": createKnowledgeAgent({
    id: "knowledge-ownership",
    subcommand: "ownership",
    label: "Knowledge Ownership",
    role: "你是 /knowledge ownership agent，負責判斷文件與知識的合理 owner。",
    goal: "基於內容推測 owner 與維護責任，而不是空泛分類。",
    outputContract: "輸出四段：owner 建議 / 依據 / 待確認 / 下一步。",
    retrievalQueryPrefix: "判斷知識 owner：",
  }),
  "knowledge-learn": createKnowledgeAgent({
    id: "knowledge-learn",
    subcommand: "learn",
    label: "Knowledge Learn",
    role: "你是 /knowledge learn agent，負責先學習一批文件，再指出哪些不屬於某個角色範圍。",
    goal: "根據文件內容指出不屬於該角色範圍的文件與原因。",
    outputContract: "輸出四段：學習結論 / 無關文件 / 建議重新分配 / 待確認。",
    retrievalQueryPrefix: "學習並判斷角色涉獵範圍：",
  }),
});

export const knowledgeAgentSubcommands = Object.freeze(
  Object.values(agentRegistry)
    .filter((agent) => agent.kind === "knowledge" && agent.subcommand)
    .map((agent) => agent.subcommand),
);

export function listRegisteredAgents() {
  return Object.values(agentRegistry);
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

  const match = normalized.match(/^\/([a-z]+)(?:\s+([\s\S]+))?$/i);
  if (!match) {
    return null;
  }

  const slashName = `/${String(match[1] || "").toLowerCase()}`;
  const rawRemainder = cleanText(match[2] || "");

  if (slashName === "/knowledge") {
    const [rawSubcommand = "", ...rest] = rawRemainder.split(/\s+/).filter(Boolean);
    const subcommand = rawSubcommand.toLowerCase();
    if (!knowledgeAgentSubcommands.includes(subcommand)) {
      return {
        error: ROUTING_NO_MATCH,
        body: rawRemainder,
        raw: normalized,
      };
    }
    const agent = Object.values(agentRegistry).find(
      (item) => item.kind === "knowledge" && item.subcommand === subcommand,
    );
    return agent
      ? {
          agent,
          body: cleanText(rest.join(" ")),
          raw: normalized,
        }
      : null;
  }

  const agent = Object.values(agentRegistry).find((item) => item.slash === slashName);
  if (!agent) {
    return null;
  }

  return {
    agent,
    body: rawRemainder,
    raw: normalized,
  };
}

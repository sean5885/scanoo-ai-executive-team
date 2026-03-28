import {
  answerMaxContextChars,
  answerCheckpointMaxTokens,
  answerPromptMaxTokens,
  answerRetrievedMaxTokens,
  answerSnippetMaxChars,
  agentPromptEmergencyRatio,
  agentPromptLightRatio,
  agentPromptRollingRatio,
  llmApiKey,
  llmBaseUrl,
  llmModel,
  llmTemperature,
  llmTopP,
  searchTopK,
} from "./config.mjs";
import {
  buildCheckpointSummary,
  buildCompactSystemPrompt,
  governPromptSections,
  trimTextForBudget,
} from "./agent-token-governance.mjs";
import { getWorkflowCheckpoint, updateWorkflowCheckpoint } from "./agent-workflow-state.mjs";
import {
  getReadSourceSnippet,
  getReadSourceTitle,
  getReadSourceUrl,
} from "./read-source-schema.mjs";
import { searchKnowledgeBaseFromRuntime } from "./read-runtime.mjs";
import { callOpenClawTextGeneration } from "./openclaw-text-service.mjs";
import { normalizeText } from "./text-utils.mjs";

export const ANSWER_SYSTEM_PROMPT = buildCompactSystemPrompt("你是 Lark 知識問答助手。", [
  "先直接回答使用者問題，再補來源與待確認項。",
  "回答時引用來源標題與 URL。",
  "不可假裝已調用額外工具、不可假裝已驗證未提供的內容。",
  "若 retrieved_context 不足，明確說明不知道、未確認、或來源未覆蓋，不要補不存在的事實。",
  "回答格式保持穩定：答案、來源、待確認。",
]);

export async function searchKnowledgeBase(
  accountId,
  query,
  limit = searchTopK,
  {
    pathname = "internal:answer_service_search",
    logger = null,
    readerOverrides = null,
  } = {},
) {
  return searchKnowledgeBaseFromRuntime({
    accountId,
    query,
    limit,
    pathname,
    logger,
    readerOverrides,
  });
}

function buildExtractiveAnswer(question, items) {
  const snippets = items.slice(0, 4).map((item, index) => {
    const excerpt = normalizeText(getReadSourceSnippet(item)).slice(0, 280);
    const title = getReadSourceTitle(item) || "未命名來源";
    return `${index + 1}. ${title}: ${excerpt}`;
  });

  const sources = items.slice(0, 4);

  const answer = snippets.length
    ? `根據檢索到的 Lark 知識，和「${question}」最相關的內容如下：\n${snippets.join("\n")}`
    : "目前找不到對應的 Lark 知識內容。";

  return { answer, sources, provider: "extractive" };
}

function buildAnswerSourceBlocks(question, items) {
  const keywords = normalizeText(question).split(/\s+/).filter(Boolean);
  const blocks = [];
  let totalChars = 0;

  for (const item of items) {
    const content = trimTextForBudget(getReadSourceSnippet(item), answerSnippetMaxChars, {
      keywords,
    });
    const title = getReadSourceTitle(item) || "未命名來源";
    const url = getReadSourceUrl(item) || "N/A";
    const block = [
      `Title: ${title}`,
      `URL: ${url}`,
      `Snippet: ${content}`,
    ].join("\n");
    if (totalChars + block.length > answerMaxContextChars) {
      break;
    }
    blocks.push(block);
    totalChars += block.length;
  }

  return blocks;
}

export function buildKnowledgeAnswerPrompt({ question, items, checkpoint = null } = {}) {
  const sourceBlocks = buildAnswerSourceBlocks(question, items);
  const governed = governPromptSections({
    systemPrompt: ANSWER_SYSTEM_PROMPT,
    format: "xml",
    maxTokens: answerPromptMaxTokens,
    thresholds: {
      light: agentPromptLightRatio,
      rolling: agentPromptRollingRatio,
      emergency: agentPromptEmergencyRatio,
    },
    sections: [
      {
        name: "task_goal",
        label: "task_goal",
        text: [
          "回答目前這一輪的 Lark 知識問題。",
          "只可依據提供的來源，不要重複解釋專案背景。",
          "如果來源不足，明確寫出未確認點，不要補不存在的事實。",
          "回答順序固定：先給直接答案，再列來源，最後列待確認或限制。",
          "來源至少寫出標題；有 URL 時一併帶出。",
          "若不同來源之間無法互相印證，明確標示為未完全確認。",
          "不要描述未發生的 tool call，也不要把推測包裝成結論。",
        ].join("\n"),
        required: true,
        maxTokens: 130,
      },
      {
        name: "task_checkpoint",
        label: "task_checkpoint",
        text: checkpoint ? buildCheckpointSummary(checkpoint, { maxChars: answerCheckpointMaxTokens * 4 }) : "",
        summaryText: checkpoint ? buildCheckpointSummary(checkpoint, { maxChars: Math.floor(answerCheckpointMaxTokens * 2.5) }) : "",
        maxTokens: answerCheckpointMaxTokens,
      },
      {
        name: "retrieved_context",
        label: "retrieved_context",
        text: sourceBlocks.join("\n\n---\n\n"),
        summaryText: sourceBlocks
          .map((block) => trimTextForBudget(block, 220, { keywords: normalizeText(question).split(/\s+/) }))
          .join("\n\n"),
        keywords: normalizeText(question).split(/\s+/),
        required: true,
        maxTokens: answerRetrievedMaxTokens,
      },
      {
        name: "user_request",
        label: "user_request",
        text: question,
        required: true,
        maxTokens: 120,
      },
    ],
  });

  return {
    systemPrompt: ANSWER_SYSTEM_PROMPT,
    prompt: governed.prompt,
    governance: governed,
  };
}

async function callChatModel(question, items, { checkpoint = null } = {}) {
  const promptInput = buildKnowledgeAnswerPrompt({ question, items, checkpoint });

  if (!llmApiKey) {
    return {
      answer: await callOpenClawTextGeneration({
        systemPrompt: promptInput.systemPrompt,
        prompt: promptInput.prompt,
        sessionIdSuffix: `knowledge-${normalizeText(question).slice(0, 40) || "answer"}`,
      }),
      provider: `${llmModel} via OpenClaw`,
      governance: promptInput.governance,
    };
  }

  const response = await fetch(`${llmBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${llmApiKey}`,
    },
    body: JSON.stringify({
      model: llmModel,
      temperature: llmTemperature,
      top_p: llmTopP,
      messages: [
        {
          role: "system",
          content: promptInput.systemPrompt,
        },
        {
          role: "user",
          content: promptInput.prompt,
        },
      ],
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `LLM request failed with ${response.status}`);
  }

  return {
    answer: data.choices?.[0]?.message?.content || "",
    provider: llmModel,
    governance: promptInput.governance,
  };
}

export async function answerQuestion(
  accountId,
  question,
  limit = searchTopK,
  {
    workflowStateKey = "",
    logger = null,
    readerOverrides = null,
  } = {},
) {
  const { account, items } = await searchKnowledgeBase(accountId, question, limit, {
    pathname: "internal:answer_question_search",
    logger,
    readerOverrides,
  });
  const checkpoint = workflowStateKey ? await getWorkflowCheckpoint(workflowStateKey) : null;

  if (!items.length) {
    if (workflowStateKey) {
      await updateWorkflowCheckpoint(workflowStateKey, {
        goal: "持續回答這個對話中的 Lark 知識問題。",
        completed: [],
        pending: [],
        constraints: ["只能根據檢索到的 Lark 內容回答", "回答時應保留來源標題與 URL"],
        facts: [],
        risks: ["目前沒有檢索到相關內容"],
        meta: { last_question: question, last_provider: "none" },
      });
    }
    return {
      account,
      answer: "目前找不到對應的 Lark 知識內容。",
      sources: [],
      provider: "none",
    };
  }

  const sources = items.slice(0, limit);

  let generated = null;
  try {
    generated = await callChatModel(question, items, { checkpoint });
  } catch {
    const extractive = buildExtractiveAnswer(question, items);
    if (workflowStateKey) {
      await updateWorkflowCheckpoint(workflowStateKey, {
        goal: "持續回答這個對話中的 Lark 知識問題。",
        completed: [`已回答：${trimTextForBudget(question, 100, { preserveTail: false })}`],
        pending: [],
        constraints: ["只能根據檢索到的 Lark 內容回答", "回答時應保留來源標題與 URL"],
        facts: sources.slice(0, 4).map((item) => `來源：${getReadSourceTitle(item) || item.id}`),
        risks: ["文本生成失敗，已改用檢索摘要保底"],
        meta: { last_question: question, last_provider: "retrieval_summary_fallback" },
      });
    }
    return { account, ...extractive, provider: "retrieval_summary_fallback" };
  }
  if (workflowStateKey) {
    await updateWorkflowCheckpoint(workflowStateKey, {
      goal: "持續回答這個對話中的 Lark 知識問題。",
      completed: [`已回答：${trimTextForBudget(question, 100, { preserveTail: false })}`],
      pending: [],
      constraints: ["只能根據檢索到的 Lark 內容回答", "回答時應保留來源標題與 URL"],
      facts: sources.slice(0, 4).map((item) => `來源：${getReadSourceTitle(item) || item.id}`),
      risks: generated.answer ? [] : ["文本回答為空，需改用檢索摘要或重試"],
      meta: {
        last_question: question,
        last_provider: generated.provider,
        last_governance_stage: generated.governance?.stage || "normal",
      },
    });
  }
  return {
    account,
    answer: generated.answer,
    sources,
    provider: generated.provider,
    context_governance: generated.governance,
  };
}

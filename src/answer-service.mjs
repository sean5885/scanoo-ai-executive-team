import {
  answerMaxContextChars,
  answerCheckpointMaxTokens,
  answerPromptMaxTokens,
  answerRetrievedMaxTokens,
  answerSnippetMaxChars,
  agentPromptEmergencyRatio,
  agentPromptLightRatio,
  agentPromptRollingRatio,
  embeddingSearchTopK,
  llmApiKey,
  llmBaseUrl,
  llmModel,
  searchTopK,
} from "./config.mjs";
import { buildCheckpointSummary, governPromptSections, trimTextForBudget } from "./agent-token-governance.mjs";
import { getWorkflowCheckpoint, updateWorkflowCheckpoint } from "./agent-workflow-state.mjs";
import { getAccountContext, searchChunks, searchChunksBySemantic, searchChunksBySubstring } from "./rag-repository.mjs";
import { normalizeText, toSearchMatchQuery } from "./text-utils.mjs";

export const ANSWER_SYSTEM_PROMPT =
  "You answer questions from a Lark knowledge base. Use only the supplied context, keep the answer concise, and always cite source title and URL.";

function buildSearchCandidates(query) {
  const normalized = normalizeText(query).replace(/[?？!！。]+$/g, "");
  const reduced = normalized
    .replace(/(是什麼|是什么|是啥|有什麼|有什么|有哪些|如何|怎麼|怎么)$/u, "")
    .trim();

  return [...new Set([normalized, reduced].filter(Boolean))];
}

export function searchKnowledgeBase(accountId, query, limit = searchTopK) {
  const accountContext = getAccountContext(accountId);
  if (!accountContext) {
    throw new Error("No authorized Lark account found. Complete OAuth first.");
  }

  const candidates = buildSearchCandidates(query);
  let items = [];
  const merged = new Map();

  for (const candidate of candidates) {
    const ftsItems = searchChunks(accountContext.account.id, toSearchMatchQuery(candidate), limit);
    if (ftsItems.length) {
      for (const item of ftsItems) {
        merged.set(item.id, item);
      }
      break;
    }
  }

  if (!merged.size) {
    for (const candidate of candidates) {
      const semanticItems = searchChunksBySemantic(accountContext.account.id, candidate, embeddingSearchTopK);
      for (const item of semanticItems) {
        merged.set(item.id, item);
      }
      const substringItems = searchChunksBySubstring(accountContext.account.id, candidate, limit);
      if (substringItems.length) {
        for (const item of substringItems) {
          merged.set(item.id, item);
        }
        break;
      }
    }
  }

  items = [...merged.values()].slice(0, limit);

  return {
    account: accountContext.account,
    items,
  };
}

function buildExtractiveAnswer(question, items) {
  const snippets = items.slice(0, 4).map((item, index) => {
    const excerpt = normalizeText(item.content).slice(0, 280);
    return `${index + 1}. ${item.title}: ${excerpt}`;
  });

  const sources = items.slice(0, 4).map((item) => ({
    title: item.title,
    url: item.url,
  }));

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
    const content = trimTextForBudget(item.content, answerSnippetMaxChars, {
      keywords,
    });
    const block = [
      `Title: ${item.title}`,
      `URL: ${item.url || "N/A"}`,
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
        text: "回答目前這一輪的 Lark 知識問題，只能依據提供的來源，不要重複解釋專案背景。",
        required: true,
        maxTokens: 90,
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

  const response = await fetch(`${llmBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${llmApiKey}`,
    },
    body: JSON.stringify({
      model: llmModel,
      temperature: 0.2,
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

export async function answerQuestion(accountId, question, limit = searchTopK, { workflowStateKey = "" } = {}) {
  const { account, items } = searchKnowledgeBase(accountId, question, limit);
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

  const sources = items.slice(0, limit).map((item) => ({
    title: item.title,
    url: item.url,
    source_type: item.source_type,
  }));

  if (!llmApiKey) {
    const extractive = buildExtractiveAnswer(question, items);
    if (workflowStateKey) {
      await updateWorkflowCheckpoint(workflowStateKey, {
        goal: "持續回答這個對話中的 Lark 知識問題。",
        completed: [`已回答：${trimTextForBudget(question, 100, { preserveTail: false })}`],
        pending: [],
        constraints: ["只能根據檢索到的 Lark 內容回答", "回答時應保留來源標題與 URL"],
        facts: sources.slice(0, 4).map((item) => `來源：${item.title}`),
        risks: [],
        meta: { last_question: question, last_provider: "extractive" },
      });
    }
    return { account, ...extractive };
  }

  const generated = await callChatModel(question, items, { checkpoint });
  if (workflowStateKey) {
    await updateWorkflowCheckpoint(workflowStateKey, {
      goal: "持續回答這個對話中的 Lark 知識問題。",
      completed: [`已回答：${trimTextForBudget(question, 100, { preserveTail: false })}`],
      pending: [],
      constraints: ["只能根據檢索到的 Lark 內容回答", "回答時應保留來源標題與 URL"],
      facts: sources.slice(0, 4).map((item) => `來源：${item.title}`),
      risks: generated.answer ? [] : ["LLM 回答為空，需回退 extractive 或重試"],
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

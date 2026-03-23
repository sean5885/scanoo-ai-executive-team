import {
  agentPromptEmergencyRatio,
  agentPromptLightRatio,
  agentPromptRollingRatio,
  answerCheckpointMaxTokens,
  answerPromptMaxTokens,
  answerRetrievedMaxTokens,
  answerSnippetMaxChars,
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
import { renderPlannerUserFacingReplyText } from "./executive-planner.mjs";
import { getWorkflowCheckpoint, updateWorkflowCheckpoint } from "./agent-workflow-state.mjs";
import { searchKnowledgeBase } from "./answer-service.mjs";
import { parseRegisteredAgentCommand } from "./agent-registry.mjs";
import { analyzeImageTask, buildStructuredImageContext } from "./image-understanding-service.mjs";
import { classifyInputModality } from "./modality-router.mjs";
import { buildVisibleMessageText, cleanText } from "./message-intent-utils.mjs";
import { callOpenClawTextGeneration } from "./openclaw-text-service.mjs";
import { FALLBACK_DISABLED, ROUTING_NO_MATCH } from "./planner-error-codes.mjs";
import { normalizeUserResponse } from "./user-response-normalizer.mjs";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  compactError(error) {
    if (!error) {
      return null;
    }
    if (error instanceof Error) {
      return { name: error.name || "Error", message: error.message || "unknown_error" };
    }
    return { message: typeof error === "string" ? error : String(error) };
  },
};

function buildRetrievedContext(question, items = []) {
  const keywords = cleanText(question).split(/\s+/).filter(Boolean);
  return items.slice(0, 6).map((item) => {
    const snippet = trimTextForBudget(item.content, answerSnippetMaxChars, {
      keywords,
    });
    return [
      `Title: ${item.title}`,
      `URL: ${item.url || "N/A"}`,
      `Snippet: ${snippet}`,
    ].join("\n");
  });
}

export function buildRegisteredAgentPrompt({
  agent,
  userRequest,
  items = [],
  checkpoint = null,
  imageContext = "",
  supportingContext = "",
} = {}) {
  const isMergeSynthesis = Boolean(cleanText(supportingContext));
  const systemPrompt = buildCompactSystemPrompt(agent?.role || "你是專責 agent。", [
    "先直接回答使用者真正的問題，再補必要的判斷與下一步。",
    "不要先列 agent 名單、流程、或內部 routing。",
    "沒有足夠證據時，要清楚標記不確定，而不是假裝完成。",
    ...(isMergeSynthesis
      ? [
          "若有 supporting_context，請把補充內容收斂成單一口吻，不要逐段轉述、不要點名其他 agent。",
          "若有 supporting_context，最終輸出固定三段：結論 / 重點 / 下一步。",
        ]
      : []),
    ...(agent?.rules || []),
  ]);
  const sourceBlocks = buildRetrievedContext(userRequest, items);
  const effectiveOutputContract = isMergeSynthesis
    ? "若提供了 supporting_context，請改用單一口吻輸出三段：結論 / 重點 / 下一步。"
    : agent?.outputContract || "";
  const governed = governPromptSections({
    systemPrompt,
    format: "xml",
    maxTokens: answerPromptMaxTokens,
    thresholds: {
      light: agentPromptLightRatio,
      rolling: agentPromptRollingRatio,
      emergency: agentPromptEmergencyRatio,
    },
    sections: [
      {
        name: "agent_goal",
        label: "agent_goal",
        text: [agent?.goal || "", effectiveOutputContract].filter(Boolean).join("\n"),
        required: true,
        maxTokens: 120,
      },
      {
        name: "task_checkpoint",
        label: "task_checkpoint",
        text: checkpoint ? buildCheckpointSummary(checkpoint, { maxChars: answerCheckpointMaxTokens * 4 }) : "",
        summaryText: checkpoint ? buildCheckpointSummary(checkpoint, { maxChars: Math.floor(answerCheckpointMaxTokens * 2.5) }) : "",
        maxTokens: answerCheckpointMaxTokens,
      },
      {
        name: "image_context",
        label: "image_context",
        text: imageContext,
        summaryText: trimTextForBudget(imageContext, 320),
        maxTokens: 180,
      },
      {
        name: "supporting_context",
        label: "supporting_context",
        text: supportingContext,
        summaryText: trimTextForBudget(supportingContext, 420),
        maxTokens: 260,
      },
      {
        name: "retrieved_context",
        label: "retrieved_context",
        text: sourceBlocks.join("\n\n---\n\n"),
        summaryText: sourceBlocks.map((block) => trimTextForBudget(block, 220)).join("\n\n"),
        required: true,
        maxTokens: answerRetrievedMaxTokens,
      },
      {
        name: "user_request",
        label: "user_request",
        text: userRequest,
        required: true,
        maxTokens: 120,
      },
    ],
  });

  return {
    systemPrompt,
    prompt: governed.prompt,
    governance: governed,
  };
}

export async function requestAgentAnswer({
  systemPrompt,
  prompt,
  sessionIdSuffix = "registered-agent",
} = {}) {
  if (!llmApiKey) {
    return callOpenClawTextGeneration({
      systemPrompt,
      prompt,
      sessionIdSuffix,
    });
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
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `agent_dispatch_failed:${response.status}`);
  }
  return data.choices?.[0]?.message?.content || "";
}

function buildSourceFooter(items = []) {
  const topItems = items.slice(0, 3);
  if (!topItems.length) {
    return "";
  }
  return [
    "",
    "來源",
    ...topItems.map((item) => `- ${item.title}${item.url ? `｜${item.url}` : ""}`),
  ].join("\n");
}

function buildRegisteredAgentUserFacingErrorText({
  answer = "",
  limitations = [],
} = {}) {
  const normalized = normalizeUserResponse({
    payload: {
      ok: false,
      answer,
      sources: [],
      limitations,
    },
    logger: noopLogger,
    handlerName: "registeredAgentDispatcher",
  });
  return renderPlannerUserFacingReplyText(normalized);
}

export async function executeRegisteredAgent({
  accountId,
  agent,
  requestText = "",
  scope = {},
  event = null,
  imageContext: initialImageContext = "",
  supportingContext = "",
  searchFn = searchKnowledgeBase,
  textGenerator = requestAgentAnswer,
  logger = noopLogger,
} = {}) {
  if (!accountId || !agent) {
    return null;
  }

  let imageContext = initialImageContext;
  if (!imageContext && event) {
    const modality = classifyInputModality(event);
    if (modality.modality !== "text") {
      const imageAnalysis = await analyzeImageTask({
        task: requestText || modality.text || buildVisibleMessageText(event),
        textContext: buildVisibleMessageText(event),
        imageInputs: modality.imageInputs,
      });
      if (imageAnalysis?.ok) {
        imageContext = buildStructuredImageContext(imageAnalysis);
      }
    }
  }

  const effectiveQuestion = [agent.retrievalQueryPrefix, requestText]
    .filter(Boolean)
    .join(" ");
  const { items = [] } = searchFn(accountId, effectiveQuestion, searchTopK);
  logger.info("registered_agent_search_completed", {
    agent_id: agent.id,
    result_count: items.length,
  });
  const workflowStateKey = `registered-agent:${agent.id}:${cleanText(scope?.session_key || scope?.chat_id || accountId)}`;
  const checkpoint = await getWorkflowCheckpoint(workflowStateKey);

  if (!items.length) {
    await updateWorkflowCheckpoint(workflowStateKey, {
      goal: agent.goal,
      completed: [],
      pending: [`待補更多與 ${agent.label} 相關的文件或上下文`],
      constraints: agent.rules || [],
      facts: [],
      risks: ["目前沒有檢索到可用來源"],
      meta: {
        agent_id: agent.id,
        last_request: requestText,
      },
    });
    return {
      text: [
        `${agent.label} 現在還沒有足夠的來源可以把這題答實。`,
        imageContext ? `我已先看過圖片內容：${trimTextForBudget(imageContext, 180)}` : null,
        supportingContext ? "我也有收到其他角色的補充，但目前還缺可落地的知識來源。" : null,
        `你如果補一兩個關鍵文檔、關鍵詞，或先同步資料，我就能直接接著整理。`,
      ].filter(Boolean).join("\n\n"),
      agentId: agent.id,
      metadata: {
        retrieval_count: 0,
        fallback_used: false,
        image_context_used: Boolean(imageContext),
        supporting_context_used: Boolean(supportingContext),
        source_titles: [],
      },
    };
  }

  const promptInput = buildRegisteredAgentPrompt({
    agent,
    userRequest: requestText,
    items,
    checkpoint,
    imageContext,
    supportingContext,
  });
  let answer = "";
  try {
    logger.info("registered_agent_generation_started", {
      agent_id: agent.id,
    });
    answer = await textGenerator({
      systemPrompt: promptInput.systemPrompt,
      prompt: promptInput.prompt,
      sessionIdSuffix: workflowStateKey,
    });
    logger.info("registered_agent_generation_succeeded", {
      agent_id: agent.id,
    });
  } catch (error) {
    logger.warn("registered_agent_generation_failed", {
      agent_id: agent.id,
      error: logger.compactError(error),
    });
    if (!llmApiKey) {
      const failureEnvelope = {
        ok: false,
        error: FALLBACK_DISABLED,
        details: {
          message: "registered_agent_generation_fallback_disabled",
          agent_id: agent.id,
        },
      };
      return {
        text: buildRegisteredAgentUserFacingErrorText({
          answer: `${agent.label} 這輪暫時沒有可用的生成路徑，所以我先不直接輸出未整理的系統錯誤。`,
          limitations: [
            "內部錯誤已保留在 runtime / log，這裡先不直接暴露 raw JSON 或 trace。",
            "如果你要，我可以先按目前找到的資料替你整理重點，再補上需要確認的缺口。",
          ],
        }),
        agentId: agent.id,
        error: failureEnvelope.error,
        details: failureEnvelope.details,
        metadata: {
          retrieval_count: items.length,
          fallback_used: false,
          image_context_used: Boolean(imageContext),
          supporting_context_used: Boolean(supportingContext),
          source_titles: items.slice(0, 4).map((item) => item.title),
        },
      };
    }
    throw error;
  }

  await updateWorkflowCheckpoint(workflowStateKey, {
    goal: agent.goal,
    completed: [`已處理：${trimTextForBudget(requestText, 120, { preserveTail: false })}`],
    pending: [],
    constraints: agent.rules || [],
    facts: items.slice(0, 4).map((item) => `來源：${item.title}`),
    risks: answer ? [] : ["agent 回答為空"],
    meta: {
      agent_id: agent.id,
      last_request: requestText,
      last_sources: items.slice(0, 3).map((item) => item.title),
      last_image_context: imageContext ? "yes" : "no",
      last_supporting_context: supportingContext ? "yes" : "no",
      last_governance_stage: promptInput.governance?.stage || "normal",
    },
  });

  return {
    text: `${answer}${buildSourceFooter(items)}`,
    agentId: agent.id,
    context_governance: promptInput.governance,
    metadata: {
      retrieval_count: items.length,
      fallback_used: false,
      image_context_used: Boolean(imageContext),
      supporting_context_used: Boolean(supportingContext),
      source_titles: items.slice(0, 4).map((item) => item.title),
    },
  };
}

export async function dispatchRegisteredAgentCommand({ accountId, event, scope }) {
  const rawText = buildVisibleMessageText(event);
  const command = parseRegisteredAgentCommand(rawText);
  if (command?.error === ROUTING_NO_MATCH) {
    const noMatchEnvelope = {
      ok: false,
      error: ROUTING_NO_MATCH,
      details: {
        message: "registered_agent_command_no_match",
      },
    };
    return {
      text: buildRegisteredAgentUserFacingErrorText({
        answer: "這個 slash 指令目前沒有命中任何已註冊的 registered agent。",
        limitations: [
          "請改用已存在的 `/generalist`、`/ceo`、`/product`、`/prd`、`/cmo`、`/consult`、`/cdo`、`/delivery`、`/ops`、`/tech`，或既有 `/knowledge *` 子指令。",
        ],
      }),
      error: noMatchEnvelope.error,
      details: noMatchEnvelope.details,
    };
  }
  if (!command?.agent) {
    return null;
  }

  return executeRegisteredAgent({
    accountId,
    agent: command.agent,
    requestText: command.body || rawText,
    scope,
    event,
  });
}

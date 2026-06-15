import {
  agentPromptEmergencyRatio,
  agentPromptLightRatio,
  agentPromptRollingRatio,
  imageUnderstandingApiKey,
  imageUnderstandingBaseUrl,
  imageUnderstandingMaxResultChars,
  imageUnderstandingModel,
  imageUnderstandingProvider,
  imageUnderstandingPromptMaxTokens,
} from "./config.mjs";
import { compactListItems, governPromptSections, trimTextForBudget } from "./agent-token-governance.mjs";
import { generateText } from "./llm/generate-text.mjs";
import { downloadMessageImage } from "./lark-content.mjs";
import { normalizeText } from "./text-utils.mjs";

function normalizeArray(values, { maxItems = 8, maxItemChars = 120 } = {}) {
  return compactListItems(
    (Array.isArray(values) ? values : []).map((item) => normalizeText(item)).filter(Boolean),
    { maxItems, maxItemChars },
  );
}

function extractJsonPayload(text) {
  const normalized = String(text || "").trim();
  const start = normalized.indexOf("{");
  const end = normalized.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("image_understanding_missing_json_object");
  }
  return JSON.parse(normalized.slice(start, end + 1));
}

function normalizeImageUnderstandingPayload(payload = {}) {
  return {
    detected_objects: normalizeArray(payload.detected_objects, { maxItems: 10, maxItemChars: 80 }),
    scene_summary: trimTextForBudget(payload.scene_summary || "", 240),
    visible_text: trimTextForBudget(payload.visible_text || "", 360),
    key_entities: normalizeArray(payload.key_entities, { maxItems: 10, maxItemChars: 80 }),
    confidence: Number.isFinite(Number(payload.confidence)) ? Number(payload.confidence) : null,
    extracted_notes: normalizeArray(payload.extracted_notes, { maxItems: 10, maxItemChars: 120 }),
  };
}

function buildImageUnderstandingPrompt({ task = "", textContext = "", imageCount = 0 } = {}) {
  const governed = governPromptSections({
    systemPrompt:
      "你是圖片理解助手。先做視覺理解，再輸出精簡且結構化的 JSON；不要長篇解釋，不要虛構圖片中不存在的資訊。",
    format: "xml",
    maxTokens: imageUnderstandingPromptMaxTokens,
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
          "輸出 JSON。",
          '格式：{"detected_objects":["..."],"scene_summary":"...","visible_text":"...","key_entities":["..."],"confidence":0.0,"extracted_notes":["..."]}',
          "若圖片中沒有文字，visible_text 請留空字串。",
          "只保留後續文本推理真正需要的精簡欄位。",
        ].join("\n"),
        required: true,
        maxTokens: 180,
      },
      {
        name: "user_task",
        label: "user_task",
        text: trimTextForBudget(task || textContext || "請理解這些圖片內容", 320),
        required: true,
        maxTokens: 120,
      },
      {
        name: "context_hint",
        label: "context_hint",
        text: `圖片數量：${imageCount}\n補充上下文：${trimTextForBudget(textContext, 500)}`,
        maxTokens: 160,
      },
    ],
  });

  return governed.prompt;
}

function normalizeMimeType(value = "") {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized.startsWith("image/")) {
    return normalized;
  }
  if (normalized.includes("png")) {
    return "image/png";
  }
  if (normalized.includes("jpg") || normalized.includes("jpeg")) {
    return "image/jpeg";
  }
  if (normalized.includes("webp")) {
    return "image/webp";
  }
  if (normalized.includes("gif")) {
    return "image/gif";
  }
  return "application/octet-stream";
}

function normalizeReasonSegment(value = "", maxLength = 120) {
  const normalized = normalizeText(String(value || "")).replace(/\s+/g, "_");
  if (!normalized) {
    return "";
  }
  return normalized.slice(0, maxLength);
}

function normalizeStringList(values = [], { maxItems = 4, maxItemChars = 140 } = {}) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeText(String(value || "")).slice(0, maxItemChars);
    if (!normalized || result.includes(normalized)) {
      continue;
    }
    result.push(normalized);
    if (result.length >= maxItems) {
      break;
    }
  }
  return result;
}

async function fetchRemoteImagePart(url = "") {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`image_fetch_failed:${response.status}`);
  }
  const mimeType = normalizeMimeType(response.headers.get("content-type") || url);
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    inlineData: {
      mimeType,
      data: buffer.toString("base64"),
    },
  };
}

async function buildGeminiImageParts({ imageInputs = [], accessToken = "", tokenType = "user", messageId = "" } = {}) {
  const parts = [];
  const failures = [];
  for (const input of Array.isArray(imageInputs) ? imageInputs : []) {
    try {
      if (input?.kind === "url" && normalizeText(input.value)) {
        parts.push(await fetchRemoteImagePart(input.value));
        continue;
      }
      if (input?.kind === "lark_image_key" && normalizeText(input.value) && accessToken) {
        const downloaded = await downloadMessageImage(accessToken, input.value, tokenType, {
          messageId,
        });
        parts.push({
          inlineData: {
            mimeType: normalizeMimeType(downloaded.mime_type),
            data: downloaded.bytes.toString("base64"),
          },
        });
      }
    } catch (error) {
      failures.push({
        kind: normalizeText(input?.kind || ""),
        reason: normalizeReasonSegment(error instanceof Error ? error.message : String(error)),
      });
    }
  }
  return {
    parts,
    failures,
  };
}

function extractGeminiText(data = {}) {
  return (data.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => part?.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function callNanoBanana({ task = "", textContext = "", imageParts = [] } = {}) {
  const prompt = buildImageUnderstandingPrompt({
    task,
    textContext,
    imageCount: imageParts.length,
  });
  const response = await fetch(
    `${imageUnderstandingBaseUrl}/models/${encodeURIComponent(imageUnderstandingModel)}:generateContent`,
    {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": imageUnderstandingApiKey,
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: `${prompt}\n\n只輸出 JSON，不要 markdown，不要解釋。` },
            ...imageParts,
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        topP: 0.7,
      },
    }),
  },
  );

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `image_understanding_failed:${response.status}`);
  }

  return extractJsonPayload(extractGeminiText(data));
}

async function synthesizeWithTextModel({ task = "", imageResult = null } = {}) {
  if (!imageResult) {
    return {
      answer: "",
      limitations: [],
    };
  }
  const rawText = await generateText({
    systemPrompt: [
      "你是嚴格的圖片理解整合助手。",
      "只能根據已抽取的結構化圖片結果回答。",
      "先回答使用者問題，再補一句到三句必要解讀。",
      "不能把未看見的圖片細節說成已確認。",
      "只輸出單一合法 JSON object。",
    ].join(" "),
    prompt: [
      "任務：根據已抽取的圖片理解結果，直接回答使用者問題。",
      "硬性規則：",
      "- 只能使用下面提供的結構化結果，不可假設圖片中還有未抽取的元素。",
      "- 若證據不足，answer 必須明說「依目前已抽取結果」。",
      "- 不要輸出 Markdown、不要 code fence、不要前後文。",
      '輸出格式：{"answer":"...","limitations":["..."]}',
      "",
      `使用者問題：${trimTextForBudget(task || "請整理這個圖片任務", 320)}`,
      "",
      "結構化圖片結果：",
      JSON.stringify(imageResult),
    ].join("\n"),
    sessionIdSuffix: "image-summary",
    temperature: 0.1,
    topP: 0.75,
  });
  const payload = extractJsonPayload(rawText);
  const answer = trimTextForBudget(payload?.answer || "", imageUnderstandingMaxResultChars);
  if (!answer) {
    throw new Error("multimodal_text_synthesis_missing_answer");
  }
  return {
    answer,
    limitations: normalizeStringList(payload?.limitations),
  };
}

export function buildStructuredImageContext(result = {}) {
  const normalized = normalizeImageUnderstandingPayload(result);
  return [
    normalized.scene_summary ? `scene_summary: ${normalized.scene_summary}` : "",
    normalized.visible_text ? `visible_text: ${normalized.visible_text}` : "",
    normalized.detected_objects.length ? `detected_objects: ${normalized.detected_objects.join("、")}` : "",
    normalized.key_entities.length ? `key_entities: ${normalized.key_entities.join("、")}` : "",
    normalized.extracted_notes.length ? `extracted_notes: ${normalized.extracted_notes.join("、")}` : "",
    normalized.confidence != null ? `confidence: ${normalized.confidence}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function analyzeImageTask({
  task = "",
  textContext = "",
  imageInputs = [],
  accessToken = "",
  tokenType = "user",
  messageId = "",
} = {}) {
  if (imageUnderstandingProvider !== "nano_banana") {
    return {
      ok: false,
      provider: imageUnderstandingProvider,
      reason: `unsupported_image_provider:${imageUnderstandingProvider}`,
      image_count: imageInputs.length,
    };
  }

  if (!imageUnderstandingApiKey || !imageUnderstandingBaseUrl || !imageUnderstandingModel) {
    return {
      ok: false,
      provider: imageUnderstandingProvider,
      reason: "missing_nano_banana_config",
      image_count: imageInputs.length,
    };
  }

  const imageBuild = await buildGeminiImageParts({
    imageInputs,
    accessToken,
    tokenType,
    messageId,
  });
  const imageParts = Array.isArray(imageBuild?.parts) ? imageBuild.parts : [];
  const imageFailures = Array.isArray(imageBuild?.failures) ? imageBuild.failures : [];

  if (!imageParts.length) {
    const firstFailure = imageFailures[0];
    return {
      ok: false,
      provider: imageUnderstandingProvider,
      reason: firstFailure?.reason
        ? `image_input_unavailable:${firstFailure.reason}`
        : "missing_accessible_images",
      image_count: imageInputs.length,
      input_failure_count: imageFailures.length,
    };
  }

  let raw = null;
  try {
    raw = await callNanoBanana({
      task,
      textContext,
      imageParts,
    });
  } catch (error) {
    return {
      ok: false,
      provider: imageUnderstandingProvider,
      reason: normalizeReasonSegment(error instanceof Error ? error.message : String(error))
        || "image_understanding_call_failed",
      image_count: imageInputs.length,
      input_failure_count: imageFailures.length,
    };
  }
  const normalized = normalizeImageUnderstandingPayload(raw);
  let textSummary = "";
  let synthesisLimitations = [];
  try {
    const synthesized = await synthesizeWithTextModel({
      task,
      imageResult: normalized,
    });
    textSummary = normalizeText(synthesized?.answer || "");
    synthesisLimitations = Array.isArray(synthesized?.limitations) ? synthesized.limitations : [];
  } catch {
    textSummary = "";
    synthesisLimitations = [];
  }

  return {
    ok: true,
    provider: imageUnderstandingProvider,
    model: imageUnderstandingModel,
    image_count: imageInputs.length,
    input_failure_count: imageFailures.length,
    ...normalized,
    text_summary: textSummary,
    synthesis_limitations: synthesisLimitations,
  };
}

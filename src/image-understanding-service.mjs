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
  llmApiKey,
  llmBaseUrl,
  llmModel,
  llmTemperature,
  llmTopP,
} from "./config.mjs";
import { compactListItems, governPromptSections, trimTextForBudget } from "./agent-token-governance.mjs";
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

async function buildGeminiImageParts({ imageInputs = [], accessToken = "", tokenType = "user" } = {}) {
  const parts = [];
  for (const input of Array.isArray(imageInputs) ? imageInputs : []) {
    if (input?.kind === "url" && normalizeText(input.value)) {
      parts.push(await fetchRemoteImagePart(input.value));
      continue;
    }
    if (input?.kind === "lark_image_key" && normalizeText(input.value) && accessToken) {
      const downloaded = await downloadMessageImage(accessToken, input.value, tokenType);
      parts.push({
        inlineData: {
          mimeType: normalizeMimeType(downloaded.mime_type),
          data: downloaded.bytes.toString("base64"),
        },
      });
    }
  }
  return parts;
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
  if (!llmApiKey || !imageResult) {
    return "";
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
          content: "你是文本整合助手。只根據結構化圖片結果回答，輸出短結論與短重點，不要重複整段欄位。",
        },
        {
          role: "user",
          content: [
            `任務：${task || "請整理這個圖片任務"}`,
            "結構化圖片結果：",
            JSON.stringify(imageResult),
          ].join("\n"),
        },
      ],
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `multimodal_text_synthesis_failed:${response.status}`);
  }
  return trimTextForBudget(data.choices?.[0]?.message?.content || "", imageUnderstandingMaxResultChars);
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

  const imageParts = await buildGeminiImageParts({
    imageInputs,
    accessToken,
    tokenType,
  });

  if (!imageParts.length) {
    return {
      ok: false,
      provider: imageUnderstandingProvider,
      reason: "missing_accessible_images",
      image_count: imageInputs.length,
    };
  }

  const raw = await callNanoBanana({
    task,
    textContext,
    imageParts,
  });
  const normalized = normalizeImageUnderstandingPayload(raw);
  const textSummary = await synthesizeWithTextModel({
    task,
    imageResult: normalized,
  });

  return {
    ok: true,
    provider: imageUnderstandingProvider,
    model: imageUnderstandingModel,
    image_count: imageInputs.length,
    ...normalized,
    text_summary: textSummary,
  };
}

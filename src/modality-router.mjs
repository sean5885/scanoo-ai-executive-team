import { cleanText, safeParseJson } from "./message-intent-utils.mjs";

const imageSignalKeys = new Set([
  "image",
  "images",
  "image_key",
  "image_keys",
  "image_url",
  "image_urls",
  "image_list",
  "photo",
  "photos",
  "picture",
  "pictures",
  "screenshot",
  "screenshots",
]);

const imageTaskSignals = [
  "圖片",
  "图片",
  "圖像",
  "图像",
  "看圖",
  "看图",
  "截圖",
  "截图",
  "照片",
  "相片",
  "白板",
  "海報",
  "海报",
  "ocr",
  "辨識",
  "辨识",
  "識別",
  "识别",
  "圖片內容",
  "图片内容",
  "圖中",
  "图中",
  "附圖",
  "附图",
  "附件圖片",
  "附件图片",
];

function pushImageRef(bucket, ref) {
  const value = cleanText(ref?.value);
  const kind = cleanText(ref?.kind);
  if (!value || !kind) {
    return;
  }
  const key = `${kind}:${value}`;
  if (bucket.some((item) => `${item.kind}:${item.value}` === key)) {
    return;
  }
  bucket.push({ kind, value });
}

function looksLikeImageUrl(value = "") {
  return /^https?:\/\/\S+/i.test(value) && /\.(png|jpe?g|webp|gif|bmp|heic|heif)(?:\?|#|$)/i.test(value);
}

function collectImageRefs(value, bucket = [], parentKey = "") {
  if (!value) {
    return bucket;
  }

  if (typeof value === "string") {
    const text = value.trim();
    if (!text) {
      return bucket;
    }
    const normalizedKey = parentKey.toLowerCase();
    if (looksLikeImageUrl(text)) {
      pushImageRef(bucket, { kind: "url", value: text });
    } else if (imageSignalKeys.has(normalizedKey)) {
      pushImageRef(bucket, {
        kind: normalizedKey.includes("url") ? "url" : "lark_image_key",
        value: text,
      });
    }
    return bucket;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectImageRefs(item, bucket, parentKey);
    }
    return bucket;
  }

  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      collectImageRefs(nested, bucket, key);
    }
  }

  return bucket;
}

function collectRawContent(input = {}) {
  return (
    cleanText(input.content) ||
    cleanText(input.message?.content) ||
    cleanText(input.event?.message?.content) ||
    ""
  );
}

export function extractImageInputs(input = {}) {
  const rawContent = collectRawContent(input);
  const parsedContent = safeParseJson(rawContent);
  const bucket = [];

  if (parsedContent) {
    collectImageRefs(parsedContent, bucket);
  }

  collectImageRefs(input, bucket);
  return bucket;
}

export function looksLikeImageTask(text = "") {
  const normalized = cleanText(String(text || "").toLowerCase());
  return Boolean(normalized) && imageTaskSignals.some((signal) => normalized.includes(signal.toLowerCase()));
}

export function classifyInputModality(input = {}) {
  const text = cleanText(
    input.text || input.message_text || input.message?.text || input.event?.message_text || "",
  );
  const imageInputs = extractImageInputs(input);
  const hasImages = imageInputs.length > 0 || cleanText(input.msg_type || input.message?.msg_type).toLowerCase() === "image";
  const wantsImageTask = looksLikeImageTask(text);

  if (hasImages && text) {
    return {
      modality: "multimodal",
      imageInputs,
      text,
      wantsImageTask,
    };
  }

  if (hasImages || wantsImageTask) {
    return {
      modality: "image",
      imageInputs,
      text,
      wantsImageTask,
    };
  }

  return {
    modality: "text",
    imageInputs: [],
    text,
    wantsImageTask: false,
  };
}

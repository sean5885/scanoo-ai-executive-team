import {
  buildVisibleMessageText,
  cleanText,
  extractAttachmentObjects,
  safeParseJson,
} from "./message-intent-utils.mjs";

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

const pdfSignalKeys = new Set([
  "file",
  "files",
  "file_key",
  "file_keys",
  "file_token",
  "file_tokens",
  "attachment",
  "attachments",
  "file_name",
  "filename",
  "mime",
  "mime_type",
  "content_type",
  "ext",
  "extension",
  "url",
  "link",
  "href",
]);

const pdfTaskSignals = [
  "pdf",
  "附件",
  "附件檔",
  "附件档",
  "文件檔",
  "文件档",
  "文件附件",
  "讀 pdf",
  "读 pdf",
  "看 pdf",
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

function looksLikePdfUrl(value = "") {
  return /^https?:\/\/\S+/i.test(value) && /\.pdf(?:\?|#|$)/i.test(value);
}

function looksLikeOfficeUrl(value = "") {
  return /^https?:\/\/\S+/i.test(value)
    && /\.(?:docx?|docm|dotx|dotm|xlsx?|xlsm|xltx|xltm|pptx?|pptm|potx|potm)(?:\?|#|$)/i.test(value);
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

function pushPdfRef(bucket, ref) {
  const value = cleanText(ref?.value);
  const kind = cleanText(ref?.kind);
  if (!value || !kind) {
    return;
  }
  const key = `${kind}:${value}`;
  if (bucket.some((item) => `${item.kind}:${item.value}` === key)) {
    return;
  }
  bucket.push({
    kind,
    value,
    name: cleanText(ref?.name),
    mime: cleanText(ref?.mime).toLowerCase(),
    ext: cleanText(ref?.ext).toLowerCase(),
  });
}

function collectPdfRefs(value, bucket = [], parentKey = "") {
  if (!value) {
    return bucket;
  }

  if (typeof value === "string") {
    const text = value.trim();
    if (!text) {
      return bucket;
    }
    const normalizedKey = parentKey.toLowerCase();
    if (looksLikePdfUrl(text)) {
      pushPdfRef(bucket, { kind: "url", value: text, ext: "pdf", mime: "application/pdf" });
      return bucket;
    }
    if (pdfSignalKeys.has(normalizedKey) && /\.pdf$/i.test(text)) {
      pushPdfRef(bucket, { kind: normalizedKey, value: text, ext: "pdf", mime: "application/pdf" });
    }
    return bucket;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectPdfRefs(item, bucket, parentKey);
    }
    return bucket;
  }

  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      collectPdfRefs(nested, bucket, key);
    }
  }

  return bucket;
}

function inferOfficeAttachmentKind({ name = "", mime = "", ext = "" } = {}) {
  const normalizedName = cleanText(name).toLowerCase();
  const normalizedMime = cleanText(mime).toLowerCase();
  const normalizedExt = cleanText(ext).toLowerCase();
  const effectiveExt = normalizedExt || (normalizedName.match(/\.([a-z0-9]{1,12})(?:$|[?#])/i)?.[1] || "").toLowerCase();

  if (["doc", "docx", "docm", "dotx", "dotm"].includes(effectiveExt) || /wordprocessingml|msword/.test(normalizedMime)) {
    return { ext: effectiveExt || "docx", fileKind: "document" };
  }
  if (["xls", "xlsx", "xlsm", "xltx", "xltm"].includes(effectiveExt) || /spreadsheetml|excel|sheet/.test(normalizedMime)) {
    return { ext: effectiveExt || "xlsx", fileKind: "spreadsheet" };
  }
  if (["ppt", "pptx", "pptm", "potx", "potm"].includes(effectiveExt) || /presentationml|powerpoint/.test(normalizedMime)) {
    return { ext: effectiveExt || "pptx", fileKind: "presentation" };
  }
  return { ext: effectiveExt, fileKind: "" };
}

function pushOfficeRef(bucket, ref) {
  const value = cleanText(ref?.value);
  const kind = cleanText(ref?.kind);
  const fileKind = cleanText(ref?.fileKind);
  if (!value || !kind || !fileKind) {
    return;
  }
  const key = `${kind}:${value}`;
  if (bucket.some((item) => `${item.kind}:${item.value}` === key)) {
    return;
  }
  bucket.push({
    kind,
    value,
    name: cleanText(ref?.name),
    mime: cleanText(ref?.mime).toLowerCase(),
    ext: cleanText(ref?.ext).toLowerCase(),
    fileKind,
  });
}

function collectOfficeRefs(value, bucket = [], parentKey = "") {
  if (!value) {
    return bucket;
  }

  if (typeof value === "string") {
    const text = value.trim();
    if (!text) {
      return bucket;
    }
    const normalizedKey = parentKey.toLowerCase();
    if (looksLikeOfficeUrl(text)) {
      const inferred = inferOfficeAttachmentKind({ name: text, ext: text });
      pushOfficeRef(bucket, {
        kind: "url",
        value: text,
        ext: inferred.ext,
        fileKind: inferred.fileKind,
      });
      return bucket;
    }
    return bucket;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectOfficeRefs(item, bucket, parentKey);
    }
    return bucket;
  }

  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      collectOfficeRefs(nested, bucket, key);
    }
  }

  return bucket;
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

export function looksLikePdfTask(text = "") {
  const normalized = cleanText(String(text || "").toLowerCase());
  return Boolean(normalized) && pdfTaskSignals.some((signal) => normalized.includes(signal.toLowerCase()));
}

export function extractPdfInputs(input = {}) {
  const rawContent = collectRawContent(input);
  const parsedContent = safeParseJson(rawContent);
  const bucket = [];

  if (parsedContent) {
    collectPdfRefs(parsedContent, bucket);
  }
  collectPdfRefs(input, bucket);

  const attachmentObjects = extractAttachmentObjects(input);
  for (const attachment of attachmentObjects) {
    const mime = cleanText(attachment?.mime).toLowerCase();
    const ext = cleanText(attachment?.ext).toLowerCase();
    const isPdf = mime === "application/pdf" || ext === "pdf";
    if (!isPdf) {
      continue;
    }
    if (attachment.file_token) {
      pushPdfRef(bucket, {
        kind: "lark_file_token",
        value: attachment.file_token,
        name: attachment.name,
        mime,
        ext: ext || "pdf",
      });
    }
    if (attachment.file_key) {
      pushPdfRef(bucket, {
        kind: "lark_file_key",
        value: attachment.file_key,
        name: attachment.name,
        mime,
        ext: ext || "pdf",
      });
    }
  }

  return bucket;
}

export function extractOfficeInputs(input = {}) {
  const rawContent = collectRawContent(input);
  const parsedContent = safeParseJson(rawContent);
  const bucket = [];

  if (parsedContent) {
    collectOfficeRefs(parsedContent, bucket);
  }
  collectOfficeRefs(input, bucket);

  const attachmentObjects = extractAttachmentObjects(input);
  for (const attachment of attachmentObjects) {
    const inferred = inferOfficeAttachmentKind({
      name: attachment?.name,
      mime: attachment?.mime,
      ext: attachment?.ext,
    });
    if (!inferred.fileKind || inferred.ext === "pdf") {
      continue;
    }
    if (attachment.file_token) {
      pushOfficeRef(bucket, {
        kind: "lark_file_token",
        value: attachment.file_token,
        name: attachment.name,
        mime: attachment.mime,
        ext: inferred.ext,
        fileKind: inferred.fileKind,
      });
    }
    if (attachment.file_key) {
      pushOfficeRef(bucket, {
        kind: "lark_file_key",
        value: attachment.file_key,
        name: attachment.name,
        mime: attachment.mime,
        ext: inferred.ext,
        fileKind: inferred.fileKind,
      });
    }
  }

  return bucket;
}

export function classifyInputModality(input = {}) {
  const msgType = cleanText(
    input.msg_type || input.message?.msg_type || input.event?.message?.msg_type || "",
  ).toLowerCase();
  const directText = cleanText(
    input.text
    || input.message_text
    || input.message?.text
    || input.event?.message_text
    || "",
  );
  const visibleFallbackText = (directText || (msgType && !["text", "post"].includes(msgType)))
    ? ""
    : cleanText(buildVisibleMessageText(input));
  const text = cleanText(
    directText || visibleFallbackText || "",
  );
  const imageInputs = extractImageInputs(input);
  const pdfInputs = extractPdfInputs(input);
  const officeInputs = extractOfficeInputs(input);
  const hasImages = imageInputs.length > 0 || cleanText(input.msg_type || input.message?.msg_type).toLowerCase() === "image";
  const hasPdf = pdfInputs.length > 0;
  const hasOffice = officeInputs.length > 0;
  const wantsImageTask = looksLikeImageTask(text);
  const wantsPdfTask = looksLikePdfTask(text);

  if (hasPdf && text) {
    return {
      modality: "pdf_multimodal",
      imageInputs,
      pdfInputs,
      officeInputs: [],
      text,
      wantsImageTask,
      wantsPdfTask,
    };
  }

  if (hasPdf || wantsPdfTask) {
    return {
      modality: "pdf",
      imageInputs: [],
      pdfInputs,
      officeInputs: [],
      text,
      wantsImageTask: false,
      wantsPdfTask,
    };
  }

  if (hasOffice && text) {
    return {
      modality: "office_multimodal",
      imageInputs: [],
      pdfInputs: [],
      officeInputs,
      text,
      wantsImageTask: false,
      wantsPdfTask: false,
    };
  }

  if (hasOffice) {
    return {
      modality: "office",
      imageInputs: [],
      pdfInputs: [],
      officeInputs,
      text,
      wantsImageTask: false,
      wantsPdfTask: false,
    };
  }

  if (hasImages && text) {
    return {
      modality: "multimodal",
      imageInputs,
      pdfInputs: [],
      officeInputs: [],
      text,
      wantsImageTask,
      wantsPdfTask: false,
    };
  }

  if (hasImages || wantsImageTask) {
    return {
      modality: "image",
      imageInputs,
      pdfInputs: [],
      officeInputs: [],
      text,
      wantsImageTask,
      wantsPdfTask: false,
    };
  }

  return {
    modality: "text",
    imageInputs: [],
    pdfInputs: [],
    officeInputs: [],
    text,
    wantsImageTask: false,
    wantsPdfTask: false,
  };
}

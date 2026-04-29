import { cleanText } from "./message-intent-utils.mjs";

function toBuffer(bytes) {
  if (!bytes) {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(bytes)) {
    return bytes;
  }
  if (bytes instanceof Uint8Array) {
    return Buffer.from(bytes);
  }
  return Buffer.alloc(0);
}

function decodePdfLiteralString(raw = "") {
  return cleanText(
    String(raw || "")
      .replace(/\\\(/g, "(")
      .replace(/\\\)/g, ")")
      .replace(/\\\\/g, "\\")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\n")
      .replace(/\\t/g, "\t"),
  );
}

function extractLiteralFragments(pdfText = "") {
  const fragments = [];
  const simpleMatches = pdfText.matchAll(/\((?:\\.|[^\\()])*\)\s*Tj/g);
  for (const match of simpleMatches) {
    const literal = String(match[0] || "").replace(/\s*Tj$/, "");
    const value = decodePdfLiteralString(literal.slice(1, -1));
    if (value) {
      fragments.push(value);
    }
  }

  const arrayMatches = pdfText.matchAll(/\[(.*?)\]\s*TJ/gs);
  for (const match of arrayMatches) {
    const group = String(match[1] || "");
    const arrayLiterals = group.matchAll(/\((?:\\.|[^\\()])*\)/g);
    for (const item of arrayLiterals) {
      const value = decodePdfLiteralString(String(item[0] || "").slice(1, -1));
      if (value) {
        fragments.push(value);
      }
    }
  }
  return fragments;
}

function countPdfPages(pdfText = "") {
  const matches = pdfText.match(/\/Type\s*\/Page\b/g);
  return matches ? matches.length : 0;
}

function buildPageText(fragments = [], pageCount = 0) {
  const normalizedFragments = (Array.isArray(fragments) ? fragments : []).filter(Boolean);
  if (!normalizedFragments.length) {
    return [];
  }
  const normalizedPageCount = Math.max(1, Number(pageCount) || 1);
  const bucketSize = Math.max(1, Math.ceil(normalizedFragments.length / normalizedPageCount));
  const pages = [];
  for (let page = 1; page <= normalizedPageCount; page += 1) {
    const start = (page - 1) * bucketSize;
    const text = cleanText(normalizedFragments.slice(start, start + bucketSize).join("\n"));
    if (!text) {
      continue;
    }
    pages.push({
      page,
      text,
    });
  }
  if (!pages.length) {
    return [{
      page: 1,
      text: cleanText(normalizedFragments.join("\n")),
    }].filter((item) => item.text);
  }
  return pages;
}

export async function extract({
  bytes = null,
  fileName = "",
  mimeType = "application/pdf",
  ocrRunner = null,
} = {}) {
  const buffer = toBuffer(bytes);
  const raw = buffer.toString("latin1");
  const isPdf = raw.startsWith("%PDF-");
  if (!isPdf || buffer.length === 0) {
    return {
      ok: false,
      text: "",
      pages: [],
      page_count: 0,
      extraction_mode: "none",
      evidence: [],
      file_name: cleanText(fileName || ""),
      mime_type: cleanText(mimeType || ""),
    };
  }

  const fragments = extractLiteralFragments(raw);
  const pageCount = countPdfPages(raw);
  const pageText = buildPageText(fragments, pageCount);
  let text = cleanText(pageText.map((item) => item.text).join("\n\n"));
  let extractionMode = "text";
  let pages = pageText;

  if (!text && typeof ocrRunner === "function") {
    const ocrResult = await ocrRunner({
      bytes: buffer,
      fileName: cleanText(fileName || ""),
      mimeType: cleanText(mimeType || "application/pdf"),
    });
    const ocrText = cleanText(ocrResult?.text || "");
    if (ocrText) {
      extractionMode = "ocr_fallback";
      text = ocrText;
      pages = Array.isArray(ocrResult?.pages)
        ? ocrResult.pages
          .map((item) => ({
            page: Number.isInteger(item?.page) ? item.page : null,
            text: cleanText(item?.text || ""),
          }))
          .filter((item) => Number.isInteger(item.page) && item.page > 0 && item.text)
        : [{
            page: 1,
            text: ocrText,
          }];
    }
  }

  return {
    ok: Boolean(text),
    text,
    pages,
    page_count: pageCount > 0 ? pageCount : pages.length,
    extraction_mode: text ? extractionMode : "none",
    evidence: text
      ? [{
          type: "tool_output",
          summary: extractionMode === "ocr_fallback"
            ? "pdf_text_extracted_via_ocr_fallback"
            : "pdf_text_extracted",
        }]
      : [],
    file_name: cleanText(fileName || ""),
    mime_type: cleanText(mimeType || ""),
  };
}

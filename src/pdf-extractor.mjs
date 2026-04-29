import { cleanText } from "./message-intent-utils.mjs";

export const PDF_EXTRACTOR_VERSION = "pdf-min-v1";

function normalizeBytes(input = null) {
  if (Buffer.isBuffer(input)) {
    return input;
  }
  if (input instanceof Uint8Array) {
    return Buffer.from(input);
  }
  if (input instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(input));
  }
  if (typeof input === "string") {
    return Buffer.from(input, "base64");
  }
  return Buffer.alloc(0);
}

function decodePdfEscapedString(value = "") {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    if (current !== "\\") {
      result += current;
      continue;
    }
    const next = value[index + 1];
    if (next == null) {
      continue;
    }
    if (/[0-7]/.test(next)) {
      const octal = value.slice(index + 1, index + 4).match(/^[0-7]{1,3}/)?.[0] || "";
      if (octal) {
        result += String.fromCharCode(Number.parseInt(octal, 8));
        index += octal.length;
        continue;
      }
    }
    if (next === "n") {
      result += "\n";
      index += 1;
      continue;
    }
    if (next === "r") {
      result += "\r";
      index += 1;
      continue;
    }
    if (next === "t") {
      result += "\t";
      index += 1;
      continue;
    }
    result += next;
    index += 1;
  }
  return result;
}

function decodeHexPdfString(value = "") {
  const normalized = value.replace(/[^0-9a-f]/gi, "");
  if (!normalized) {
    return "";
  }
  const padded = normalized.length % 2 === 0
    ? normalized
    : `${normalized}0`;
  return Buffer.from(padded, "hex").toString("utf8");
}

function normalizeExtractedText(value = "") {
  return cleanText(
    String(value || "")
      .replace(/\u0000/g, "")
      .replace(/\s+/g, " "),
  );
}

function extractFromTextOperators(pdfText = "") {
  const collected = [];
  const directMatches = pdfText.matchAll(/\((?<text>(?:\\.|[^\\)])*)\)\s*Tj\b/g);
  for (const match of directMatches) {
    const decoded = normalizeExtractedText(decodePdfEscapedString(match.groups?.text || ""));
    if (decoded) {
      collected.push(decoded);
    }
  }

  const hexMatches = pdfText.matchAll(/<(?<hex>[0-9a-fA-F\s]+)>\s*Tj\b/g);
  for (const match of hexMatches) {
    const decoded = normalizeExtractedText(decodeHexPdfString(match.groups?.hex || ""));
    if (decoded) {
      collected.push(decoded);
    }
  }

  const arrayMatches = pdfText.matchAll(/\[(?<items>[^\]]+)\]\s*TJ\b/gs);
  for (const match of arrayMatches) {
    const items = match.groups?.items || "";
    const segments = [];
    for (const segment of items.matchAll(/\((?<text>(?:\\.|[^\\)])*)\)|<(?<hex>[0-9a-fA-F\s]+)>/g)) {
      if (segment.groups?.text != null) {
        const decoded = normalizeExtractedText(decodePdfEscapedString(segment.groups.text));
        if (decoded) {
          segments.push(decoded);
        }
        continue;
      }
      if (segment.groups?.hex != null) {
        const decoded = normalizeExtractedText(decodeHexPdfString(segment.groups.hex));
        if (decoded) {
          segments.push(decoded);
        }
      }
    }
    const combined = normalizeExtractedText(segments.join(" "));
    if (combined) {
      collected.push(combined);
    }
  }

  return normalizeExtractedText(collected.join("\n"));
}

function extractPlainReadableSegments(pdfText = "") {
  const rejectedPattern = /^(?:%PDF-|xref$|trailer$|startxref$|\d+\s+\d+\s+obj\b|endobj$|stream$|endstream$)|\/Type\s*\/Page\b/i;
  const candidates = pdfText
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ")
    .split(/\r?\n/)
    .map((line) => normalizeExtractedText(line))
    .filter((line) =>
      line.length >= 8
      && /[a-zA-Z\u4e00-\u9fff0-9]/.test(line)
      && !rejectedPattern.test(line),
    );
  return normalizeExtractedText(candidates.join("\n"));
}

function countPdfPages(pdfText = "") {
  const matches = pdfText.match(/\/Type\s*\/Page\b/g);
  return Array.isArray(matches) ? matches.length : 0;
}

export async function extract({
  bytes = null,
  fileName = "",
  mimeType = "",
} = {}) {
  const normalizedBytes = normalizeBytes(bytes);
  const warnings = [];
  if (!normalizedBytes.length) {
    return {
      text: "",
      page_count: 0,
      warnings: ["empty_pdf_bytes"],
      extractor_version: PDF_EXTRACTOR_VERSION,
    };
  }

  const pdfText = normalizedBytes.toString("latin1");
  const pageCount = countPdfPages(pdfText);
  let text = extractFromTextOperators(pdfText);
  if (!text) {
    warnings.push("pdf_text_operators_not_found");
    text = extractPlainReadableSegments(pdfText);
  }
  if (!text) {
    warnings.push("pdf_text_extraction_empty");
  }
  if (!cleanText(fileName)) {
    warnings.push("pdf_filename_missing");
  }
  if (cleanText(mimeType) && cleanText(mimeType).toLowerCase() !== "application/pdf") {
    warnings.push("pdf_mime_not_application_pdf");
  }

  return {
    text,
    page_count: pageCount,
    warnings,
    extractor_version: PDF_EXTRACTOR_VERSION,
  };
}

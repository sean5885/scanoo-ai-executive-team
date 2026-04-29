import { cleanText } from "./message-intent-utils.mjs";
import { extract } from "./pdf-extractor.mjs";
import { buildPdfChunks } from "./pdf-retriever.mjs";
import { buildPdfAnswer } from "./pdf-answer.mjs";

function buildDirectPdfBytes(pageTexts = []) {
  const normalizedPages = (Array.isArray(pageTexts) ? pageTexts : []).map((item) => cleanText(item || "")).filter(Boolean);
  const safePages = normalizedPages.length > 0 ? normalizedPages : ["PDF fallback content"];
  const pageObjects = safePages.map((_, index) => `${index + 2} 0 obj\n<< /Type /Page >>\nendobj`).join("\n");
  const textStream = safePages
    .map((text, index) => `BT /F1 12 Tf 72 ${720 - (index * 24)} Td (${String(text).replace(/[()\\]/g, "")}) Tj ET`)
    .join("\n");
  const payload = [
    "%PDF-1.4",
    "1 0 obj",
    "<< /Type /Catalog /Pages 2 0 R >>",
    "endobj",
    pageObjects,
    "40 0 obj",
    `<< /Length ${Buffer.byteLength(textStream, "latin1")} >>`,
    "stream",
    textStream,
    "endstream",
    "endobj",
    "trailer",
    "<< /Root 1 0 R >>",
    "%%EOF",
  ].join("\n");
  return Buffer.from(payload, "latin1");
}

function buildScannedLikePdfBytes({ pageCount = 1 } = {}) {
  const normalizedPageCount = Math.max(1, Number(pageCount) || 1);
  const pageObjects = Array.from({ length: normalizedPageCount }, (_, index) => (
    `${index + 2} 0 obj\n<< /Type /Page >>\nendobj`
  )).join("\n");
  const payload = [
    "%PDF-1.4",
    "1 0 obj",
    "<< /Type /Catalog /Pages 2 0 R >>",
    "endobj",
    pageObjects,
    "30 0 obj",
    "<< /Length 20 >>",
    "stream",
    "q 100 0 0 100 0 0 cm",
    "Q",
    "endstream",
    "endobj",
    "trailer",
    "<< /Root 1 0 R >>",
    "%%EOF",
  ].join("\n");
  return Buffer.from(payload, "latin1");
}

export function buildPdfAcceptanceCases({
  directCount = 45,
  ocrFallbackCount = 10,
} = {}) {
  const cases = [];

  for (let index = 0; index < Math.max(0, Number(directCount) || 0); index += 1) {
    const pageTexts = [
      `Case ${index + 1} onboarding checklist owner evidence acceptance token ${index + 1}`,
    ];
    cases.push({
      id: `pdf-direct-${String(index + 1).padStart(3, "0")}`,
      mode: "text",
      bytes: buildDirectPdfBytes(pageTexts),
      ocrText: "",
      question: "請整理這份 PDF 的重點",
      sourceUrl: `https://example.local/pdf/direct/${index + 1}.pdf`,
    });
  }

  for (let index = 0; index < Math.max(0, Number(ocrFallbackCount) || 0); index += 1) {
    cases.push({
      id: `pdf-ocr-${String(index + 1).padStart(3, "0")}`,
      mode: "ocr_fallback",
      bytes: buildScannedLikePdfBytes({ pageCount: 1 }),
      ocrText: `Scanned case ${index + 1} recovered via OCR with acceptance evidence`,
      question: "這份掃描檔提到哪些驗收重點",
      sourceUrl: `https://example.local/pdf/ocr/${index + 1}.pdf`,
    });
  }

  return cases;
}

export async function runPdfAcceptanceEval({
  cases = null,
  maxSources = 3,
} = {}) {
  const normalizedCases = Array.isArray(cases) ? cases : buildPdfAcceptanceCases();
  const failures = [];
  const details = [];
  let ingestPass = 0;
  let retrievePass = 0;
  let answerPass = 0;
  let totalPass = 0;

  for (const item of normalizedCases) {
    const ocrRunner = cleanText(item?.mode) === "ocr_fallback"
      ? async () => ({
          text: cleanText(item?.ocrText || ""),
          pages: [{
            page: 1,
            text: cleanText(item?.ocrText || ""),
          }],
        })
      : async () => ({ text: "", pages: [] });
    const extracted = await extract({
      bytes: item?.bytes || Buffer.alloc(0),
      fileName: `${cleanText(item?.id || "case")}.pdf`,
      mimeType: "application/pdf",
      ocrRunner,
    });
    const ingestOk = Boolean(extracted?.ok && cleanText(extracted?.text));
    const expectedMode = cleanText(item?.mode || "text");
    const modeOk = expectedMode === "ocr_fallback"
      ? cleanText(extracted?.extraction_mode) === "ocr_fallback"
      : cleanText(extracted?.extraction_mode) === "text";
    const ingestStagePass = ingestOk && modeOk;
    if (ingestStagePass) {
      ingestPass += 1;
    }

    const chunks = buildPdfChunks({
      extracted,
      documentId: cleanText(item?.id || ""),
      title: cleanText(item?.id || ""),
      sourceUrl: cleanText(item?.sourceUrl || ""),
      chunkOptions: {
        targetSize: 180,
        overlap: 24,
      },
    });
    const retrieveStagePass = chunks.length > 0 && chunks.every((chunk) => (
      Number.isInteger(chunk?.metadata?.pdf_page)
      && chunk.metadata.pdf_page > 0
      && cleanText(chunk?.metadata?.pdf_chunk_url).includes("#page=")
    ));
    if (retrieveStagePass) {
      retrievePass += 1;
    }

    const answer = buildPdfAnswer({
      question: cleanText(item?.question || "請總結這份 PDF"),
      chunks,
      maxSources,
    });
    const answerStagePass = Array.isArray(answer?.sources)
      && answer.sources.length > 0
      && answer.sources.some((line) => /#page=|第\d+頁/u.test(cleanText(line)));
    if (answerStagePass) {
      answerPass += 1;
    }

    const casePass = ingestStagePass && retrieveStagePass && answerStagePass;
    if (casePass) {
      totalPass += 1;
    } else {
      failures.push(cleanText(item?.id || "unknown_case"));
    }

    details.push({
      id: cleanText(item?.id || "unknown_case"),
      mode: expectedMode,
      ingest_pass: ingestStagePass,
      retrieve_pass: retrieveStagePass,
      answer_pass: answerStagePass,
      pass: casePass,
    });
  }

  const totalCases = normalizedCases.length;
  const rate = totalCases > 0 ? Number((totalPass / totalCases).toFixed(4)) : 0;
  const ingestRate = totalCases > 0 ? Number((ingestPass / totalCases).toFixed(4)) : 0;
  const retrieveRate = totalCases > 0 ? Number((retrievePass / totalCases).toFixed(4)) : 0;
  const answerRate = totalCases > 0 ? Number((answerPass / totalCases).toFixed(4)) : 0;

  return {
    version: "pdf_acceptance_eval_v1",
    total_cases: totalCases,
    pass_count: totalPass,
    success_rate: rate,
    ingest_success_rate: ingestRate,
    retrieve_success_rate: retrieveRate,
    answer_success_rate: answerRate,
    required_min_cases: 50,
    required_success_rate_min: 0.9,
    sample_ready: totalCases >= 50,
    pass: totalCases >= 50 && rate >= 0.9,
    failed_case_ids: failures,
    details,
  };
}

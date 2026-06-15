import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { cleanText } from "./message-intent-utils.mjs";

const DEFAULT_OUTPUT_ROOT = path.resolve(process.cwd(), ".data/exports/bp");
const MAX_BRIEF_CHARS = 12_000;
const MAX_BULLETS_PER_SLIDE = 5;
const MAX_SLIDES = 10;

function slugify(value = "") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "bp";
}

function extractJsonObject(text = "") {
  const normalized = String(text || "").trim();
  const start = normalized.indexOf("{");
  const end = normalized.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("bp_model_missing_json_object");
  }
  return JSON.parse(normalized.slice(start, end + 1));
}

function normalizeParagraph(value = "", { maxChars = 1200 } = {}) {
  return cleanText(String(value || "")).slice(0, maxChars);
}

function normalizeStringList(values = [], { maxItems = 6, maxItemChars = 180 } = {}) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeParagraph(value, { maxChars: maxItemChars });
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

function normalizeSlideList(values = []) {
  const slides = [];
  for (const value of Array.isArray(values) ? values : []) {
    const title = normalizeParagraph(value?.title || "", { maxChars: 80 });
    const bullets = normalizeStringList(value?.bullets, {
      maxItems: MAX_BULLETS_PER_SLIDE,
      maxItemChars: 120,
    });
    const speakerNotes = normalizeParagraph(value?.speaker_notes || value?.speakerNotes || "", {
      maxChars: 600,
    });
    if (!title || !bullets.length) {
      continue;
    }
    slides.push({
      title,
      bullets,
      speaker_notes: speakerNotes,
    });
    if (slides.length >= MAX_SLIDES) {
      break;
    }
  }
  return slides;
}

function buildFallbackSlides(plan = {}) {
  const fallback = [
    ["執行摘要", [plan.executive_summary]],
    ["市場痛點", [plan.problem]],
    ["解決方案", [plan.solution]],
    ["市場與客群", [plan.market, plan.target_customer]],
    ["商業模式", [plan.business_model]],
    ["成長策略", [plan.go_to_market]],
    ["競品與差異化", [plan.competition]],
    ["里程碑與募資需求", [plan.roadmap, plan.funding_ask]],
  ];
  return fallback
    .map(([title, items]) => ({
      title,
      bullets: normalizeStringList(items, { maxItems: 4, maxItemChars: 120 }),
      speaker_notes: "",
    }))
    .filter((item) => item.bullets.length > 0)
    .slice(0, MAX_SLIDES);
}

function normalizeBusinessPlanPayload(payload = {}, input = {}) {
  const companyName = normalizeParagraph(
    payload?.company_name || payload?.companyName || input.companyName || "",
    { maxChars: 80 },
  );
  const title = normalizeParagraph(payload?.title || `${companyName || "新創專案"}商業計畫書`, {
    maxChars: 120,
  });
  const normalized = {
    company_name: companyName || "未命名專案",
    title,
    subtitle: normalizeParagraph(payload?.subtitle || payload?.tagline || "", { maxChars: 140 }),
    executive_summary: normalizeParagraph(payload?.executive_summary || "", { maxChars: 1200 }),
    problem: normalizeParagraph(payload?.problem || "", { maxChars: 1200 }),
    solution: normalizeParagraph(payload?.solution || "", { maxChars: 1200 }),
    target_customer: normalizeParagraph(payload?.target_customer || payload?.targetCustomer || "", { maxChars: 600 }),
    market: normalizeParagraph(payload?.market || "", { maxChars: 1200 }),
    competition: normalizeParagraph(payload?.competition || "", { maxChars: 1200 }),
    business_model: normalizeParagraph(payload?.business_model || payload?.businessModel || "", { maxChars: 1200 }),
    go_to_market: normalizeParagraph(payload?.go_to_market || payload?.goToMarket || "", { maxChars: 1200 }),
    traction: normalizeParagraph(payload?.traction || "", { maxChars: 1200 }),
    financial_plan: normalizeParagraph(payload?.financial_plan || payload?.financialPlan || "", { maxChars: 1200 }),
    roadmap: normalizeParagraph(payload?.roadmap || "", { maxChars: 1200 }),
    risks: normalizeParagraph(payload?.risks || "", { maxChars: 1200 }),
    funding_ask: normalizeParagraph(payload?.funding_ask || payload?.fundingAsk || "", { maxChars: 1200 }),
    next_steps: normalizeStringList(payload?.next_steps || payload?.nextSteps, { maxItems: 5, maxItemChars: 140 }),
    slides: normalizeSlideList(payload?.slides),
  };

  if (!normalized.slides.length) {
    normalized.slides = buildFallbackSlides(normalized);
  }

  return normalized;
}

function buildBusinessPlanPrompt({
  brief = "",
  companyName = "",
  audience = "",
  goal = "",
  tone = "",
  language = "zh-TW",
} = {}) {
  const normalizedBrief = normalizeParagraph(brief, { maxChars: MAX_BRIEF_CHARS });
  const normalizedCompanyName = normalizeParagraph(companyName, { maxChars: 80 });
  const normalizedAudience = normalizeParagraph(audience, { maxChars: 80 }) || "潛在投資人";
  const normalizedGoal = normalizeParagraph(goal, { maxChars: 120 }) || "產出可直接拿去溝通的 BP 與簡報骨架";
  const normalizedTone = normalizeParagraph(tone, { maxChars: 80 }) || "專業、清楚、投資人導向";
  const normalizedLanguage = normalizeParagraph(language, { maxChars: 20 }) || "zh-TW";

  return [
    "任務：根據以下 brief 產出一份可直接拿去整理成 BP 文件與簡報的結構化商業計畫。",
    "硬性規則：",
    "- 只能輸出單一合法 JSON object，不要 Markdown、不要 code fence、不要前後文。",
    "- 內容必須聚焦商業計畫，不要寫成一般文章。",
    "- 以繁體中文輸出。",
    "- 若 brief 缺少數字或證據，文字要保守，避免假裝已有 traction 或財務數據。",
    "- slides 需為 6 到 10 張，每張 3 到 5 個 bullet，bullet 要短。",
    'JSON schema: {"company_name":"","title":"","subtitle":"","executive_summary":"","problem":"","solution":"","target_customer":"","market":"","competition":"","business_model":"","go_to_market":"","traction":"","financial_plan":"","roadmap":"","risks":"","funding_ask":"","next_steps":[""],"slides":[{"title":"","bullets":[""],"speaker_notes":""}]}',
    "",
    `語言：${normalizedLanguage}`,
    `公司名稱：${normalizedCompanyName || "未提供"}`,
    `目標受眾：${normalizedAudience}`,
    `產出目標：${normalizedGoal}`,
    `語氣：${normalizedTone}`,
    "",
    "Brief：",
    normalizedBrief,
  ].join("\n");
}

async function resolveGenerateTextFn(generateTextFn) {
  if (typeof generateTextFn === "function") {
    return generateTextFn;
  }
  const module = await import("./llm/generate-text.mjs");
  return module.generateText;
}

async function generateBusinessPlan({
  brief = "",
  companyName = "",
  audience = "",
  goal = "",
  tone = "",
  language = "zh-TW",
  generateTextFn = null,
  signal = null,
} = {}) {
  const normalizedBrief = normalizeParagraph(brief, { maxChars: MAX_BRIEF_CHARS });
  if (!normalizedBrief) {
    throw new Error("bp_brief_missing");
  }
  const generateText = await resolveGenerateTextFn(generateTextFn);
  const rawText = await generateText({
    systemPrompt: "你是嚴格的商業計畫顧問，只能輸出單一 JSON object。",
    prompt: buildBusinessPlanPrompt({
      brief: normalizedBrief,
      companyName,
      audience,
      goal,
      tone,
      language,
    }),
    sessionIdSuffix: "bp-export",
    temperature: 0.1,
    topP: 0.75,
    signal,
  });
  const payload = extractJsonObject(rawText);
  return normalizeBusinessPlanPayload(payload, {
    companyName,
  });
}

export function buildBusinessPlanMarkdown(plan = {}) {
  const sections = [
    ["執行摘要", plan.executive_summary],
    ["痛點", plan.problem],
    ["解決方案", plan.solution],
    ["目標客群", plan.target_customer],
    ["市場機會", plan.market],
    ["競品與差異化", plan.competition],
    ["商業模式", plan.business_model],
    ["成長策略", plan.go_to_market],
    ["進展與驗證", plan.traction],
    ["財務規劃", plan.financial_plan],
    ["里程碑", plan.roadmap],
    ["主要風險", plan.risks],
    ["募資需求", plan.funding_ask],
  ];
  const lines = [
    `# ${plan.title || "商業計畫書"}`,
    plan.subtitle ? `> ${plan.subtitle}` : "",
    "",
  ];

  for (const [heading, content] of sections) {
    const normalized = normalizeParagraph(content, { maxChars: 1200 });
    if (!normalized) {
      continue;
    }
    lines.push(`## ${heading}`);
    lines.push(normalized);
    lines.push("");
  }

  if (Array.isArray(plan.next_steps) && plan.next_steps.length) {
    lines.push("## 下一步");
    for (const item of plan.next_steps) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  if (Array.isArray(plan.slides) && plan.slides.length) {
    lines.push("## 簡報骨架");
    for (const slide of plan.slides) {
      lines.push(`### ${slide.title}`);
      for (const bullet of slide.bullets) {
        lines.push(`- ${bullet}`);
      }
      if (slide.speaker_notes) {
        lines.push(`註解：${slide.speaker_notes}`);
      }
      lines.push("");
    }
  }

  return `${lines.filter((line, index, bucket) => (
    line !== "" || bucket[index - 1] !== ""
  )).join("\n").trim()}\n`;
}

async function writeDocxArtifact(filePath, plan) {
  const docx = await import("docx");
  const {
    AlignmentType,
    Document,
    HeadingLevel,
    Packer,
    Paragraph,
    TextRun,
  } = docx;
  const doc = new Document({
    sections: [{
      properties: {
        page: {
          margin: {
            top: 1440,
            right: 1440,
            bottom: 1440,
            left: 1440,
          },
        },
      },
      children: [
        new Paragraph({
          alignment: AlignmentType.LEFT,
          spacing: { after: 120 },
          children: [
            new TextRun({
              text: plan.title || "商業計畫書",
              size: 32,
              bold: true,
              color: "1F3A5F",
            }),
          ],
        }),
        ...(plan.subtitle ? [new Paragraph({
          spacing: { after: 220 },
          children: [
            new TextRun({
              text: plan.subtitle,
              italics: true,
              color: "4A5568",
            }),
          ],
        })] : []),
        ...buildDocxBodyChildren({
          HeadingLevel,
          Paragraph,
          TextRun,
          plan,
        }),
      ],
    }],
  });
  const buffer = await Packer.toBuffer(doc);
  await fsp.writeFile(filePath, buffer);
}

function buildDocxBodyChildren({
  HeadingLevel,
  Paragraph,
  TextRun,
  plan,
} = {}) {
  const sections = [
    ["執行摘要", plan.executive_summary],
    ["痛點", plan.problem],
    ["解決方案", plan.solution],
    ["目標客群", plan.target_customer],
    ["市場機會", plan.market],
    ["競品與差異化", plan.competition],
    ["商業模式", plan.business_model],
    ["成長策略", plan.go_to_market],
    ["進展與驗證", plan.traction],
    ["財務規劃", plan.financial_plan],
    ["里程碑", plan.roadmap],
    ["主要風險", plan.risks],
    ["募資需求", plan.funding_ask],
  ];
  const children = [];
  for (const [heading, content] of sections) {
    const normalized = normalizeParagraph(content, { maxChars: 1200 });
    if (!normalized) {
      continue;
    }
    children.push(new Paragraph({
      text: heading,
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 240, after: 120 },
    }));
    children.push(new Paragraph({
      spacing: { after: 160 },
      children: [new TextRun({ text: normalized })],
    }));
  }
  if (Array.isArray(plan.next_steps) && plan.next_steps.length) {
    children.push(new Paragraph({
      text: "下一步",
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 240, after: 120 },
    }));
    for (const item of plan.next_steps) {
      children.push(new Paragraph({
        text: item,
        bullet: { level: 0 },
        spacing: { after: 80 },
      }));
    }
  }
  return children;
}

async function writePdfArtifact(filePath, plan) {
  const { default: PDFDocument } = await import("pdfkit");
  await new Promise((resolve, reject) => {
    const document = new PDFDocument({
      margin: 50,
      size: "LETTER",
    });
    const stream = fs.createWriteStream(filePath);
    document.pipe(stream);

    document.fontSize(22).fillColor("#1F3A5F").text(plan.title || "商業計畫書");
    if (plan.subtitle) {
      document.moveDown(0.3);
      document.fontSize(11).fillColor("#4A5568").text(plan.subtitle);
    }
    document.moveDown(0.8);

    const sections = [
      ["執行摘要", plan.executive_summary],
      ["痛點", plan.problem],
      ["解決方案", plan.solution],
      ["目標客群", plan.target_customer],
      ["市場機會", plan.market],
      ["競品與差異化", plan.competition],
      ["商業模式", plan.business_model],
      ["成長策略", plan.go_to_market],
      ["進展與驗證", plan.traction],
      ["財務規劃", plan.financial_plan],
      ["里程碑", plan.roadmap],
      ["主要風險", plan.risks],
      ["募資需求", plan.funding_ask],
    ];

    for (const [heading, content] of sections) {
      const normalized = normalizeParagraph(content, { maxChars: 1200 });
      if (!normalized) {
        continue;
      }
      document.fontSize(14).fillColor("#1F3A5F").text(heading);
      document.moveDown(0.2);
      document.fontSize(11).fillColor("#111827").text(normalized, {
        align: "left",
      });
      document.moveDown(0.6);
    }

    if (Array.isArray(plan.next_steps) && plan.next_steps.length) {
      document.fontSize(14).fillColor("#1F3A5F").text("下一步");
      document.moveDown(0.2);
      document.fontSize(11).fillColor("#111827");
      for (const item of plan.next_steps) {
        document.text(`• ${item}`);
      }
      document.moveDown(0.6);
    }

    document.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

async function writePptxArtifact(filePath, plan) {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const deck = new PptxGenJS();
  deck.layout = "LAYOUT_WIDE";
  deck.author = "Lobster";
  deck.company = "Lobster";
  deck.subject = plan.title || "商業計畫書";
  deck.title = plan.title || "商業計畫書";
  deck.lang = "zh-TW";
  deck.theme = {
    headFontFace: "Arial",
    bodyFontFace: "Arial",
    lang: "zh-TW",
  };

  const cover = deck.addSlide();
  cover.background = { color: "FFFFFF" };
  cover.addText(plan.title || "商業計畫書", {
    x: 0.7, y: 0.7, w: 11.2, h: 0.7,
    fontSize: 24,
    bold: true,
    color: "1F3A5F",
  });
  if (plan.subtitle) {
    cover.addText(plan.subtitle, {
      x: 0.75, y: 1.55, w: 10.8, h: 0.45,
      fontSize: 11,
      color: "4A5568",
      italic: true,
    });
  }

  for (const slidePlan of Array.isArray(plan.slides) ? plan.slides : []) {
    const slide = deck.addSlide();
    slide.background = { color: "FFFFFF" };
    slide.addText(slidePlan.title, {
      x: 0.7, y: 0.45, w: 11.3, h: 0.5,
      fontSize: 22,
      bold: true,
      color: "1F3A5F",
    });
    slide.addText(
      slidePlan.bullets.map((bullet) => ({
        text: bullet,
        options: { bullet: { indent: 18 } },
      })),
      {
        x: 0.95, y: 1.25, w: 10.8, h: 4.8,
        fontSize: 17,
        color: "111827",
        breakLine: true,
        margin: 0.08,
        paraSpaceAfterPt: 10,
        valign: "top",
      },
    );
    if (slidePlan.speaker_notes) {
      slide.addText(`備註：${slidePlan.speaker_notes}`, {
        x: 0.95, y: 6.2, w: 10.5, h: 0.5,
        fontSize: 9,
        color: "6B7280",
        italic: true,
      });
    }
  }

  await deck.writeFile({ fileName: filePath });
}

async function writeBusinessPlanArtifacts({
  outputDir,
  fileBaseName,
  plan,
} = {}) {
  await fsp.mkdir(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, `${fileBaseName}.json`);
  const markdownPath = path.join(outputDir, `${fileBaseName}.md`);
  const docxPath = path.join(outputDir, `${fileBaseName}.docx`);
  const pdfPath = path.join(outputDir, `${fileBaseName}.pdf`);
  const pptxPath = path.join(outputDir, `${fileBaseName}.pptx`);
  await fsp.writeFile(jsonPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  await fsp.writeFile(markdownPath, buildBusinessPlanMarkdown(plan), "utf8");
  await writeDocxArtifact(docxPath, plan);
  await writePdfArtifact(pdfPath, plan);
  await writePptxArtifact(pptxPath, plan);
  return {
    export_dir: outputDir,
    json_path: jsonPath,
    markdown_path: markdownPath,
    docx_path: docxPath,
    pdf_path: pdfPath,
    pptx_path: pptxPath,
  };
}

export async function generateBusinessPlanArtifacts({
  brief = "",
  companyName = "",
  audience = "",
  goal = "",
  tone = "",
  language = "zh-TW",
  outputRoot = DEFAULT_OUTPUT_ROOT,
  outputDir = "",
  fileBaseName = "",
  generateTextFn = null,
  signal = null,
} = {}) {
  const plan = await generateBusinessPlan({
    brief,
    companyName,
    audience,
    goal,
    tone,
    language,
    generateTextFn,
    signal,
  });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const basename = slugify(fileBaseName || plan.company_name || plan.title);
  const resolvedOutputDir = outputDir || path.join(outputRoot, `${basename}-${timestamp}`);
  const artifacts = await writeBusinessPlanArtifacts({
    outputDir: resolvedOutputDir,
    fileBaseName: basename,
    plan,
  });
  return {
    brief: normalizeParagraph(brief, { maxChars: MAX_BRIEF_CHARS }),
    plan,
    artifacts,
  };
}

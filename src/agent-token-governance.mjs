import { normalizeText } from "./text-utils.mjs";

const DEFAULT_THRESHOLDS = {
  light: 0.6,
  rolling: 0.75,
  emergency: 0.85,
};

function uniqueLines(lines = []) {
  const seen = new Set();
  const result = [];
  for (const line of lines) {
    const normalized = normalizeText(line);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function estimateTokenCount(value = "") {
  const text = normalizeText(value);
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

export function trimTextForBudget(value, maxChars = 400, { keywords = [], preserveTail = true } = {}) {
  const text = normalizeText(value);
  if (!text || text.length <= maxChars) {
    return text;
  }

  const normalizedKeywords = uniqueLines(keywords)
    .map((item) => item.toLowerCase())
    .filter(Boolean);
  const lines = text.split("\n").map((item) => item.trim()).filter(Boolean);
  const priorityLines = [];
  const headingLines = lines.filter((line) => /^#{1,6}\s|^[-*]\s|^\d+\.\s/.test(line));
  const keywordLines = lines.filter((line) =>
    normalizedKeywords.some((keyword) => keyword && line.toLowerCase().includes(keyword)),
  );
  priorityLines.push(...headingLines, ...keywordLines, ...lines.slice(0, 6));

  const compact = [];
  let currentLength = 0;
  for (const line of uniqueLines(priorityLines)) {
    if (currentLength + line.length + 1 > Math.max(80, maxChars - 24)) {
      break;
    }
    compact.push(line);
    currentLength += line.length + 1;
  }

  const headWindow = text.slice(0, Math.max(60, Math.floor(maxChars * 0.55))).trim();
  const tailWindow = preserveTail ? text.slice(-Math.max(40, Math.floor(maxChars * 0.2))).trim() : "";
  const summaryLines = uniqueLines([...compact, headWindow, tailWindow].filter(Boolean));
  const joined = summaryLines.join("\n");
  if (joined.length <= maxChars) {
    return joined;
  }
  return `${joined.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

export function compactListItems(items = [], { maxItems = 8, maxItemChars = 160 } = {}) {
  const normalized = Array.isArray(items) ? items : [];
  const head = normalized.slice(0, maxItems).map((item) => trimTextForBudget(item, maxItemChars));
  if (normalized.length <= maxItems) {
    return head.filter(Boolean);
  }
  return [...head.filter(Boolean), `... 另有 ${normalized.length - maxItems} 項已省略`];
}

export function buildCheckpointSummary(checkpoint = {}, { maxChars = 900 } = {}) {
  const sections = [
    ["目標", checkpoint.goal || ""],
    ["已完成", compactListItems(checkpoint.completed, { maxItems: 6, maxItemChars: 120 }).join("\n")],
    ["未完成", compactListItems(checkpoint.pending, { maxItems: 6, maxItemChars: 120 }).join("\n")],
    ["關鍵約束", compactListItems(checkpoint.constraints, { maxItems: 6, maxItemChars: 120 }).join("\n")],
    ["已確認事實", compactListItems(checkpoint.facts, { maxItems: 6, maxItemChars: 120 }).join("\n")],
    ["風險與待確認", compactListItems(checkpoint.risks, { maxItems: 6, maxItemChars: 120 }).join("\n")],
  ];

  const raw = sections
    .filter(([, value]) => normalizeText(value))
    .map(([title, value]) => `${title}:\n${value}`)
    .join("\n\n");

  return trimTextForBudget(raw, maxChars, { preserveTail: false });
}

function compactSection(section, stage, maxChars) {
  const fullText = normalizeText(section.text || "");
  const summaryText = normalizeText(section.summaryText || "");

  if (!fullText && !summaryText) {
    return "";
  }

  if (stage === "normal") {
    return trimTextForBudget(fullText || summaryText, maxChars, { keywords: section.keywords || [] });
  }

  if (stage === "light") {
    return trimTextForBudget(summaryText || fullText, maxChars, { keywords: section.keywords || [] });
  }

  if (stage === "rolling") {
    return trimTextForBudget(summaryText || fullText, Math.min(maxChars, section.rollingMaxChars || maxChars), {
      keywords: section.keywords || [],
    });
  }

  return section.required
    ? trimTextForBudget(summaryText || fullText, Math.min(maxChars, section.emergencyMaxChars || maxChars), {
        keywords: section.keywords || [],
      })
    : "";
}

export function governPromptSections({
  systemPrompt = "",
  sections = [],
  maxTokens = 1600,
  thresholds = DEFAULT_THRESHOLDS,
} = {}) {
  const normalizedSections = Array.isArray(sections) ? sections : [];
  const baseSections = normalizedSections.map((section) => ({
    ...section,
    text: normalizeText(section.text || ""),
    summaryText: normalizeText(section.summaryText || ""),
  }));

  const rawPrompt = baseSections
    .filter((section) => section.text)
    .map((section) => `${section.label}:\n${section.text}`)
    .join("\n\n");
  const rawTokens = estimateTokenCount(`${systemPrompt}\n${rawPrompt}`);
  const ratio = maxTokens > 0 ? rawTokens / maxTokens : 0;
  const stage =
    ratio >= thresholds.emergency
      ? "emergency"
      : ratio >= thresholds.rolling
        ? "rolling"
        : ratio >= thresholds.light
          ? "light"
          : "normal";

  const activeSections = [];
  let totalChars = 0;
  const maxChars = maxTokens * 4;

  for (const section of baseSections) {
    const sectionBudgetChars =
      (section.maxTokens ? section.maxTokens * 4 : 0) ||
      (section.required ? Math.floor(maxChars * 0.32) : Math.floor(maxChars * 0.18));
    const compacted = compactSection(section, stage, sectionBudgetChars);
    if (!compacted) {
      continue;
    }
    const block = `${section.label}:\n${compacted}`;
    if (!section.required && totalChars + block.length > maxChars) {
      continue;
    }
    activeSections.push({
      name: section.name,
      label: section.label,
      text: compacted,
      required: Boolean(section.required),
      rawTokens: estimateTokenCount(section.text || section.summaryText || ""),
      finalTokens: estimateTokenCount(compacted),
    });
    totalChars += block.length + 2;
  }

  const prompt = activeSections.map((section) => `${section.label}:\n${section.text}`).join("\n\n");
  return {
    stage,
    rawTokens,
    finalTokens: estimateTokenCount(`${systemPrompt}\n${prompt}`),
    prompt,
    sections: activeSections,
  };
}

export function compactToolPayload(payload, options = {}) {
  const {
    maxDepth = 3,
    maxArrayItems = 8,
    maxStringChars = 220,
  } = options;

  function visit(value, depth) {
    if (value == null) {
      return value;
    }
    if (typeof value === "string") {
      return trimTextForBudget(value, maxStringChars);
    }
    if (typeof value !== "object") {
      return value;
    }
    if (depth >= maxDepth) {
      if (Array.isArray(value)) {
        return { _summary: `array(${value.length})` };
      }
      return { _summary: `object(${Object.keys(value).length})` };
    }
    if (Array.isArray(value)) {
      const items = value.slice(0, maxArrayItems).map((item) => visit(item, depth + 1));
      if (value.length > maxArrayItems) {
        items.push({ _truncated_items: value.length - maxArrayItems });
      }
      return items;
    }
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = visit(item, depth + 1);
    }
    return result;
  }

  return visit(payload, 0);
}

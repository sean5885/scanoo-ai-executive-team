import { generateText as defaultGenerateText } from "../llm/generate-text.mjs";
import { pickTechTerm } from "../utils/pick-tech-term.mjs";

function normalizeParsedKeyword(text) {
  const firstToken = String(text || "").split(/[,\n，]/)[0] || "";
  const normalized = firstToken
    .trim()
    .replace(/^[`"'“”‘’「」『』\s]+/, "")
    .replace(/[`"'“”‘’「」『』\s]+$/, "");

  return normalized || null;
}

export async function parseIntent(
  question,
  { generateText = defaultGenerateText, signal = null } = {},
) {
  const normalizedQuestion = typeof question === "string" ? question.trim() : "";
  if (!normalizedQuestion) {
    return null;
  }

  const direct = pickTechTerm(normalizedQuestion);
  if (direct) {
    return direct;
  }

  const prompt = [
    "請從以下問題中提取最適合搜尋文件的關鍵詞。",
    "",
    "規則：",
    "- 優先技術名詞、流程名詞、模組名詞。",
    "- 除非沒有別的詞，否則不要只回品牌名或公司名。",
    "- 只回 1 個關鍵詞。",
    "- 不要解釋。",
    "",
    "問題：",
    normalizedQuestion,
  ].join("\n");

  try {
    const response = await generateText({
      prompt,
      sessionIdSuffix: "planner-intent-parser",
      temperature: 0,
      signal,
    });

    return normalizeParsedKeyword(response);
  } catch {
    return null;
  }
}

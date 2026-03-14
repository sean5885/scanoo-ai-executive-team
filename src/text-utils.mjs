import crypto from "node:crypto";

export function nowIso() {
  return new Date().toISOString();
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function normalizeText(input) {
  return String(input || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function markdownToPlainText(markdown) {
  return normalizeText(
    String(markdown || "")
      .replace(/```[\s\S]*?```/g, "\n")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^>\s?/gm, "")
      .replace(/^#+\s+/gm, "")
      .replace(/[*_~]/g, "")
      .replace(/^-{3,}$/gm, "")
      .replace(/^\s*[-+]\s+/gm, "- ")
      .replace(/^\s*\d+\.\s+/gm, "")
  );
}

export function toSearchMatchQuery(query) {
  const tokens = normalizeText(query)
    .split(/\s+/)
    .map((token) => token.replace(/"/g, ""))
    .filter((token) => token.length > 1)
    .slice(0, 8);

  if (!tokens.length) {
    return "";
  }

  return tokens.map((token) => `"${token}"`).join(" OR ");
}

export function buildParentPath(parts) {
  const normalized = parts.map((part) => normalizeText(part)).filter(Boolean);
  return normalized.length ? `/${normalized.join("/")}` : "/";
}

function normalizeLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncate(value, limit = 220) {
  const text = normalizeLine(value);
  if (!text) {
    return "(空)";
  }
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}...`;
}

function formatList(items, fallback) {
  const normalized = (Array.isArray(items) ? items : [])
    .map((item) => truncate(item, 120))
    .filter(Boolean);
  if (!normalized.length) {
    return fallback;
  }
  return normalized.map((item) => `- ${item}`).join("\n");
}

function formatCommentList(comments = []) {
  const normalized = comments
    .map((comment) => {
      const quote = truncate(comment?.quote || "", 72);
      const text = truncate(comment?.latest_reply_text || "", 96);
      return `- ${text}${quote && quote !== "(空)" ? `（引用：${quote}）` : ""}`;
    })
    .filter(Boolean);
  if (!normalized.length) {
    return "- 本次沒有抓到可用評論摘要";
  }
  return normalized.join("\n");
}

export function buildDocumentReplacePreviewCard({
  title,
  currentLength,
  proposedLength,
  currentExcerpt,
  proposedExcerpt,
}) {
  const cardTitle = `文檔覆寫預覽：${title || "未命名文檔"}`;
  const content = [
    "結論",
    "這次是整份文檔 replace，尚未寫回。",
    "",
    "重點",
    `- 目前長度：${Number(currentLength) || 0} 字`,
    `- 改後長度：${Number(proposedLength) || 0} 字`,
    `- 改前摘要：${truncate(currentExcerpt)}`,
    `- 改後摘要：${truncate(proposedExcerpt)}`,
    "",
    "下一步",
    "- 若確認沒問題，再用 confirmation_id 二次確認套用。",
  ].join("\n");

  return {
    title: cardTitle,
    content,
  };
}

export function buildCommentRewritePreviewCard({
  title,
  commentCount,
  changeSummary,
  comments,
  currentExcerpt,
  proposedExcerpt,
  confirmationId,
}) {
  const cardTitle = `評論改稿建議：${title || "未命名文檔"}`;
  const content = [
    "結論",
    `我先根據 ${Number(commentCount) || 0} 則未處理評論生成了一版改稿建議，尚未寫回。`,
    "",
    "重點",
    formatList(changeSummary, "- 本次沒有額外修改重點"),
    "",
    "評論摘要",
    formatCommentList(comments),
    "",
    "改前摘要",
    `- ${truncate(currentExcerpt)}`,
    "",
    "改後摘要",
    `- ${truncate(proposedExcerpt)}`,
    "",
    "下一步",
    confirmationId
      ? `- 若確認方向正確，可用 confirmation_id=${confirmationId} 再執行 apply。`
      : "- 若確認方向正確，再執行 apply。",
  ].join("\n");

  return {
    title: cardTitle,
    content,
  };
}

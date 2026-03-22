function cleanSnippet(text) {
  let snippet = (text || "")
    .replace(/`[^`]*`/g, "")
    .replace(/\/Users\/[^\s]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[^A-Za-z\u4e00-\u9fa5]+/, "")
    .trim();

  snippet = snippet.replace(/[\s\-,:;\/|]+$/g, "").trim();
  snippet = snippet.replace(/\s+([,.:;])/g, "$1");
  snippet = snippet.replace(/,\s*,+/g, ",");
  snippet = snippet.replace(/\b(supports)\s*,*(?:\s*,+)*(?:\s*(and|or))?\s*$/i, "$1");
  snippet = snippet.replace(/\b(and|or)\s*$/i, "").trim();
  snippet = snippet.replace(/[\s\-,:;\/|]+$/g, "").trim();

  return snippet;
}

export function buildAnswer(keyword, results) {
  if (!results || results.length === 0) {
    return `目前沒有找到與「${keyword}」直接相關的資料。`;
  }

  const intro = `我查到 ${results.length} 份與「${keyword}」相關的內容，重點如下：`;
  const bullets = results.map((result, index) => {
    const text = cleanSnippet(result.snippet);
    return `${index + 1}. ${result.id}：${text}`;
  });

  return [intro, ...bullets].join("\n");
}

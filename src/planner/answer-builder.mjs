export function buildAnswer(keyword, results) {
  if (!Array.isArray(results) || results.length === 0) {
    return `沒有找到與「${keyword}」相關的資料。`;
  }

  const lines = results.map((result) => `- ${result.id}: ${result.snippet}`);
  return `關於「${keyword}」，整理如下：\n${lines.join("\n")}`;
}

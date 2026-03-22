export function scoreDoc(doc, keyword) {
  const text = (doc.content || '').toLowerCase();
  const k = (keyword || '').toLowerCase();

  let score = 0;

  if (!k) return score;
  if (text.includes(k)) score += 20;

  const first = text.indexOf(k);
  if (first >= 0 && first < 200) score += 8;
  else if (first >= 0 && first < 600) score += 4;

  const exactCount = text.split(k).length - 1;
  score += Math.min(exactCount, 5) * 2;

  if (text.includes(`${k} `) || text.includes(` ${k}`)) score += 3;

  return score;
}

export function rankResults(docs, keyword) {
  return [...docs]
    .map(doc => ({ doc, score: scoreDoc(doc, keyword) }))
    .sort((a, b) => b.score - a.score)
    .map(x => x.doc);
}

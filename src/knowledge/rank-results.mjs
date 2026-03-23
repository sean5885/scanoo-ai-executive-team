const BD_DOMAIN_TOKENS = ["bd", "商機", "客戶", "跟進", "demo", "提案"];
const BD_ALIAS_TOKENS = ["business", "management"];
const BD_DOC_BOOSTS = new Map([
  ["closed_loop.md", 8],
  ["planner_agent_alignment.md", 12],
]);
const GENERIC_BD_DOC_PENALTIES = new Map([
  ["knowledge_pipeline.md", -8],
  ["modules.md", -6],
  ["system_state_snapshot.md", -4],
]);

function includesKeyword(text, keyword) {
  return keyword ? text.includes(keyword) : false;
}

function isBdDomainKeyword(keyword) {
  return [...BD_DOMAIN_TOKENS, ...BD_ALIAS_TOKENS].some((token) =>
    keyword.includes(token),
  );
}

function scoreBdDomainSignals(doc, text) {
  let score = 0;

  const domainHitCount = BD_DOMAIN_TOKENS.reduce(
    (count, token) => count + (text.includes(token) ? 1 : 0),
    0,
  );
  score += Math.min(domainHitCount, BD_DOMAIN_TOKENS.length) * 2;

  if (text.includes("planner-bd-flow.mjs")) score += 6;
  if (text.includes("bd / 商機 / 客戶 / 跟進 / demo / 提案")) score += 6;

  score += BD_DOC_BOOSTS.get(doc?.id) || 0;
  score += GENERIC_BD_DOC_PENALTIES.get(doc?.id) || 0;

  return score;
}

export function scoreDoc(doc, keyword) {
  const text = (doc.content || "").toLowerCase();
  const k = (keyword || "").toLowerCase();

  let score = 0;

  if (!k) return score;
  if (includesKeyword(text, k)) score += 20;

  const first = text.indexOf(k);
  if (first >= 0 && first < 200) score += 8;
  else if (first >= 0 && first < 600) score += 4;

  const exactCount = text.split(k).length - 1;
  score += Math.min(exactCount, 5) * 2;

  if (includesKeyword(text, `${k} `) || includesKeyword(text, ` ${k}`)) score += 3;

  if (isBdDomainKeyword(k)) {
    score += scoreBdDomainSignals(doc, text);
  }

  return score;
}

export function rankResults(docs, keyword) {
  return [...docs]
    .map((doc) => ({ doc, score: scoreDoc(doc, keyword) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.doc?.id || "").localeCompare(String(b.doc?.id || ""));
    })
    .map((x) => x.doc);
}

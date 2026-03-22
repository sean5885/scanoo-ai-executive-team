import { queryKnowledgeWithContext } from "../src/knowledge/knowledge-service.mjs";

const cases = [
  "Scanoo 交付流程",
  "OKR 設計",
  "BD 商機管理",
  "planner routing",
  "verification"
];

function score(results, keyword) {
  if (!results?.length) return 0;
  const map = {
    "交付": "delivery",
    "流程": "process",
    "設計": "design",
    "商機": "business",
    "管理": "management"
  };

  // split mixed-language query terms so scoring can reflect normalized fallback hits
  const tokens = keyword
    .toLowerCase()
    .split(/\s+/)
    .flatMap(t => {
      const extra = [];
      Object.keys(map).forEach(k => {
        if (t.includes(k)) extra.push(map[k]);
      });
      return [t, ...extra];
    });

  return results.reduce((acc, r) => {
    const text = (r.snippet || "").toLowerCase();
    const hit = tokens.some(t => text.includes(t));
    return acc + (hit ? 1 : 0);
  }, 0);
}

async function run() {
  let total = 0;
  for (const q of cases) {
    const results = await queryKnowledgeWithContext(q);
    const s = score(results, q);
    console.log(q, "score:", s, "hits:", results.length);
    total += s;
  }
  console.log("TOTAL SCORE:", total);
}

run();

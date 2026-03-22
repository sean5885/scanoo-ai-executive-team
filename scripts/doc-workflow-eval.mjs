import { queryKnowledgeWithContext } from "../src/knowledge/knowledge-service.mjs";
import { cases } from "../evals/doc-workflow-set.mjs";

function ok(snips, must) {
  const text = snips.map((s) => s.snippet || "").join(" ").toLowerCase();
  return must.every((m) => text.includes(m));
}

let hit = 0;

for (const c of cases) {
  const res = queryKnowledgeWithContext(c.q);
  const pass = ok(res || [], c.must);
  if (pass) hit++;
  console.log(c.q, pass ? "PASS" : "FAIL", "|", res?.length || 0);
}

console.log("DOC WORKFLOW:", `${hit}/${cases.length}`);

import { queryKnowledgeWithContext } from "../src/knowledge/knowledge-service.mjs";
import { cases } from "../evals/retrieval-realworld-set.mjs";

async function run() {
  let hit = 0;

  for (const q of cases) {
    const res = queryKnowledgeWithContext(q);
    const ok = (res?.length || 0) > 0;
    if (ok) hit++;

    console.log(q, "=>", ok ? "HIT" : "MISS", "|", res?.length || 0);
  }

  console.log("HIT RATE:", hit + "/" + cases.length);
}

run();

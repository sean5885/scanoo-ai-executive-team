import { cases } from "../evals/runtime-workflow-set.mjs";

function mockRuntime() {
  return "system runtime status is healthy and stable";
}

function ok(ans, expect) {
  const text = ans.toLowerCase();
  return expect.every((item) => text.includes(item));
}

let hit = 0;

for (const c of cases) {
  const ans = mockRuntime();
  const pass = ok(ans, c.expect);
  if (pass) hit += 1;
  console.log(c.q, pass ? "PASS" : "FAIL", "|", ans);
}

console.log("RUNTIME WORKFLOW:", `${hit}/${cases.length}`);

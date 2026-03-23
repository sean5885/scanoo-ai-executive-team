import { runAgentExecution } from "../src/planner/agent-runtime.mjs";

const cases = [
  [{ agent: "meeting_agent", action: "meeting_summary" }, "meeting"],
  [{ agent: "doc_agent", action: "doc_answer" }, "doc"],
  [{ agent: "runtime_agent", action: "runtime_check" }, "runtime"],
  [{ agent: "mixed_agent", action: "mixed_lane" }, "mixed"],
];

let ok = 0;
for (const [input, kind] of cases) {
  const out = runAgentExecution(input);
  const r = out?.result || {};
  const pass =
    r.kind === kind &&
    r.status === "ok" &&
    typeof r.summary === "string" &&
    Array.isArray(r.actionable_items) &&
    typeof r.confidence === "number";
  if (pass) ok++;
  console.log(kind, pass ? "PASS" : "FAIL", r.summary);
}
console.log("AGENT RUNTIME PRODUCTIZED:", ok + "/" + cases.length);

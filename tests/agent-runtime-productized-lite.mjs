import { runAgentExecution } from "../src/planner/agent-runtime.mjs";

const cases = [
  [{ agent: "planner_agent", action: "planner_route" }, "mixed"],
  [{ agent: "company_brain_agent", action: "company_brain_read" }, "doc"],
  [{ agent: "runtime_agent", action: "runtime_check" }, "runtime"],
  [{ agent: "unknown_agent", action: "unknown_action" }, null],
];

let ok = 0;
for (const [input, kind] of cases) {
  const out = runAgentExecution(input);
  const r = out?.result || {};
  const pass = kind === null
    ? r.status === "unknown"
    : (
      r.kind === kind
      && r.status === "ok"
      && typeof r.summary === "string"
      && Array.isArray(r.actionable_items)
      && typeof r.confidence === "number"
    );
  if (pass) ok++;
  console.log(kind, pass ? "PASS" : "FAIL", r.summary);
}
console.log("AGENT RUNTIME PRODUCTIZED:", ok + "/" + cases.length);

import { runAgentExecution } from "../src/planner/agent-runtime.mjs";

const cases = [
  [{ agent: "planner_agent", action: "planner_route" }, "ok"],
  [{ agent: "company_brain_agent", action: "company_brain_read" }, "ok"],
  [{ agent: "runtime_agent", action: "runtime_check" }, "ok"],
  [{ agent: "unknown_agent", action: "unknown_action" }, "unknown"],
];

let ok = 0;

for (const [input, expect] of cases) {
  const out = runAgentExecution(input);
  const pass = out?.result?.status === expect;
  if (pass) ok += 1;
  console.log(input.agent, "=>", out.result.status, pass ? "PASS" : "FAIL");
}

console.log("AGENT RUNTIME:", ok + "/" + cases.length);

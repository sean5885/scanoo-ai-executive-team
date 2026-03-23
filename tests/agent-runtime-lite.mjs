import { runAgentExecution } from "../src/planner/agent-runtime.mjs";

const cases = [
  [{ agent: "meeting_agent", action: "meeting_summary" }, "ok"],
  [{ agent: "doc_agent", action: "doc_answer" }, "ok"],
  [{ agent: "runtime_agent", action: "runtime_check" }, "ok"],
  [{ agent: "mixed_agent", action: "mixed_lane" }, "ok"],
];

let ok = 0;

for (const [input, expect] of cases) {
  const out = runAgentExecution(input);
  const pass = out?.result?.status === expect;
  if (pass) ok += 1;
  console.log(input.agent, "=>", out.result.status, pass ? "PASS" : "FAIL");
}

console.log("AGENT RUNTIME:", ok + "/" + cases.length);

import { executeAgent } from "../src/planner/agent-executor.mjs";

const cases = [
  [{ lane: "meeting" }, "meeting_agent", "meeting_summary"],
  [{ lane: "doc" }, "doc_agent", "doc_answer"],
  [{ lane: "runtime" }, "runtime_agent", "runtime_check"],
  [{ lane: "mixed" }, "mixed_agent", "mixed_lane"],
];

let ok = 0;

for (const [input, agent, action] of cases) {
  const out = executeAgent(input);
  const pass = out.agent === agent && out.action === action;
  if (pass) ok += 1;
  console.log(input.lane, "=>", out.agent, out.action, pass ? "PASS" : "FAIL");
}

console.log("AGENT EXECUTOR:", ok + "/" + cases.length);

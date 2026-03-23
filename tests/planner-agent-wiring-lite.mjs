import { resolvePlannerAgentExecution } from "../src/executive-planner.mjs";

function plannerProxy(lane) {
  const agentExecution = resolvePlannerAgentExecution({ taskType: lane });
  return { lane, agent_execution: agentExecution };
}

const cases = [
  ["meeting", "meeting_agent"],
  ["doc", "doc_agent"],
  ["runtime", "runtime_agent"],
  ["mixed", "mixed_agent"],
];

let ok = 0;
for (const [lane, agent] of cases) {
  const out = plannerProxy(lane);
  const pass = out.agent_execution.agent === agent;
  if (pass) ok += 1;
  console.log(lane, "=>", out.agent_execution.agent, pass ? "PASS" : "FAIL");
}
console.log("PLANNER AGENT WIRING:", ok + "/" + cases.length);

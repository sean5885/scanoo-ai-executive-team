import { executeAgent } from "../src/planner/agent-executor.mjs";
import { runAgentExecution } from "../src/planner/agent-runtime.mjs";

function plannerProxy(lane) {
  const agent_execution = executeAgent({ lane });
  const agent_execution_result = runAgentExecution(agent_execution);
  return { lane, agent_execution: agent_execution_result };
}

const cases = [
  ["meeting", "meeting_agent", "ok"],
  ["doc", "doc_agent", "ok"],
  ["runtime", "runtime_agent", "ok"],
  ["mixed", "mixed_agent", "ok"],
];

let ok = 0;
for (const [lane, agent, status] of cases) {
  const out = plannerProxy(lane);
  const pass =
    out.agent_execution.agent === agent &&
    out.agent_execution.result?.status === status;
  if (pass) ok += 1;
  console.log(lane, "=>", out.agent_execution.agent, out.agent_execution.result?.status, pass ? "PASS" : "FAIL");
}
console.log("PLANNER AGENT RUNTIME:", ok + "/" + cases.length);

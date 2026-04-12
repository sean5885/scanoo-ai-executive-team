import { executeAgent } from "../src/planner/agent-executor.mjs";
import { runAgentExecution } from "../src/planner/agent-runtime.mjs";

function plannerProxy(selectedAction) {
  const agent_execution = executeAgent({ selected_action: selectedAction });
  const agent_execution_result = runAgentExecution(agent_execution);
  return { selectedAction, agent_execution: agent_execution_result };
}

const cases = [
  ["search_company_brain_docs", "company_brain_agent", "ok"],
  ["get_runtime_info", "runtime_agent", "ok"],
  ["create_doc", "planner_agent", "ok"],
  ["document_summarize", "company_brain_agent", "ok"],
];

let ok = 0;
for (const [selectedAction, agent, status] of cases) {
  const out = plannerProxy(selectedAction);
  const pass =
    out.agent_execution.agent === agent &&
    out.agent_execution.result?.status === status;
  if (pass) ok += 1;
  console.log(selectedAction, "=>", out.agent_execution.agent, out.agent_execution.result?.status, pass ? "PASS" : "FAIL");
}
console.log("PLANNER AGENT RUNTIME:", ok + "/" + cases.length);

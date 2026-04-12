import { resolvePlannerAgentExecution } from "../src/executive-planner.mjs";

function plannerProxy(selectedAction) {
  const agentExecution = resolvePlannerAgentExecution({ selectedAction });
  return { selectedAction, agent_execution: agentExecution };
}

const cases = [
  ["search_company_brain_docs", "company_brain_agent"],
  ["get_runtime_info", "runtime_agent"],
  ["create_doc", "planner_agent"],
  ["unknown_action", "planner_agent"],
];

let ok = 0;
for (const [selectedAction, agent] of cases) {
  const out = plannerProxy(selectedAction);
  const pass = out.agent_execution.agent === agent;
  if (pass) ok += 1;
  console.log(selectedAction, "=>", out.agent_execution.agent, pass ? "PASS" : "FAIL");
}
console.log("PLANNER AGENT WIRING:", ok + "/" + cases.length);

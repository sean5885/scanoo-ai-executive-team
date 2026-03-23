const LANE_EXECUTION_MAP = Object.freeze({
  meeting: Object.freeze({
    agent: "meeting_agent",
    action: "meeting_summary",
  }),
  doc: Object.freeze({
    agent: "doc_agent",
    action: "doc_answer",
  }),
  runtime: Object.freeze({
    agent: "runtime_agent",
    action: "runtime_check",
  }),
  mixed: Object.freeze({
    agent: "mixed_agent",
    action: "mixed_lane",
  }),
});

export function executeAgent(task) {
  const lane = typeof task?.lane === "string" ? task.lane.trim() : "";
  const selected = lane ? LANE_EXECUTION_MAP[lane] : null;

  if (selected) {
    return {
      agent: selected.agent,
      action: selected.action,
      status: "ok",
    };
  }

  return {
    agent: "fallback_agent",
    action: "unknown",
    status: "fallback",
  };
}

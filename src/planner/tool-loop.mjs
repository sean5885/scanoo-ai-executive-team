import { runActionLoop } from './action-loop.mjs';

export async function runToolLoop({ plan, context, max_steps = 3 }) {
  let currentPlan = plan;
  const steps = [];

  for (let i = 0; i < max_steps; i++) {
    if (!currentPlan || !currentPlan.action) break;

    const result = await runActionLoop(currentPlan, context);

    steps.push({
      step: i + 1,
      action: currentPlan.action,
      params: currentPlan.params || {},
      result
    });

    if (!result || result.type !== 'action_executed') break;

    const nextAction = currentPlan.next_action;
    if (!nextAction || !nextAction.action) break;

    currentPlan = nextAction;
  }

  return {
    ok: true,
    type: 'tool_loop',
    steps
  };
}

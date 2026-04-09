/**
 * Multi-step Tool Loop（V1）
 * 讓 agent 可以連續執行多個 action
 */

import { runActionLoop } from './action-loop.mjs';

export async function runToolLoop({ plan, context, max_steps = 3 }) {
  let currentPlan = plan;
  let steps = [];

  for (let i = 0; i < max_steps; i++) {
    if (!currentPlan || !currentPlan.action) break;

    const result = await runActionLoop(currentPlan, context);

    steps.push({
      step: i + 1,
      action: currentPlan.action,
      result
    });

    // 如果沒有下一步，停止
    if (!result || result.type !== 'action_executed') break;

    // 暫時停止（V1：單步 + 可擴展）
    break;
  }

  return {
    ok: true,
    type: 'tool_loop',
    steps
  };
}

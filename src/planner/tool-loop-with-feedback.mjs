import { runActionLoop } from './action-loop.mjs';
import { normalizePlan } from './plan-normalizer.mjs';

export async function runToolLoopWithFeedback({
  llm,
  input,
  context,
  max_steps = 3
}) {
  const steps = [];
  let currentInput = input;

  for (let i = 0; i < max_steps; i++) {
    // 1. LLM 重新決策
    const raw = await llm(currentInput);
    const plan = normalizePlan(raw);

    // 2. 如果是 answer，直接結束
    if (plan.answer) {
      return {
        ok: true,
        type: 'final_answer',
        answer: plan.answer,
        steps
      };
    }

    // 3. 執行 action
    const result = await runActionLoop(plan, context);

    steps.push({
      step: i + 1,
      action: plan.action,
      params: plan.params || {},
      result
    });

    // 4. 組下一輪 input（關鍵）
    currentInput = JSON.stringify({
      previous_steps: steps,
      last_result: result
    });
  }

  return {
    ok: true,
    type: 'tool_loop_feedback',
    steps
  };
}

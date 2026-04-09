import { normalizePlan } from './plan-normalizer.mjs';
import { runToolLoop } from './tool-loop.mjs';

export async function runExecutionPipeline({ llm, input, context }) {
  // 1. LLM 產生原始輸出
  const raw = await llm(input);

  // 2. normalize 成 plan
  const plan = normalizePlan(raw);

  // 3. 如果是 answer，直接返回
  if (plan.answer) {
    return {
      ok: true,
      type: 'answer',
      answer: plan.answer
    };
  }

  // 4. 執行 tool loop
  const result = await runToolLoop({
    plan,
    context,
    max_steps: 3
  });

  // 5. 組裝最終回覆
  return {
    ok: true,
    type: 'execution_result',
    plan,
    result
  };
}

import { normalizePlan } from './plan-normalizer.mjs';
import { runToolLoopWithFeedback } from './tool-loop-with-feedback.mjs';
import { renderExecutionResult } from './render-execution-result.mjs';

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

  let firstRaw = raw;
  const llmWithFirstStepReplay = async (nextInput) => {
    if (firstRaw !== null) {
      const replayRaw = firstRaw;
      firstRaw = null;
      return replayRaw;
    }
    return llm(nextInput);
  };

  // 4. 改為 feedback loop（邊做邊想）
  const result = await runToolLoopWithFeedback({
    llm: llmWithFirstStepReplay,
    input,
    context,
    max_steps: 3
  });

  // 5. 如果已產生最終 answer
  if (result.type === 'final_answer') {
    return {
      ok: true,
      type: 'answer',
      answer: result.answer,
      steps: result.steps
    };
  }

  // 6. fallback：把執行結果轉成人類可讀
  return {
    ok: true,
    type: 'answer',
    answer: renderExecutionResult({
      type: 'execution_result',
      result
    }),
    steps: result.steps
  };
}

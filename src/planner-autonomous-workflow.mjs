import { executeTool } from './tool-execution-runtime.mjs';

function buildWorkflowPlan(userInput = '') {
  const text = String(userInput || '');

  if (/Scanoo.*是什麼|是什麼.*Scanoo|介紹.*Scanoo|查.*Scanoo/i.test(text)) {
    return [
      { action: 'search_company_brain_docs', args: { q: text } },
      { action: 'official_read_document', args: { document_ref: 'doc-1' } },
      { action: 'answer_user_directly', args_builder: (state) => ({
        answer: `根據查詢與文件內容整理：${JSON.stringify({
          search: state.search_company_brain_docs?.result || null,
          doc: state.official_read_document?.result || null,
        })}`
      }) }
    ];
  }

  return [
    { action: 'answer_user_directly', args: { answer: `目前先無對應 workflow，原始輸入：${text}` } }
  ];
}

export async function runAutonomousWorkflow(userInput = '', ctx = {}) {
  const plan = buildWorkflowPlan(userInput);
  const state = {};

  for (const step of plan) {
    const args = typeof step.args_builder === 'function'
      ? step.args_builder(state)
      : (step.args || {});

    const res = await executeTool(step.action, args, ctx);
    state[step.action] = res;

    if (!res?.ok) {
      return {
        ok: false,
        failed_action: step.action,
        state,
      };
    }
  }

  return {
    ok: true,
    plan: plan.map((s) => s.action),
    state,
    final: state.answer_user_directly || null,
  };
}

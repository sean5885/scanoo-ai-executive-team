import test from 'node:test';
import assert from 'node:assert/strict';
import { runAutonomousWorkflow } from '../src/planner-autonomous-workflow.mjs';

const toolExecutor = async ({ action, args }) => {
  if (action === 'search_company_brain_docs') {
    return {
      ok: true,
      data: {
        q: args?.q || '',
        total: 1,
        docs: [
          {
            document_ref: 'doc-test-1',
            title: 'Scanoo Brief',
            snippet: 'Scanoo 是一個 AI workflow tool',
          },
        ],
      },
    };
  }
  if (action === 'official_read_document') {
    return {
      ok: true,
      data: {
        content: `document: ${args?.document_ref || 'doc-test-1'}`,
      },
    };
  }
  if (action === 'answer_user_directly') {
    return {
      ok: true,
      data: {
        answer: args?.answer || 'done',
      },
    };
  }
  return {
    ok: false,
    error: 'unknown_tool_action',
  };
};

test('autonomous workflow completes scanoo query flow', async () => {
  const res = await runAutonomousWorkflow('幫我查 Scanoo 是什麼，整理給我', {
    user_id: 'u1',
    authContext: { account_id: 'acc-1' },
    retry_count: 0,
    retry_policy: { max_retries: 2 },
    tool_executor: toolExecutor,
  });

  assert.equal(res.ok, true);
  assert.deepEqual(res.plan, [
    'search_company_brain_docs',
    'official_read_document',
    'answer_user_directly',
  ]);
  assert.equal(res.final?.ok, true);
});

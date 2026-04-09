import test from 'node:test';
import assert from 'node:assert/strict';
import { runExecutionPipeline } from '../src/planner/execution-pipeline.mjs';

test('execution pipeline runs multi-step plan', async () => {
  const llm = async () => JSON.stringify({
    action: 'send_message',
    params: { content: 'hello' },
    next_action: {
      action: 'create_task',
      params: { title: 'follow up' }
    }
  });

  const context = {
    token: 'ascii_token_for_test',
    chat_id: 'oc_test_chat'
  };

  const originalFetch = global.fetch;
  let calls = 0;

  global.fetch = async () => {
    calls++;
    return {
      ok: true,
      headers: { get() { return 'application/json'; } },
      json: async () => ({ code: 0, msg: 'success', data: {} })
    };
  };

  const res = await runExecutionPipeline({
    llm,
    input: 'test',
    context
  });

  assert.equal(res.ok, true);
  assert.equal(res.type, 'execution_result');
  assert.equal(res.result.steps.length, 2);
  assert.equal(calls, 2);

  global.fetch = originalFetch;
});

test('execution pipeline returns answer directly', async () => {
  const llm = async () => '這是答案';

  const res = await runExecutionPipeline({
    llm,
    input: 'test',
    context: {}
  });

  assert.equal(res.type, 'answer');
  assert.equal(res.answer, '這是答案');
});

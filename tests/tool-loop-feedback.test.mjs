import test from 'node:test';
import assert from 'node:assert/strict';
import { runToolLoopWithFeedback } from '../src/planner/tool-loop-with-feedback.mjs';

test('tool loop with feedback runs multiple steps via llm decisions', async () => {
  let call = 0;

  const llm = async () => {
    call++;
    if (call === 1) {
      return JSON.stringify({
        action: 'send_message',
        params: { content: 'hello' }
      });
    }
    if (call === 2) {
      return JSON.stringify({
        action: 'create_task',
        params: { title: 'follow up' }
      });
    }
    return JSON.stringify({
      answer: 'done'
    });
  };

  const context = {
    token: 'ascii_token_for_test',
    chat_id: 'oc_test_chat',
    allow_write_actions: true
  };

  const originalFetch = global.fetch;
  let fetchCalls = 0;

  global.fetch = async () => {
    fetchCalls++;
    return {
      ok: true,
      headers: { get() { return 'application/json'; } },
      json: async () => ({ code: 0, msg: 'success', data: {} })
    };
  };

  const res = await runToolLoopWithFeedback({
    llm,
    input: 'start',
    context,
    max_steps: 3
  });

  assert.equal(res.ok, true);
  assert.equal(res.type, 'final_answer');
  assert.equal(res.steps.length, 2);
  assert.equal(fetchCalls, 2);

  global.fetch = originalFetch;
});

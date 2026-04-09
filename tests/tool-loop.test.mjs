import test from 'node:test';
import assert from 'node:assert/strict';
import { runToolLoop } from '../src/planner/tool-loop.mjs';

test('tool loop executes single action step', async () => {
  const plan = {
    action: 'send_message',
    params: { content: 'hello' }
  };

  const context = {
    token: 'ascii_token_for_test',
    chat_id: 'oc_test_chat'
  };

  let called = false;
  const originalFetch = global.fetch;

  global.fetch = async () => {
    called = true;
    return {
      ok: true,
      headers: {
        get() {
          return 'application/json';
        }
      },
      json: async () => ({
        code: 0,
        msg: 'success',
        data: { message_id: 'om_test' }
      })
    };
  };

  const result = await runToolLoop({ plan, context, max_steps: 3 });

  assert.equal(result.ok, true);
  assert.equal(result.type, 'tool_loop');
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].action, 'send_message');
  assert.equal(called, true);

  global.fetch = originalFetch;
});

test('tool loop stops when no action', async () => {
  const result = await runToolLoop({
    plan: { answer: 'no action' },
    context: {},
    max_steps: 3
  });

  assert.equal(result.ok, true);
  assert.equal(result.type, 'tool_loop');
  assert.equal(result.steps.length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { runToolLoop } from '../src/planner/tool-loop.mjs';

test('tool loop executes multi-step actions', async () => {
  const plan = {
    action: 'send_message',
    params: { content: 'hello' },
    next_action: {
      action: 'create_task',
      params: { title: 'follow up task' }
    }
  };

  const context = {
    token: 'ascii_token_for_test',
    chat_id: 'oc_test_chat',
    allow_write_actions: true,
  };

  const originalFetch = global.fetch;
  let calls = 0;

  global.fetch = async (url) => {
    calls += 1;
    if (url.includes('/im/v1/messages')) {
      return {
        ok: true,
        headers: { get() { return 'application/json'; } },
        json: async () => ({ code: 0, msg: 'success', data: { message_id: 'om_test' } })
      };
    }
    if (url.includes('/task/v2/tasks')) {
      return {
        ok: true,
        headers: { get() { return 'application/json'; } },
        json: async () => ({ code: 0, msg: 'success', data: { task_guid: 'task_test' } })
      };
    }
    throw new Error('unexpected url: ' + url);
  };

  const result = await runToolLoop({ plan, context, max_steps: 3 });

  assert.equal(result.ok, true);
  assert.equal(result.type, 'tool_loop');
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].action, 'send_message');
  assert.equal(result.steps[1].action, 'create_task');
  assert.equal(calls, 2);

  global.fetch = originalFetch;
});

test('tool loop blocks write actions unless explicit write access is enabled', async () => {
  const result = await runToolLoop({
    plan: { action: 'send_message', params: { content: 'hello' } },
    context: {},
    max_steps: 3,
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.error, 'write_action_not_allowed');
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

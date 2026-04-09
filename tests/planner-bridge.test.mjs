import test from 'node:test';
import assert from 'node:assert/strict';
import * as skillBridge from '../src/planner/skill-bridge.mjs';

const runPlannerBridge =
  skillBridge.runPlannerBridge ||
  skillBridge.runPlannerSkillBridge ||
  skillBridge.default;

test('planner bridge runs multi-step tool loop', async () => {
  assert.equal(typeof runPlannerBridge, 'function');

  const plan = {
    action: 'send_message',
    params: { content: 'hello' },
    next_action: {
      action: 'create_task',
      params: { title: 'task from planner' }
    }
  };

  const context = {
    token: 'ascii_token_for_test',
    chat_id: 'oc_test_chat'
  };

  const originalFetch = global.fetch;
  let calls = 0;

  global.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      headers: { get() { return 'application/json'; } },
      json: async () => ({ code: 0, msg: 'success', data: {} })
    };
  };

  const res = await runPlannerBridge({
    action: 'planner_bridge',
    payload: { plan, context }
  });

  assert.equal(res.ok, true);
  assert.equal(res.type, 'tool_loop');
  assert.equal(res.steps.length, 2);
  assert.equal(calls, 2);

  global.fetch = originalFetch;
});

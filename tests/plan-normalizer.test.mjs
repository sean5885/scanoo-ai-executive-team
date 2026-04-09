import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlan } from '../src/planner/plan-normalizer.mjs';

test('normalize multi-step action plan', () => {
  const output = JSON.stringify({
    action: 'send_message',
    params: { content: 'hello' },
    next_action: {
      action: 'create_task',
      params: { title: 'follow up' }
    }
  });

  const plan = normalizePlan(output);

  assert.equal(plan.action, 'send_message');
  assert.equal(plan.next_action.action, 'create_task');
  assert.equal(plan.next_action.params.title, 'follow up');
});

test('normalize plain answer', () => {
  const plan = normalizePlan('普通回答');
  assert.equal(plan.answer, '普通回答');
});

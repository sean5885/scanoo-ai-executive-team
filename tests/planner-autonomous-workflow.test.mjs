import test from 'node:test';
import assert from 'node:assert/strict';
import { runAutonomousWorkflow } from '../src/planner-autonomous-workflow.mjs';

test('autonomous workflow completes scanoo query flow', async () => {
  const res = await runAutonomousWorkflow('幫我查 Scanoo 是什麼，整理給我', {
    user_id: 'u1',
    authContext: { account_id: 'acc-1' },
    retry_count: 0,
    retry_policy: { max_retries: 2 },
  });

  assert.equal(res.ok, true);
  assert.deepEqual(res.plan, [
    'search_company_brain_docs',
    'official_read_document',
    'answer_user_directly',
  ]);
  assert.equal(res.final?.ok, true);
});

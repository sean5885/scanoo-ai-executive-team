import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDbHarness } from './utils/test-db-factory.mjs';

const testDb = await createTestDbHarness();
const { runAgentE2E } = await import('../src/planner-autonomous-workflow.mjs');

const quietLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

test.after(() => {
  testDb.close();
});

test('runAgentE2E reaches terminal answer through planner -> tool -> continuation loop', async () => {
  const result = await runAgentE2E('幫我查 Scanoo 是什麼，整理給我', {
    authContext: { account_id: 'acc-1' },
    retry_policy: { max_retries: 2 },
    logger: quietLogger,
  });

  assert.equal(result.ok, true);
  assert.equal(result.done, true);
  assert.deepEqual(result.plan.slice(0, 3), [
    'search_company_brain_docs',
    'official_read_document',
    'answer_user_directly',
  ]);
  assert.equal(result.steps[0]?.planner_decision?.selected_action, 'search_company_brain_docs');
  assert.equal(result.steps[1]?.routing_decision?.source, 'continuation_chain');
  assert.equal(result.steps[2]?.routing_decision?.source, 'continuation_chain');
  assert.equal(result.debug?.chosen_skills?.[0], 'search_and_summarize');
  assert.equal(result.debug?.chosen_skills?.[1], 'document_summarize');
  assert.equal(result.debug?.continuation_state?.[0]?.next_action, 'continue_planner');
  assert.equal(result.debug?.continuation_state?.[1]?.next_action, 'continue_planner');
  assert.equal(result.final?.ok, true);
  assert.equal(typeof result.final?.result?.answer, 'string');
});

test('runAgentE2E is not a fixed manual workflow script', async () => {
  const result = await runAgentE2E('幫我看看', {
    logger: quietLogger,
  });

  assert.equal(result.ok, true);
  assert.equal(result.plan[0], 'answer_user_directly');
  assert.notDeepEqual(result.plan.slice(0, 3), [
    'search_company_brain_docs',
    'official_read_document',
    'answer_user_directly',
  ]);
  assert.equal(result.steps[0]?.planner_decision?.selected_action, null);
  assert.equal(result.steps[0]?.routing_decision?.source, 'planner_decision');
});

test('runAgentE2E avoids contract_violation and undefined crash on normal query', async () => {
  const result = await runAgentE2E('幫我查 Scanoo 是什麼，整理給我', {
    authContext: { account_id: 'acc-2' },
    logger: quietLogger,
  });

  assert.equal(result.ok, true);
  assert.equal(result.steps.length >= 1, true);
  for (const step of result.steps) {
    assert.notEqual(step?.tool_execution?.error, 'contract_violation');
    assert.notEqual(step?.action, undefined);
    assert.notEqual(step?.continuation?.next_action, undefined);
  }
  assert.doesNotMatch(result.final?.result?.answer || '', /undefined/i);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDbHarness } from "./utils/test-db-factory.mjs";
import { runExecutionPipeline } from '../src/planner/execution-pipeline.mjs';

const testDb = await createTestDbHarness();

test.after(() => {
  testDb.close();
});

test('execution pipeline uses feedback loop', async () => {
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

  const res = await runExecutionPipeline({
    llm,
    input: 'start',
    context
  });

  assert.equal(res.ok, true);
  assert.equal(res.type, 'answer');
  assert.equal(fetchCalls, 2);

  global.fetch = originalFetch;
});

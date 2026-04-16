import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDbHarness } from "./utils/test-db-factory.mjs";
import { runToolLoop } from '../src/planner/tool-loop.mjs';

const testDb = await createTestDbHarness();

test.after(() => {
  testDb.close();
});

test('read-only skill cannot bypass into write action', async () => {
  const res = await runToolLoop({
    plan: { action: 'send_message', selected_skill: 'search_and_summarize' },
    context: {},
  });

  assert.equal(res.ok, false);
  assert.equal(res.blocked, true);
  assert.equal(res.error, 'read_only_skill_cannot_execute_write_action');
});

test('read-only doc skill cannot bypass into create_task', async () => {
  const res = await runToolLoop({
    plan: { action: 'create_task', selected_skill: 'official_read_document' },
    context: {},
  });

  assert.equal(res.ok, false);
  assert.equal(res.blocked, true);
  assert.equal(res.error, 'read_only_skill_cannot_execute_write_action');
});

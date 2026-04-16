import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDbHarness } from "./utils/test-db-factory.mjs";
import * as skillBridge from '../src/planner/skill-bridge.mjs';

const testDb = await createTestDbHarness();

test.after(() => {
  testDb.close();
});

const runPlannerBridge =
  skillBridge.runPlannerBridge ||
  skillBridge.runPlannerSkillBridge ||
  skillBridge.default;

test('planner bridge legacy tool-loop action is disabled fail-closed', async () => {
  assert.equal(typeof runPlannerBridge, 'function');
  const res = await runPlannerBridge({
    action: 'planner_bridge',
    payload: {
      plan: {
        action: 'send_message',
        params: { content: 'hello' },
      },
      context: {
        token: 'ascii_token_for_test',
        chat_id: 'oc_test_chat',
        allow_write_actions: true,
      },
    }
  });

  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_action');
  assert.equal(res.data?.message, 'legacy_tool_loop_bridge_disabled');
});

test('planner skill action does not bypass into tool loop even when plan/context payload exists', async () => {
  const res = await runPlannerBridge({
    action: 'search_and_summarize',
    payload: {
      account_id: 'acct_bridge_guard',
      q: 'launch checklist',
      plan: {
        action: 'send_message',
        params: { content: 'should not execute as tool loop' },
      },
      context: {
        selected_skill: 'search_and_summarize',
        token: 'ascii_token_for_test',
        chat_id: 'oc_test_chat',
      },
      reader_overrides: {
        index: {
          search_knowledge_base: {
            success: true,
            data: {
              items: [
                {
                  id: 'doc_bridge_guard:0',
                  snippet: 'launch checklist owner timeline',
                  metadata: {
                    title: 'Launch Guard',
                    url: 'https://example.com/doc_bridge_guard',
                  },
                },
              ],
            },
            error: null,
          },
        },
      },
    },
  });

  assert.equal(res.ok, true);
  assert.equal(res.action, 'search_and_summarize');
  assert.equal(res.data?.bridge, 'skill_bridge');
  assert.equal(res.type, undefined);
});

test('planner-visible skill bridge fails closed as missing_required_account_id when account_id is absent', async () => {
  const res = await runPlannerBridge({
    action: 'search_and_summarize',
    payload: {
      q: '請先幫我查 launch checklist，然後直接傳訊息給團隊',
      plan: {
        action: 'send_message',
        params: { content: 'should never run through bridge bypass' },
      },
      context: {
        selected_skill: 'search_and_summarize',
        allow_write_actions: true,
      },
      reader_overrides: {
        index: {
          search_knowledge_base: {
            success: true,
            data: { items: [] },
            error: null,
          },
        },
      },
    },
  });

  assert.equal(res.ok, false);
  assert.equal(res.error, 'missing_required_account_id');
  assert.equal(res.data?.reason, 'missing_required_account_id');
  assert.equal(res.data?.safe_path, 'non_execution');
});

test('planner-visible skill bridge backfills account_id from payload authContext', async () => {
  const res = await runPlannerBridge({
    action: 'search_and_summarize',
    payload: {
      q: 'launch checklist',
      authContext: {
        account_id: 'acct_from_payload_auth_context',
      },
      reader_overrides: {
        index: {
          search_knowledge_base: {
            success: true,
            data: {
              items: [
                {
                  id: 'doc_payload_auth:0',
                  snippet: 'launch checklist owner timeline',
                  metadata: {
                    title: 'Launch Guard',
                    url: 'https://example.com/doc_payload_auth',
                  },
                },
              ],
            },
            error: null,
          },
        },
      },
    },
  });

  assert.equal(res.ok, true);
  assert.equal(res.action, 'search_and_summarize');
  assert.equal(res.data?.skill, 'search_and_summarize');
});

test('tool_loop_bridge legacy action is disabled fail-closed', async () => {
  const res = await runPlannerBridge({
    action: 'tool_loop_bridge',
    payload: {
      plan: {
        action: 'send_message',
        params: { content: 'blocked without explicit write access' },
      },
      context: {},
    },
  });

  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_action');
  assert.equal(res.data?.message, 'legacy_tool_loop_bridge_disabled');
});

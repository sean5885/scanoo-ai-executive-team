import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveToolResultContinuation } from '../src/tool-result-continuation.mjs';

test('tool success continues planner', () => {
  const res = resolveToolResultContinuation({ ok: true, next: 'continue_planner' }, {});
  assert.equal(res.next_action, 'continue_planner');
  assert.equal(res.resume, true);
});

test('tool failure triggers retry when budget available', () => {
  const res = resolveToolResultContinuation(
    { ok: false, next: 'retry' },
    { retry_count: 0, retry_policy: { max_retries: 2 } }
  );
  assert.equal(res.next_action, 'retry');
});

test('tool failure falls back when no retry left', () => {
  const res = resolveToolResultContinuation(
    { ok: false },
    { retry_count: 2, retry_policy: { max_retries: 2 } }
  );
  assert.equal(res.next_action, 'fallback');
});

test('tool failure can ask user if waiting_user', () => {
  const res = resolveToolResultContinuation(
    { ok: false },
    { retry_count: 2, retry_policy: { max_retries: 2 }, waiting_user: true }
  );
  assert.equal(res.next_action, 'ask_user');
});

test('legacy continuation tokens are normalized into canonical actions', () => {
  const retryRes = resolveToolResultContinuation(
    { ok: false, next: 'retry_or_fallback' },
    { retry_count: 0, retry_policy: { max_retries: 1 } }
  );
  assert.equal(retryRes.next_action, 'retry');

  const askRes = resolveToolResultContinuation(
    { ok: false, next: 'ask_or_fallback' },
    { retry_count: 1, retry_policy: { max_retries: 1 } }
  );
  assert.equal(askRes.next_action, 'ask_user');
});

test('retry continuation degrades to fallback when retry budget is exhausted', () => {
  const res = resolveToolResultContinuation(
    { ok: false, next: 'retry' },
    { retry_count: 2, retry_policy: { max_retries: 2 } }
  );
  assert.equal(res.next_action, 'fallback');
});

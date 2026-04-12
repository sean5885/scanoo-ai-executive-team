import test from 'node:test';
import assert from 'node:assert/strict';
import { validateToolInvocation } from '../src/tool-layer-contract.mjs';

test('valid tool invocation passes', () => {
  const res = validateToolInvocation('search_company_brain_docs', { query: 'test' });
  assert.equal(res.ok, true);
});

test('missing args blocks tool invocation', () => {
  const res = validateToolInvocation('search_company_brain_docs', {});
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'missing_required_args');
});

test('unknown tool is rejected', () => {
  const res = validateToolInvocation('unknown_tool', {});
  assert.equal(res.ok, false);
});

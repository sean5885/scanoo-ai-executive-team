import test from 'node:test';
import assert from 'node:assert/strict';
import { validateToolInvocation, validateToolPermission } from '../src/tool-layer-contract.mjs';

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

test('tool permission allows action when allowed_tools contains exact action', () => {
  const res = validateToolPermission('search_company_brain_docs', ['search_company_brain_docs']);
  assert.equal(res.ok, true);
});

test('tool permission blocks action when allowed_tools excludes action and capability', () => {
  const res = validateToolPermission('search_company_brain_docs', ['get_runtime_info']);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'permission_denied');
});

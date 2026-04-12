import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTool } from '../src/tool-execution-runtime.mjs';

test('search_company_brain_docs executes successfully', async () => {
  const res = await executeTool('search_company_brain_docs', { query: 'scanoo' }, {});
  assert.equal(res.ok, true);
  assert.equal(res.action, 'search_company_brain_docs');
  assert.equal(res.next, 'continue_planner');
});

test('official_read_document executes successfully', async () => {
  const res = await executeTool('official_read_document', { document_ref: 'doc-1' }, {});
  assert.equal(res.ok, true);
  assert.equal(res.next, 'continue_planner');
});

test('unknown tool returns failure', async () => {
  const res = await executeTool('unknown_tool', {}, {});
  assert.equal(res.ok, false);
  assert.equal(res.error, 'unknown_tool_action');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderExecutionResult } from '../src/planner/render-execution-result.mjs';

test('render multi-step execution result', () => {
  const text = renderExecutionResult({
    type: 'execution_result',
    result: {
      steps: [
        {
          action: 'send_message',
          result: { result: { data: { message_id: 'om_123' } } }
        },
        {
          action: 'create_task',
          result: { result: { summary: 'follow up', url: 'https://task-url' } }
        }
      ]
    }
  });

  assert.match(text, /已發送訊息/);
  assert.match(text, /已建立任務：follow up/);
});

test('render empty execution result', () => {
  const text = renderExecutionResult({
    type: 'execution_result',
    result: { steps: [] }
  });

  assert.equal(text, '已完成處理');
});

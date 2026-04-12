import { runAutonomousWorkflow } from '../src/planner-autonomous-workflow.mjs';

const ctx = {
  user_id: 'demo-user-1',
  authContext: { account_id: 'acc-demo-1' },
  retry_count: 0,
  retry_policy: { max_retries: 2 },
};

const input = '幫我查 Scanoo 是什麼，整理給我';
const res = await runAutonomousWorkflow(input, ctx);
console.log(JSON.stringify(res, null, 2));

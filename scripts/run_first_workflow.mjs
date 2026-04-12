import { executeTool } from '../src/tool-execution-runtime.mjs';

// 簡化：用一個實際任務串起來（查資料→讀文件→整理回覆）
async function run() {
  const ctx = {
    user_id: 'demo-user-1',
    authContext: { account_id: 'acc-demo-1' },
    retry_count: 0,
    retry_policy: { max_retries: 2 },
  };

  // Step 1: 搜索
  let res1 = await executeTool('search_company_brain_docs', { q: 'Scanoo 是什麼' }, ctx);
  console.log('[STEP1]', res1);

  // Step 2: 讀文件（模擬用第一條結果）
  let res2 = await executeTool('official_read_document', { document_ref: 'doc-1' }, ctx);
  console.log('[STEP2]', res2);

  // Step 3: 回答
  let res3 = await executeTool('answer_user_directly', {
    answer: `根據資料：${JSON.stringify(res2?.result || {})}`
  }, ctx);
  console.log('[STEP3]', res3);

  console.log('workflow complete');
}

run();

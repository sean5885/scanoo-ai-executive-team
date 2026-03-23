Thread99:
- 定義 planner_contract.json（actions/errors/routing_reason）
- 建 planner-contract-regression.test.mjs（覆蓋 search/invalid/no-match/fallback/ordinal）
- 對齊 executive-planner/router/doc-query（符合 contract）
- 不新增功能、不碰 cleaner/UI
- 跑：node --test && node scripts/regression-check.mjs

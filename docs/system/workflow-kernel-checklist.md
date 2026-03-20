# Workflow Kernel PR Checklist

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

1. 此變更有定義或沿用明確的 `active_task` contract，至少包含 `workflow`、`workflow_state`、`routing_hint`、`trace_id`。
2. `workflow_state` 的推進只由 orchestrator / closed-loop 收口模組負責，沒有把 terminal state 分散到 executor、lane 或 route。
3. follow-up routing 先檢查 same session，再檢查 same workflow，若需要 scope 再檢查 same scope。
4. scope 未命中時，流程會回 planner / 既有決策路徑，而不是硬吸附到舊 task。
5. preview / draft 階段只能進 REVIEW，不會在 review 前直接進 `applying` 或 `writing_back`。
6. apply / write 成功不等於完成，完成必須經 verifier gate 才能進 `completed`。
7. verifier 會檢查 required fields、欄位型別，以及關鍵欄位非空或最低 coverage。
8. verifier fail 時，流程只會回 `blocked`、retry path 或 escalation，不會直接當作完成。
9. 測試至少覆蓋 preview/review gate、verifier fail 不得 completed、以及 routing 命中/未命中規則。

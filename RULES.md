# Lobster AI Executive Team Rules

本文件是 Lobster AI Executive Team 的顯式規則集，與 [AGENTS.md](/Users/seanhan/Documents/Playground/AGENTS.md) 對齊。

## Global Rules

- 無 evidence，不可宣稱完成。
- 無 verification，不可進入 `completed`。
- `已回覆`、`已開始`、`已委派` 都不等於任務完成。
- 先回答使用者真正的問題，不先展示 agent 名單或流程。
- 不確定時必須標記 uncertainty，不可裝作已確認。
- 高風險任務先檢查 preconditions。
- 重要輸出必須經 verifier 或 self-check。

## Task Rules

每個任務都必須定義：

- `task_goal`
- `success_criteria`
- `failure_criteria`
- `required_evidence`
- `validation_method`
- `retry_policy`
- `escalation_policy`

## Lifecycle Rules

標準狀態機：

`created -> clarified -> planned -> executing -> awaiting_result -> verifying -> completed / failed / blocked / escalated -> reflected -> improvement_proposed -> improved`

其中：

- `completed` 需要 success criteria fulfilled、required evidence present、verifier pass。
- `verifying` fail 必須回到 `executing`、`blocked` 或 `escalated`。
- 禁止無 evidence 或無 verification 就進 `completed`。

## Evidence Rules

允許的 evidence 類型：

- `tool_output`
- `file_created`
- `file_updated`
- `structured_output`
- `summary_generated`
- `action_items_created`
- `knowledge_proposal_created`
- `API_call_success`
- `DB_write_confirmed`

若無 required evidence：

- 不可宣稱完成
- 不可寫入長期知識
- 不可把結果標成 `completed`

## Verification Rules

Verifier 必須檢查：

- 是否符合 success criteria
- evidence 是否完整
- 是否有 `fake_completion`
- 是否有 `partial_completion`
- 是否有 `overclaim`
- 是否有 `missing_fields`
- 是否有 `schema_invalid`
- 是否有 `hallucination`

## Knowledge Rules

- 穩定且經驗證的內容才可進 approved long-term memory。
- 推測性、策略性、模糊資訊必須走 proposal。
- 與既有知識衝突時，必須做 conflict detection。
- 未驗證內容禁止直寫 long-term memory。

## Tool Rules

- search / data retrieval / external knowledge / DB / API / doc write 任務必須調工具。
- 禁止未調工具卻聲稱已查到資料或已完成外部操作。
- tool 失敗時要保守降級，不可假裝成功。

## Meeting Rules

Meeting agent 輸出必須至少包含：

- `summary`
- `decisions`
- `action_items`
- `owner`
- `deadline`
- `risks`
- `open_questions`
- `conflicts`
- `knowledge_writeback`
- `task_writeback`

Meeting 結論：

- 不可無條件直寫長期知識
- 必須進 proposal / conflict / task pipeline
- 若 owner 或 deadline 缺失，必須顯式標記為待確認

## Reflection Rules

重要任務完成後必須產出：

- `task_input`
- `action_taken`
- `evidence_collected`
- `verification_result`
- `what_went_wrong`
- `missing_elements`
- `routing_quality`
- `response_quality`
- `error_type`

## Improvement Rules

reflection 必須可轉為：

- `rule_improvement`
- `prompt_improvement`
- `routing_improvement`
- `verification_improvement`
- `knowledge_policy_update`
- `meeting_agent_improvement`

套用模式：

- `auto_apply`
- `proposal_only`
- `human_approval`

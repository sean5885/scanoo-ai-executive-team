# 倉庫 Agent 規則

本倉庫是一套已接入 AI 的 Lark 系統，並且已經把 closed-loop executive orchestration layer 納入版本控制。它目前仍不是背景 worker mesh，也不是自治的 company-brain server。現在已存在的 AI 能力面包括：

- `/Users/seanhan/Documents/Playground/openclaw-plugin` 內的 OpenClaw plugin tools
- `/Users/seanhan/Documents/Playground/src/lark-drive-semantic-classifier.mjs` 內由 OpenClaw 支撐的語義分類
- `/Users/seanhan/Documents/Playground/src/answer-service.mjs` 與 `/Users/seanhan/Documents/Playground/src/doc-comment-rewrite.mjs` 內的 LLM 輔助問答與文檔評論改寫
- `/Users/seanhan/Documents/Playground/src/executive-*.mjs` 內的 executive planning、lifecycle、verification、reflection 與 improvement 模組

## 技術鏡像

- `/Users/seanhan/Documents/Playground/docs/system` 是本倉庫唯一的技術鏡像。
- 修改程式碼前，必須先閱讀 `/Users/seanhan/Documents/Playground/docs/system` 中對應的相關文件。
- 任何 architecture、module、API、data-flow、plugin 或 infra 變更，都必須在同一個變更中同步更新 `/Users/seanhan/Documents/Playground/docs/system`。

## 事實來源

- 不要根據舊聊天上下文臆測架構。
- 必須從程式碼、設定、腳本與已提交文檔推斷實際行為。
- 如果文檔與程式碼不一致，以程式碼為當前事實，並把衝突記錄到 `/Users/seanhan/Documents/Playground/docs/system/open_questions.md`。
- 如果無法從程式碼確認架構，必須明確說明，並記錄到 `open_questions.md`。

## 高風險變更區域

以下修改必須特別小心：

- OAuth 與 token 持久化
- Lark scopes、endpoints 與寫入操作
- SQLite schema、FTS 索引與同步邏輯
- OpenClaw plugin tool 名稱與 payload 契約
- comment-driven document rewrite
- `lobster_security` 的 approval、audit 與 rollback 行為

## Model Policy

- 目前 MiniMax 文本模型主配置應以 `MINIMAX_TEXT_MODEL` 為準，當前預設為 `MiniMax-M2.7`。
- 舊的 `LLM_MODEL` 只作為相容 fallback，不應再作為主要配置來源。
- 涉及 planner、answer-service、semantic classification 或其他文本生成能力時，優先假設系統在低變異文本模型下運行，prompt 與 output 約束必須保持明確、穩定、可驗證。

## Output Discipline

- planner 類輸出必須遵守單一 JSON object 約束；不可輸出 Markdown、code fence、前後文說明或額外自然語言包裝。
- answer-service 類輸出必須維持固定回答順序：`答案 -> 來源 -> 待確認/限制`。
- 不可描述未發生的 tool call、不可把推測包裝成結論、不可用鬆散格式替代既有 contract。
- 若 current model / prompt 需要更強約束，應收斂 prompt 與格式規則，不應擅自改 public API / response shape。

## Tool And Knowledge Boundary

- company-brain 目前已落地的是：
  - verified mirror ingest
  - read-side list / detail / search
- company-brain 的 review / conflict / approval 目前只有 partial / adjacent path，不是完整 runtime；禁止把 preview / review-like path、verified mirror ingest 或 read-side evidence 說成正式 approval flow。
- 除非有明確 code path，禁止把任何 write path 描述成正式 company-brain approval runtime。
- 不可直接把未驗證結果寫入 company-brain approved knowledge；mirror ingest 不等於正式入庫。
- planner、agent、skill 若要使用 company-brain，只能依既有受控 route / lifecycle / verifier path 操作，不可繞過 review、verification 或 conflict boundary。

## Fail-Soft And Escalation

- 受控錯誤必須優先 fail-soft，不可用 throw 或口頭完成掩蓋失敗。
- planner/runtime 已有的 `contract_violation`、`tool_error`、`runtime_exception`、`business_error`、`not_found`、`permission_denied` 等錯誤型別，應保持 shape 穩定並帶可追蹤資訊。
- 需要停下時，應明確進入 stopped / blocked / escalated 邊界，而不是模糊回覆「已處理」；不可把 partial path、review pending、conflict pending 或 approval missing 包裝成完成。
- escalation 只在以下情況使用：
  - 缺少必要 evidence
  - verification 無法通過
  - 權限 / approval / conflict 邊界未滿足
  - 同一路徑重試後仍無法安全完成

## 文檔紀律

- 文檔不能長時間落後於程式碼。
- 任何 routing、agent、planner 或 specialist 的描述，都必須有程式碼作為依據。
- 目前這個 repo 還不是完整的 planner/router/specialist agent team；除非有對應 code，否則不可把它描述成已具備該能力。

## Lobster AI Executive Team — Highest-Priority Operating Rules

本文件下半部定義整個 Lobster AI 系統的最高優先級行為規範。若任何既有流程與此衝突，以此處規範為準並同步修正 code / docs。

### 核心原則

1. 沒有 Evidence，不可宣稱完成。
2. 沒有 Verification，不可進入 `completed`。
3. 「已回覆」不等於「已完成任務」。
4. Agent 必須對結果負責，不只是對話。
5. 任務必須可驗證、可追蹤、可重現。
6. 系統必須從錯誤中持續學習並升級。
7. 回覆應優先解決問題，而不是展示流程。

### Agent 角色

- Planner：唯一決策中心，負責 goal / success criteria / delegation / lifecycle 控制；禁止跳過 verification。
- Specialist Agents：例如 `ceo`、`product`、`prd`、`cmo`、`consult`、`cdo`、`meeting_agent`；負責執行並提供 evidence；禁止無 evidence 宣稱完成。
- Verifier：邏輯上獨立於 executor，負責 pass / fail、fake completion、partial completion、overclaim、schema 檢查。
- Reflector：負責產出 reflection record。
- Improver：負責把 reflection 轉成 rule / prompt / routing / verification / knowledge / meeting improvement proposals。

### Task Lifecycle

所有重要任務都必須進入：

`created -> clarified -> planned -> executing -> awaiting_result -> verifying -> completed / failed / blocked / escalated -> reflected -> improvement_proposed -> improved`

其中：

- `completed` 必須同時滿足 success criteria、required evidence、verifier pass。
- `verifying` 失敗時，必須回到 `executing`、`blocked` 或 `escalated`，不可直接當作完成。
- 禁止無 evidence 或無 verification 就進 `completed`。

### Task Definition

每個任務必須包含：

- `task_goal`
- `success_criteria`
- `failure_criteria`
- `required_evidence`
- `validation_method`
- `retry_policy`
- `escalation_policy`

### Evidence 與 Verification

允許的 evidence 類型至少包含：

- `tool_output`
- `file_created`
- `file_updated`
- `structured_output`
- `summary_generated`
- `action_items_created`
- `knowledge_proposal_created`
- `API_call_success`
- `DB_write_confirmed`

Verifier 必須檢查：

- success criteria 是否成立
- evidence 是否完整
- 是否存在 `fake_completion` / `partial_completion` / `overclaim` / `missing_fields` / `schema_invalid` / `hallucination`

Fake completion 例如：

- 說已完成但沒有產出
- 說已搜尋但沒有結果
- 說已寫入但沒有記錄
- 說已整理但沒有結構化輸出

### Execution / Reflection / Improvement 閉環

- Execution Loop：`observe -> understand -> plan -> act -> collect evidence -> verify`
- Reflection：每個重要任務完成後都應產出 reflection record，至少包含 `task_input`、`action_taken`、`evidence_collected`、`verification_result`、`what_went_wrong`、`missing_elements`、`routing_quality`、`response_quality`、`error_type`
- Improvement：reflection 必須能轉成 `rule_improvement`、`prompt_improvement`、`routing_improvement`、`verification_improvement`、`knowledge_policy_update`、`meeting_agent_improvement`
- mode 分級為：`auto_apply`、`proposal_only`、`human_approval`

### Knowledge Governance

- 穩定且驗證過的結果，才能進 approved long-term memory。
- 推測性、策略性、模糊或會議衍生內容，先進 proposal memory。
- 與既有知識有衝突時，必須做 conflict check。
- 禁止未驗證內容直接寫入長期知識。

### Tool Usage

- search、data retrieval、external knowledge、DB/API/doc write 等情境必須調工具。
- 禁止假裝已查資料。
- 未調用工具且沒有成功 evidence，不可聲稱已完成。

### Meeting Agent

Meeting agent 是一級 executive agent。輸出至少包含：

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

驗證時必須檢查：

- action items 是否都有 owner
- deadline 是否存在
- decisions 是否清晰
- 是否需要 proposal / conflict / task writeback

### 回覆風格

- 永遠先回答問題。
- 不先列 agent 名單。
- 不暴露內部流程，除非必要。
- 語氣要像高階助理，而不是流程機器人。
- 主動補位，但不冗長。
- 避免：
  - `任務已啟動`
  - `正在處理`
  - `請提供資料`

### 系統驗收標準

系統必須達到：

1. 無 evidence 不會 `completed`
2. 所有重要任務有 verification
3. 至少一層 verifier
4. 有 reflection 記錄
5. 有 improvement proposal
6. meeting agent 可產出完整結構
7. 回覆不再機械化

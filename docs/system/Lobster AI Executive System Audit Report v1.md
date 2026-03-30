# 《Lobster AI Executive System Audit Report v1》

更新時間：2026-03-18  
盤點範圍：`/Users/seanhan/Documents/Playground` checked-in code、`/Users/seanhan/Documents/Playground/docs/system` 技術鏡像、`/Users/seanhan/Library/Logs/lark-kb-http.log` 近 7 天 log、根層規則文件  
方法說明：本報告以 code 與 checked-in docs 為準；若 docs 與 code 不一致，以 code 為現況，並在文中標記風險或衝突。

---

> Note
> 這份報告是 `2026-03-18` 的 audit baseline，不是目前 `docs/system` 的 primary current-truth mirror。
> 若 company-brain / doc flow / planner contract 與本文有落差，請以
> `/Users/seanhan/Documents/Playground/docs/system/company_brain.md`、
> `/Users/seanhan/Documents/Playground/docs/system/modules.md`、
> `/Users/seanhan/Documents/Playground/docs/system/data_flow.md`、
> `/Users/seanhan/Documents/Playground/docs/system/api_map.md`
> 與 checked-in code 為準。

## 1. 系統總覽

### 1.1 系統目標

Lobster AI Executive Team 目前是一個本地運行的 Lark 國際版知識、文檔、會議與 executive orchestration 服務。它不是單純聊天機器人，也不是已完整產品化的 company-brain 平台；目前更接近：

- Lark 內容服務層
- 本地檢索與知識治理層
- slash agent / executive orchestration 層
- meeting workflow
- verification / reflection / improvement 閉環

### 1.2 核心模組

- Runtime / Event Intake
  - `/Users/seanhan/Documents/Playground/src/index.mjs`
  - `/Users/seanhan/Documents/Playground/src/http-server.mjs`
  - `/Users/seanhan/Documents/Playground/src/runtime-observability.mjs`
- Routing / Execution
  - `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`
  - `/Users/seanhan/Documents/Playground/src/cloud-doc-organization-workflow.mjs`
- Registered Agents / Executive Orchestration
  - `/Users/seanhan/Documents/Playground/src/agent-registry.mjs`
  - `/Users/seanhan/Documents/Playground/src/agent-dispatcher.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-planner.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-orchestrator.mjs`
- Closed Loop / Reliability
  - `/Users/seanhan/Documents/Playground/src/executive-rules.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-lifecycle.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-verifier.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-reflection.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-improvement.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-improvement-workflow.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-closed-loop.mjs`
- Knowledge / Memory
  - `/Users/seanhan/Documents/Playground/src/answer-service.mjs`
  - `/Users/seanhan/Documents/Playground/src/rag-repository.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-memory.mjs`
- Meeting
  - `/Users/seanhan/Documents/Playground/src/meeting-agent.mjs`
  - `/Users/seanhan/Documents/Playground/src/meeting-audio-capture.mjs`
  - `/Users/seanhan/Documents/Playground/src/meeting-capture-store.mjs`
- Image
  - `/Users/seanhan/Documents/Playground/src/modality-router.mjs`
  - `/Users/seanhan/Documents/Playground/src/image-understanding-service.mjs`
- Lark Service Layer
  - `/Users/seanhan/Documents/Playground/src/lark-content.mjs`
  - `/Users/seanhan/Documents/Playground/src/lark-user-auth.mjs`
  - `/Users/seanhan/Documents/Playground/src/lark-sync-service.mjs`
- Plugin / Tool Exposure
  - `/Users/seanhan/Documents/Playground/openclaw-plugin/lark-kb/index.ts`

### 1.3 目前已實作能力

- Lark OAuth、token persistence、HTTP / long-connection runtime
- Drive / Wiki / Doc / Message / Calendar / Task / Bitable / Sheets / Reaction 讀寫
- SQLite + FTS + local semantic sidecar hybrid retrieval
- `/answer` 與 retrieval-grounded slash agents
- checked-in slash agents：`/generalist`、`/ceo`、`/product`、`/prd`、`/cmo`、`/consult`、`/cdo`、`/delivery`、`/ops`、`/tech`
- checked-in knowledge subcommands：`/knowledge audit|consistency|conflicts|distill|brain|proposals|approve|reject|ownership|learn`
- meeting workflow：啟動、錄音、轉譯、總結、確認、寫文檔、knowledge writeback
- executive closed loop：task lifecycle、evidence、verifier、reflection、improvement proposal、improvement approval/apply workflow
- 圖文模態分流：圖片先走 Gemini `generateContent` 型 image understanding adapter，再決定是否交文本模型整合

### 1.4 未完成能力

- 未完成：真正 tenant-wide `company_brain`/memory graph
- 未完成：背景 worker queue 與長生命週期 subagents
- 未完成：planner 完整接管所有 lane；目前仍有不少 heuristic workflow 在 `lane-executor.mjs`
- 未完成：meeting 仍是 specialized workflow，不是 fully planner-managed subtask tree
- 未完成：knowledge system 的 proposal / approve / reject 雖已具備閉環元件，但還不是完整產品化治理平台
- 未完成：hosted deployment topology 與 production scopes 無法從 repo 直接確認

### 1.5 總體運作方式摘要

1. 使用者從 Lark DM / 群組 / HTTP 請求進入系統  
2. Runtime 產生 `trace_id`，進入 lane routing  
3. 若命中 slash agent 或 active executive task，轉入 executive orchestration  
4. 若是 meeting / cloud-doc organization / image / doc-rewrite 等特定 workflow，走對應 specialized path  
5. 工具透過 `lark-content.mjs` 或 OpenClaw plugin 層執行  
6. 重要任務產生 evidence，進 verifier  
7. verifier 通過才可 `completed`  
8. 之後產生 reflection record 與 improvement proposal  
9. improvement 可進 approval / apply workflow

---

## 2. Agent 全量盤點

說明：目前 repo 內真正存在的 agent 分兩類：

- checked-in slash agents：在 `/Users/seanhan/Documents/Playground/src/agent-registry.mjs`
- workflow agent：meeting agent、cloud-doc organization workflow、knowledge answer / rewrite 等 specialized workflows

### 2.1 `/generalist`

- 名稱：`generalist`
- 職責：通用綜合回覆、灰區問題收斂、沒有更明確 specialist 時兜底
- 能做什麼：
  - retrieval-grounded 回答
  - 總結、下一步建議
  - executive task primary agent
- 不能做什麼：
  - 不應直接宣稱已完成 write 型任務，除非有 evidence
  - 不應代替 specialized agent 做高專業判斷
- 觸發條件：`/generalist` 或 planner / router 導向
- 輸入：
  - `request_text`
  - `scope`
  - `event`
  - optional `image_context`
  - optional `supporting_context`
- 輸出：
  - `text`
  - `agentId`
- 依賴知識：`answer-service` 檢索結果
- 依賴工具：`knowledge_search`、`image_understanding`、`text_generation`
- 是否具備驗證機制：有，透過 closed-loop verifier
- 是否具備學習/回寫能力：有，reflection / improvement proposal；知識回寫依 task type 決定
- 目前已知問題：
  - 容易承接本應由更專責 workflow 處理的 follow-up
  - 在 lane 誤路由時仍可能變成機械兜底

### 2.2 `/ceo`

- 名稱：`ceo`
- 職責：高層決策整合、優先級、風險、資源取捨
- 能做什麼：決策建議、風險盤點、下一步判斷
- 不能做什麼：不應僅輸出摘要；不應無依據拍板
- 觸發條件：`/ceo` 或 planner handoff
- 輸入：同 slash agent 標準 schema
- 輸出：決策建議 / 判斷依據 / 主要風險 / 建議下一步
- 依賴知識：檢索片段、supporting agent context
- 依賴工具：`knowledge_search`、`image_understanding`、`text_generation`
- 是否具備驗證機制：有
- 是否具備學習/回寫能力：有，透過 reflection/improvement；不直接寫 long-term memory
- 目前已知問題：
  - 若 evidence 稀薄，容易只整理檢索結果，未必真的形成高質量 executive synthesis

### 2.3 `/product`

- 名稱：`product`
- 職責：產品問題拆解、使用者價值、範圍與取捨
- 能做什麼：產品觀點整理、範圍界定、價值判斷
- 不能做什麼：不應當成 PRD 輸出器或工程規格器
- 觸發條件：`/product` 或 planner handoff
- 輸入：同 slash agent 標準 schema
- 輸出：核心問題 / 使用者價值 / 建議方向 / 待確認
- 依賴知識：檢索知識、可能的 image structured context
- 依賴工具：`knowledge_search`、`image_understanding`、`text_generation`
- 驗證機制：有
- 學習/回寫：有，提案性輸出可經 proposal 流
- 已知問題：
  - 仍偏向檢索後生成，不是長程產品記憶代理

### 2.4 `/prd`

- 名稱：`prd`
- 職責：將已確認方向轉成 PRD-like 結構
- 能做什麼：輸出固定欄位的 PRD 片段
- 不能做什麼：不應在需求不明時假裝需求已確認
- 觸發條件：`/prd`
- 輸入：同 slash agent 標準 schema
- 輸出：背景、目標、範圍、非目標、驗收、風險、待確認
- 依賴知識：檢索片段
- 依賴工具：`knowledge_search`、`text_generation`
- 驗證機制：有，`prd_generation` checklist
- 學習/回寫：有 reflection/improvement；PRD 內容本身不自動回寫知識
- 已知問題：
  - 驗收與風險雖有 checklist，但輸出仍依模型質量

### 2.5 `/cmo`

- 名稱：`cmo`
- 職責：市場、品牌、訊息、增長
- 能做什麼：受眾、訊息、動作建議、風險
- 不能做什麼：不應替代 consult/ceo 做投資與戰略拍板
- 觸發條件：`/cmo`
- 輸入：同 slash agent 標準 schema
- 輸出：受眾 / 訊息 / 動作建議 / 風險
- 依賴知識：檢索片段、支援 agent context
- 依賴工具：`knowledge_search`、`image_understanding`、`text_generation`
- 驗證機制：有
- 學習/回寫：有
- 已知問題：
  - 若缺直接證據，仍可能給出偏策略性的保守結論

### 2.6 `/consult`

- 名稱：`consult`
- 職責：問題定義、方案比較、商業/策略分析
- 能做什麼：結構化診斷與方案比較
- 不能做什麼：不應取代資料/財務實算
- 觸發條件：`/consult`
- 輸入：同 slash agent 標準 schema
- 輸出：問題定義 / 觀察 / 方案比較 / 建議
- 依賴知識：檢索片段
- 依賴工具：`knowledge_search`、`text_generation`
- 驗證機制：有
- 學習/回寫：有
- 已知問題：
  - 容易把灰區問題擴成分析任務，導致篇幅拉長

### 2.7 `/cdo`

- 名稱：`cdo`
- 職責：資料治理、流程治理、度量設計
- 能做什麼：owner 建議、治理目標、指標或流程建議
- 不能做什麼：不應假定數據已存在
- 觸發條件：`/cdo`
- 輸入：同 slash agent 標準 schema
- 輸出：治理目標 / 現況缺口 / 指標或流程 / 下一步
- 依賴知識：檢索片段
- 依賴工具：`knowledge_search`、`text_generation`
- 驗證機制：有
- 學習/回寫：有
- 已知問題：
  - 在文檔分類/owner 分配任務中，與 cloud-doc workflow 邊界仍有重疊

### 2.8 `/delivery`

- 名稱：`delivery`
- 職責：交付進度、阻塞與對外交付風險
- 能做什麼：交付狀態 / 阻塞 / 風險 / 行動
- 不能做什麼：不應代替 PMO / task system 實際分派
- 觸發條件：`/delivery`
- 輸入：同 slash agent 標準 schema
- 輸出：交付狀態 / 阻塞 / 風險 / 建議行動
- 依賴知識：檢索片段
- 依賴工具：`knowledge_search`、`text_generation`
- 驗證機制：有
- 學習/回寫：有
- 已知問題：目前較少實際 workflow 鏈接，偏 persona shell

### 2.9 `/ops`

- 名稱：`ops`
- 職責：營運流程、SOP、例外處理
- 能做什麼：整理現況、SOP、下一步
- 不能做什麼：不應宣稱已執行營運動作
- 觸發條件：`/ops`
- 輸入：同 slash agent 標準 schema
- 輸出：現況 / SOP 建議 / 例外處理 / 下一步
- 依賴知識：檢索片段
- 依賴工具：`knowledge_search`、`text_generation`
- 驗證機制：有
- 學習/回寫：有
- 已知問題：目前缺少專屬 tool chain，仍偏回答型 agent

### 2.10 `/tech`

- 名稱：`tech`
- 職責：技術架構、實作風險、工程決策
- 能做什麼：技術判斷 / 方案 / 風險 / 執行順序
- 不能做什麼：不應把未查證的 repo 現況當事實
- 觸發條件：`/tech`
- 輸入：同 slash agent 標準 schema
- 輸出：技術判斷 / 方案 / 風險 / 建議執行順序
- 依賴知識：檢索片段
- 依賴工具：`knowledge_search`、`text_generation`
- 驗證機制：有
- 學習/回寫：有
- 已知問題：若要針對 repo 做真實技術診斷，仍需要額外工程工具接入

### 2.11 Knowledge 系列 agents

以下 agents 都在 `/Users/seanhan/Documents/Playground/src/agent-registry.mjs` 有真實 checked-in 註冊，觸發方式為 `/knowledge <subcommand>`：

- `audit`
- `consistency`
- `conflicts`
- `distill`
- `brain`
- `proposals`
- `approve`
- `reject`
- `ownership`
- `learn`

共同特徵：

- 職責：以檢索到的文件片段為基礎，做知識盤點、衝突、提案、owner 建議或學習整理
- 能做什麼：
  - audit：盤點覆蓋、缺口、重複
  - consistency：比對版本/口徑一致性
  - conflicts：找出衝突並提出建議確認版
  - distill：蒸餾最小知識卡
  - brain：整體理解拼裝
  - proposals：知識治理提案
  - approve / reject：針對提案做批准/拒絕觀點
  - ownership：合理 owner 建議
  - learn：把新材料整理為可學習內容
- 不能做什麼：
  - 不能無 evidence 直接宣稱已更新 long-term knowledge
  - 不能保證全庫一致性，只能基於檢索與比較結果
- 觸發條件：`/knowledge <subcommand>`
- 輸入：同 slash agent 標準 schema
- 輸出：依 subcommand 決定，但均為結構化段落式結果
- 依賴知識：Lark 檢索結果、semantic classifier、局部 image understanding
- 依賴工具：`knowledge_search`、`semantic_classifier`、`image_understanding`、`text_generation`
- 是否具備驗證機制：有，透過 search / knowledge_write / proposal_creation 等 checklist
- 是否具備學習/回寫能力：
  - 有 pending proposal memory
  - approve/apply workflow 已存在
  - 不是所有子命令都會自動回寫
- 目前已知問題：
  - 更像治理工具集合，不是完整 knowledge OS
  - 仍偏 retrieval + synthesis，非真正圖譜推理
  - `/knowledge brain` 是拼裝理解，不是 concrete `company_brain`

### 2.12 `meeting_agent`

- 名稱：meeting agent
- 職責：會議逐字稿/筆記 ingest、分類、摘要、決策、行動項、knowledge/task writeback
- 能做什麼：
  - 接 `/meeting`
  - 接自然語言會議啟動
  - chat-scoped capture
  - 可選本機錄音與 `faster-whisper`
  - 產出 structured meeting artifact
  - 寫會議文檔
  - 產生 knowledge writeback proposals
- 不能做什麼：
  - 不是 slash registry 內的一般 specialist
  - 不是完整 planner-managed subtask tree
  - 不是穩定的真即時會議機器人平台
- 觸發條件：
  - `/meeting ...`
  - `會議/会议/meeting`
  - `我要開會了`
  - `線下會議 請記錄`
  - `okr 周例會`
  - `現在正要開始 請準備記錄吧`
- 輸入：
  - transcript
  - chat capture
  - optional context
  - optional attendees
  - optional images
- 輸出：
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
  - `follow_up_recommendations`
- 依賴知識：會議內容本身、必要時補充外部上下文
- 依賴工具：
  - doc create/update
  - sendMessage/replyMessage
  - meeting confirmation storage
  - local audio capture
  - local transcription
- 是否具備驗證機制：有，`meeting_processing` checklist
- 是否具備學習/回寫能力：有，會進 reflection/improvement 與 knowledge proposal memory
- 目前已知問題：
  - meeting 仍是專門 workflow，不是 planner 完整一級子任務系統
  - 錄音與 chat capture 仍可能因重啟/設備/權限中斷
  - 會議內容不直接進 approved memory，需 proposal/approve，這是設計正確但使用體驗較慢

---

## 3. 任務流轉機制

### 3.1 任務如何進入系統

- Lark long connection：`src/index.mjs`
- HTTP routes：`src/http-server.mjs`
- slash command：由 `lane-executor` 先解析，再進 `agent-dispatcher` / `executive-orchestrator`

### 3.2 planner / router / specialist 如何協作

理想流程：

1. router 判斷意圖與模態  
2. planner 決定是否直接回答 / specialist / multi-agent 協作  
3. specialist 執行並提供 evidence  
4. synthesizer 收斂  
5. verifier 驗證  
6. 反思與升級提案

實際流程：

1. `lane-executor.mjs` 先做大量 heuristic lane / workflow 判斷  
2. 若命中 slash agent 或 active executive task，再進 `executive-planner.mjs` / `executive-orchestrator.mjs`  
3. 若未命中，可能由 specialized workflow 或普通 lane 直接處理  
4. 重要 executive task 會進 closed loop；但不是所有普通回覆都一定會進完整 verifier

### 3.3 任務完成判定方式

實際上已存在規則：

- `executive-rules.mjs` 定義 task goal / success / evidence / validation / retry / escalation
- `executive-verifier.mjs` 根據 evidence 與 checklist 判斷 pass/fail
- `executive-lifecycle.mjs` 要求 `completed` 前先 `verifying`

### 3.4 失敗重試、升級、人工審核

- verifying fail：回到 `executing`、`blocked` 或 `escalated`
- fake completion：優先 `escalated`
- improvement proposal：
  - `auto_apply`
  - `proposal_only`
  - `human_approval`
- knowledge / meeting writeback：
  - 先 proposal / pending
  - 再 approve / apply

### 3.5 主要現實偏差

- `lane-executor.mjs` 仍然很大，很多 follow-up 先靠 heuristic，不是純 planner-managed
- 一些 conversational path 仍可能繞過完整 executive verifier
- workflow mode 與 executive task mode 並存，造成邊界易混淆

---

## 4. 知識流與記憶流

### 4.1 company_brain 的資料來源

- 真正 concrete data sources：
  - Lark Drive / Wiki / Doc / Message / Meeting outputs
  - SQLite chunks / FTS / semantic sidecar
  - executive memory stores
- `company_brain` 本身：
  - 目前沒有一個獨立、已實作的 `company_brain` module
  - 報告中如提及 `company_brain`，應視為概念層，不是 checked-in concrete implementation

### 4.2 intake / indexing / retrieval / update

1. sync connectors 掃描 Drive / Wiki / Doc  
2. 內容切塊，存到 SQLite / FTS / semantic sidecar  
3. `answer-service` 與 slash agents 走 retrieval  
4. 重要產出可進：
   - session memory
   - pending proposal memory
   - approved memory

### 4.3 哪些 agent 讀哪些知識

- 一般 slash agents：讀 `answer-service` 檢索片段
- knowledge 系列：讀檢索片段，部分用 semantic classifier
- meeting agent：以 transcript / chat capture 為主，必要時補上下文
- executive orchestrator：讀 active task state、supporting outputs、檢索上下文

### 4.4 是否存在全量污染

- 目前已有 compaction 與 checkpoint summary，避免長歷史全灌模型
- 但知識風險仍存在：
  - company-level graph 未實作
  - proposal / approved / session store 都是 local JSON / local-first persistence
  - 若使用者把大量異質內容同步進同一帳號空間，分類/owner/brain 還是可能被混淆

### 4.5 版本控制

- 文件層：依 Lark 原始文件 metadata / updated_at
- 應用層：沒有完整版本圖譜；靠檢索與 consistency/conflicts 分析
- improvement proposals：有 id / status / applied state

### 4.6 知識衝突檢測

- 已有 `/knowledge consistency` 與 `/knowledge conflicts`
- `KNOWLEDGE_RULES` 明確要求 conflict detection conditions
- meeting structured result 也包含 `conflicts`

### 4.7 回寫與審核機制

- approved long-term memory：`appendApprovedMemory`
- pending proposal memory：`createPendingKnowledgeProposal`
- improvement approval workflow：HTTP routes + proposal store
- meeting writeback：先進 pending proposal memory，不直寫 long-term

### 4.8 目前主要知識風險

- company_brain 仍是概念，不是產品化 graph
- proposal memory / approved memory 仍是 local-first file storage
- knowledge flows 能生成治理輸出，但不是 end-to-end autonomous governance OS
- 文檔/分類 follow-up 很容易受 heuristic workflow 邊界影響

---

## 5. 工具層盤點

### 5.1 OpenClaw plugin tools

真實工具註冊檔案：`/Users/seanhan/Documents/Playground/openclaw-plugin/lark-kb/index.ts`

主要工具族群：

- Knowledge
  - `lark_kb_status`
  - `lark_kb_sync`
  - `lark_kb_search`
  - `lark_kb_answer`
- Docs / Comments
  - `lark_doc_read`
  - `lark_doc_create`
  - `lark_doc_update`
  - `lark_doc_comments`
  - `lark_doc_rewrite_from_comments`
  - `lark_doc_comment_suggestion_card`
- Messages
  - `lark_messages_list`
  - `lark_messages_search`
  - `lark_message_get`
  - `lark_message_reply`
  - `lark_message_reply_card`
  - reactions 系列
- Calendar / Tasks
  - `lark_calendar_primary`
  - `lark_calendar_events`
  - `lark_calendar_search`
  - `lark_calendar_create_event`
  - `lark_calendar_freebusy`
  - `lark_tasks_list`
  - `lark_task_get`
  - `lark_task_create`
  - `lark_task_comments`
  - `lark_task_comment_create/update/delete`
- Bitable / Sheets
  - app/table/record CRUD
  - spreadsheet create/list/replace
- Drive / Wiki
  - list/create/move/delete/organize
  - wiki spaces/nodes/create/move/organize
- Security
  - `lobster_security_*`

### 5.2 功能、輸入輸出、權限與健壯性

- 功能：對應 Lark 各 domain 的 HTTP API 操作與 OpenClaw tool 暴露
- 輸入輸出格式：
  - plugin 層有明確 tool name 與 payload contract
  - 大結果會壓縮到 `TOOL_OUTPUT_MAX_CHARS`
- 權限控制：
  - 主要依賴 user OAuth / tenant token / Lark console scopes
  - 真實 production scope set 無法從 repo 完整確認
- timeout / retry / fallback / logging：
  - plugin 層有 `AbortController` timeout
  - core service 層有部分 retry / child logger / trace
  - 群組/訊息發送已有最小 retry
- 目前存在的問題：
  - scope/console 仍是外部依賴
  - 某些高層 workflow 只是把工具接上，不代表完整產品流程
  - Bitable / Sheets 已有基礎 CRUD，但還未 fully productized

### 5.3 哪些 agent 可調用哪些工具

- slash agents：主要調 `knowledge_search`、`image_understanding`、`text_generation`
- executive orchestrator：透過 registered agent 與 underlying search/image/text service 間接調用
- meeting agent：調 doc create/update、message send/reply、transcription、proposal writeback
- HTTP routes：直接調 `lark-content.mjs`

---

## 6. 規則層與決策邊界

### 6.1 planner 是否唯一決策中心

- 設計上：planner 是 closed-loop 任務的決策中心
- 現實上：不是唯一
  - `lane-executor.mjs` 仍保有大量 heuristic workflow 決策權
  - meeting、cloud-doc organization、doc rewrite 等 specialized workflow 不是完全由 planner 統一調度

### 6.2 specialist 是否可自行改 plan

- 形式上：specialist 透過 task state / supporting context 執行，不應重寫總體目標
- 現實上：supporting output 仍可能影響 primary synthesis，但真正 plan ownership 在 planner/orchestrator

### 6.3 哪些任務允許自動執行

- 檢索/分析/摘要型：可自動執行
- 文檔 preview / comment suggestion / meeting summary：可自動產出
- 低風險 improvement proposal：可 `auto_apply`

### 6.4 哪些任務必須人工審核

- 高風險 improvement
- knowledge proposal / approve / reject
- comment rewrite 真正 apply
- meeting preview path 的文檔寫入確認

### 6.5 哪些情況必須拒絕或回報不確定

- evidence 不足
- 工具未成功
- 來源不存在
- owner/deadline 缺失
- 衝突未解決

### 6.6 agent 權限邊界與越權風險

- 已有 global rules：無 evidence 不可宣稱 completed
- 風險仍在：
  - heuristic workflow 可能讓非預期 lane 先接到任務
  - user OAuth / tenant token fallback 混用時，權限語義對使用者未必清楚
  - `lobster_security` 是獨立 Python 子系統，契約漂移仍是風險

---

## 7. 驗證與閉環

### 7.1 任務驗證方式

- `executive-verifier.mjs` 根據 task type 跑 checklist
- evidence types 已明確定義
- completion 需 `required_evidence_present` + `pass`

### 7.2 誰負責驗證

- Verifier 與 executor 已邏輯分離：
  - executor/orchestrator 負責做事
  - verifier module 負責判定

### 7.3 是否存在 verify agent 或自檢流程

- 有 verifier stage
- 有 `npm run self-check`
- 有 route trace / step log / smoke tests / integration-like tests

### 7.4 是否有結果格式檢查 / 業務完成檢查

- 有：
  - PRD checklist
  - meeting checklist
  - knowledge write checklist
  - task assignment checklist
- 但不是每種自然語言對話都必定走完整業務驗證

### 7.5 是否有錯誤回滾

- document rewrite / meeting confirm 有 confirmation 與 pending artifacts
- `lobster_security` 有 rollback route
- 但對一般 slash agent 回覆，沒有 transaction-style rollback

### 7.6 是否有錯誤案例沉澱

- 有 reflection store
- 有 improvement proposal store
- 有 improvement approval/apply workflow

### 7.7 是否能根據錯誤迭代規則

- 可以產生：
  - rule_improvement
  - prompt_improvement
  - routing_improvement
  - verification_improvement
  - knowledge_policy_update
  - meeting_agent_improvement
- 但目前仍偏 local proposal workflow，不是自動全局 rule compiler

---

## 8. 最近 7 天真實問題案例

### 案例 1：多 runtime responder 競爭

- 問題名稱：Lark 回覆來源混亂
- 發生場景：同一帳號同時可能存在 `Playground` 與歷史 responder
- 期望行為：所有回覆都由當前 `Playground` 代碼產生
- 實際行為：曾出現回覆不屬於目前 repo code 的固定文案
- 問題分類：runtime collision
- 可能根因：`com.seanhan.lark-kb-http` 與外部/歷史 `ai.openclaw.gateway`、`lobster.*` 共存
- 臨時修法：加入 `runtime-conflict-guard`
- 建議根治方案：把 runtime ownership 做成 operator-visible health contract，並在開機或 deploy 時強檢查單一 responder

### 案例 2：meeting session 在、錄音進程不在

- 問題名稱：會議看似持續，但實際未錄音
- 發生場景：meeting capture 過程中服務重啟或錄音進程丟失
- 期望行為：若錄音中斷，系統應明確告知並可恢復或重啟
- 實際行為：一度出現「會議記錄模式仍在進行中」但本機錄音顯示未啟動/已停止
- 問題分類：state split / fake continuity
- 可能根因：session state 與 recorder process metadata 未同持久化
- 臨時修法：把錄音 metadata 持久化並在狀態查詢時檢查進程
- 建議根治方案：將 capture session 與 recorder lifecycle 做成單一 state machine，並在重啟時做 recover / reconcile

### 案例 3：圖片任務分流了，但 Gemini/Nano Banana 鏈未完全打通

- 問題名稱：圖片分析回 `missing_nano_banana_config` 或無法解讀 Lark 私有圖片
- 發生場景：使用者貼圖並要求解釋、分析
- 期望行為：圖片進 image model，拿到人話結果
- 實際行為：曾只回 provider/config 錯誤，或因 `image_key` 路徑不完整而失敗
- 問題分類：image pipeline gap
- 可能根因：API key/base URL、`generateContent` 適配、`image_key` 下載缺口
- 臨時修法：改成 Gemini `generateContent` 路徑，補 `downloadMessageImage`
- 建議根治方案：加 end-to-end Lark private image smoke 與更人話的 image failure adapter

### 案例 4：cloud-doc follow-up 掉錯 workflow

- 問題名稱：分類/角色分配追問常退回第一輪總覽或 generic boilerplate
- 發生場景：使用者追問「為什麼不能直接分配」「哪些要二次確認」
- 期望行為：保留在第二輪 review / reason explainer
- 實際行為：曾掉回分類總覽或 generic private-assistant 文案
- 問題分類：wrong_routing / workflow drift
- 可能根因：follow-up 仍先經 `lane-executor` heuristic，mode 恢復不穩
- 臨時修法：拆出 `cloud-doc-organization-workflow.mjs` 並補 regression
- 建議根治方案：把這類 multi-turn workflow 進一步狀態機化，而不是再加 trigger phrases

### 案例 5：user OAuth refresh 失效，導致 meeting/doc 流程斷裂

- 問題名稱：同一條任務一遇 user token 問題就掉 generic 文案
- 發生場景：meeting、doc create/update、文檔整理 follow-up
- 期望行為：明確區分 user token、tenant token fallback 與權限語義
- 實際行為：曾頻繁出現 `user OAuth refresh 有問題` 類 boilerplate
- 問題分類：auth fallback leakage
- 可能根因：token refresh 失效與 fallback policy 對上游回覆風格耦合
- 臨時修法：tenant token fallback、child logger、meeting/doc repair
- 建議根治方案：auth context resolution 應輸出統一狀態機，而不是把 fallback 細節外露給使用者

---

## 9. Prompt / Rules 摘要

### 9.1 planner prompt 核心規則

來源：`/Users/seanhan/Documents/Playground/src/executive-planner.mjs`

- planner 輸出 JSON：
  - `action`
  - `objective`
  - `primary_agent_id`
  - `next_agent_id`
  - `supporting_agent_ids`
  - `reason`
  - `pending_questions`
  - `work_items`
- 現實上 planner 有兩層：
  - heuristic planner
  - LLM planner
- 缺漏點：
  - 仍 heavily 依賴文字 signal，非完整 task graph planner

### 9.2 router prompt / routing 核心規則

來源：`lane-executor.mjs`、`modality-router.mjs`

- 先判 lane / workflow / slash command / image modality
- 會根據 active executive task、meeting mode、cloud-doc organization mode 做續接
- 缺漏點：
  - routing 仍有 heuristic 重量過高的現象
  - follow-up 容易被 lane 層搶先解釋

### 9.3 specialist prompts 核心規則

來源：`agent-dispatcher.mjs`

- 先直接回答真正問題
- 不先列 agent 名單、流程、內部 routing
- 證據不足要標不確定
- 使用 compact system prompt + retrieved context + optional image/supporting context

### 9.4 verify / memory / meeting prompt 規則摘要

- verifier：以 checklist + evidence types 為核心
- memory：
  - session memory
  - approved memory
  - pending proposal memory
- meeting：
  - fixed-format summary
  - malformed JSON retry
  - structured result 必含 summary/decisions/action_items/owner/deadline/risks/open_questions/conflicts/knowledge_writeback/task_writeback

### 9.5 規則重疊、衝突、缺漏點

- 規則重疊：
  - `AGENTS.md` / `RULES.md` / `executive-rules.mjs` 都在約束 evidence + verification
- 衝突：
  - `README.md` 仍寫 `/answer` 無 `LLM_API_KEY` 時 fallback 為 extractive answer
  - code 現況是先走 OpenClaw MiniMax text path，失敗後才 retrieval-summary fallback
- 缺漏：
  - `meeting` 不在 slash registry 內，與其他 registered agents 的治理方式不同
  - `company_brain` 只存在概念敘事，沒有 concrete module

---

## 10. 系統成熟度評估

以 1-5 分評估：

- 架構清晰度：3/5
  - 主要模組已分出來，但 `lane-executor`、`http-server` 仍偏重
- 任務規劃能力：3/5
  - 有 planner / work_items / handoff，但仍偏 thin orchestration
- 路由準確度：2.5/5
  - 基礎已改善，但 follow-up / mode restoration 仍是高風險點
- 知識可靠性：3/5
  - retrieval、conflict、proposal、approved/pending memory 都有，但 company brain 未落地
- agent 分工清晰度：3.5/5
  - slash registry 清楚；meeting / workflow 類仍混雜
- 工具穩定性：3.5/5
  - Lark service surface 很完整，HTTP trace 也補齊；真正產品化程度仍參差
- 驗證能力：4/5
  - verifier、evidence、task lifecycle 已存在且 checked-in
- 回寫能力：3/5
  - doc write / knowledge proposal / improvement apply 都有，但不是全鏈統一
- 自我修復能力：3/5
  - reflection + improvement workflow 已存在；還不是自動全局自我優化
- 生產可用性：3/5
  - 本地單機可用；多 runtime、外部 scope、token、hosted topology 仍是風險

---

## A. 最危險的 3 個問題

1. `lane-executor.mjs` 仍過大且掌握過多 heuristic routing，導致 follow-up 容易掉錯 workflow。  
2. `company_brain` / tenant-wide memory graph 尚未落地，knowledge system 容易被誤解成完整知識中樞。  
3. Auth / runtime / console scope 仍有外部依賴，會讓表面看似已接通的鏈路在實際使用時斷掉。

## B. 最該優先修復的 3 個模組

1. `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`
2. `/Users/seanhan/Documents/Playground/src/http-server.mjs`
3. `/Users/seanhan/Documents/Playground/src/meeting-agent.mjs`

## C. 兩週內最值得落地的 3 個升級項

1. 把高頻 multi-turn workflow 全面狀態機化，降低 heuristic lane 搶答  
2. 為 meeting、knowledge write、doc write 建 end-to-end success/failure fixtures  
3. 補一個真正可查詢的 executive telemetry 視圖：verification pass rate、fake completion rate、wrong routing rate、meeting completeness rate

## D. 一句話總結目前系統卡點

目前系統最大的卡點不是功能不存在，而是「同時存在進階閉環能力與大量 heuristic workflow」，導致實際體驗仍會在高階設計與基礎鏈路之間反覆失真。

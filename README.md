# Lobster AI Executive Team

這個專案是一個給 OpenClaw / 龍蝦使用的 Lark 國際版知識、文檔、會議與 executive orchestration 本地服務。

重點是：
- 使用 `larksuite.com`，不是 Feishu
- 透過 `user OAuth` 同步使用者可見的整個知識庫
- 支援 `Drive`、`Docx`、`Wiki`
- 把內容切塊後寫入 SQLite FTS 索引
- 補上 local semantic embedding sidecar 做 hybrid retrieval
- 對外提供 `/sync/full`、`/sync/incremental`、`/search`、`/answer`
- 內建 slash agents、executive orchestration、meeting workflow、verification/reflection/improvement closed loop

## System Mirror

系統技術鏡像在：

- [/Users/seanhan/Documents/Playground/docs/system](/Users/seanhan/Documents/Playground/docs/system)
- 根層規則與升級文件：
  - [/Users/seanhan/Documents/Playground/RULES.md](/Users/seanhan/Documents/Playground/RULES.md)
  - [/Users/seanhan/Documents/Playground/ARCHITECTURE.md](/Users/seanhan/Documents/Playground/ARCHITECTURE.md)
  - [/Users/seanhan/Documents/Playground/IMPROVEMENT.md](/Users/seanhan/Documents/Playground/IMPROVEMENT.md)
- 文件整理回覆規格：
  - [/Users/seanhan/Documents/Playground/docs/system/file_organization_reply_spec.md](/Users/seanhan/Documents/Playground/docs/system/file_organization_reply_spec.md)
- Binding / Session / Workspace 規格：
  - [/Users/seanhan/Documents/Playground/docs/system/binding_session_workspace.md](/Users/seanhan/Documents/Playground/docs/system/binding_session_workspace.md)
- 閉環架構與升級說明：
  - [/Users/seanhan/Documents/Playground/docs/system/closed_loop.md](/Users/seanhan/Documents/Playground/docs/system/closed_loop.md)
  - [/Users/seanhan/Documents/Playground/docs/system/lobster_v2_upgrade.md](/Users/seanhan/Documents/Playground/docs/system/lobster_v2_upgrade.md)

之後若 code、API、資料流、plugin tools 或安全流程有變動，應同步更新這裡的文件。

## Routing Eval Closed Loop

固定操作入口：

```bash
npm run routing:closed-loop
npm run routing:closed-loop -- rerun
```

這條路徑會把 routing regression 操作固定成 `eval -> candidates -> review -> dataset -> eval`，artifact 會寫到 `.tmp/routing-eval-closed-loop/<session-id>/`。
目前 `routing-eval`、prepare、rerun 都以 `diagnostics_summary` 作為單一決策視圖。
完整 runbook 見：

- [/Users/seanhan/Documents/Playground/docs/system/routing_eval_closed_loop_runbook.md](/Users/seanhan/Documents/Playground/docs/system/routing_eval_closed_loop_runbook.md)

## 架構說明

### OAuth

- 使用 `https://open.larksuite.com/open-apis/authen/v1/authorize`
- 取得 `authorization_code`
- 交換 `user_access_token / refresh_token`
- 支援 refresh
- 預設 scope 包含 `offline_access`
- 文件讀取 scope 使用 `docs:document.content:read`
- 若要直接建立 / 更新 docx，還需要 `docx:document:create`、`docx:document:readonly`、`docx:document:write_only`
- 若要使用評論、訊息、日曆、任務、Bitable、Sheets，還需要在 Lark Developer Console 補對應產品權限
- 若要加密本地 token，請設定 `LARK_TOKEN_ENCRYPTION_SECRET`

### Connectors

- Drive connector
  - 遞迴掃描 `drive/v1/files`
  - 記錄 `file_token / title / type / parent / url / modified_time`
- Docx connector
  - 對 `docx` 抓純文字內容
  - 先走 `docx.v1.document.rawContent`
  - 失敗時 fallback `docs.v1.content.get(markdown)`
- Wiki connector
  - 列 `wiki/v2/spaces`
  - 掃 `wiki/v2/space_node/list`
  - 對 wiki node 掛載的 `docx` 抓實際內容

### Indexing

- `normalizeText`
- `chunkText`，預設 `1000 chars`、overlap `180`
- local semantic embedding，預設 `128 dims`
- metadata:
  - `source_type`
  - `title`
  - `url`
  - `file_token / node_id`
  - `updated_at`
  - `parent_path`
- 存進 SQLite:
  - 結構化表
  - `FTS5` 搜尋表

### Search / Answer

- `/search?q=`
  - 先用 SQLite FTS
  - 若關鍵詞檢索太弱，補 local semantic embedding 檢索
- `/answer?q=`
  - 先 search top-k
  - 若有 `LLM_API_KEY`，走 OpenAI-compatible chat completions
  - 否則 fallback 為 extractive answer
  - 回傳來源 `title + url`

## 專案目錄

```text
src/
  answer-service.mjs
  chunking.mjs
  config.mjs
  db.mjs
  index.mjs
  lark-connectors.mjs
  lark-content.mjs
  lark-sync-service.mjs
  lark-user-auth.mjs
  rag-repository.mjs
  text-utils.mjs
  token-store.mjs
scripts/
  check-auth.mjs
.data/
  lark-rag.sqlite
```

## 資料表設計

- `lark_accounts`
- `lark_tokens`
- `lark_sources`
- `lark_documents`
- `lark_chunks`
- `sync_jobs`

另外有：
- `lark_chunks_fts`：SQLite FTS5 搜尋表

## API Routes

### OAuth

- `GET /oauth/lark/login`
- `GET /oauth/lark/callback`
- `GET /api/auth/status`
- `POST /api/runtime/resolve-scopes`
- `GET /api/runtime/sessions`
  - 會一起顯示 capability lane，例如 `group-shared-assistant`、`personal-assistant`、`doc-editor`、`knowledge-assistant`

### Lark browse

- `GET /api/drive/root`
- `GET /api/drive/list`
- `GET /api/doc/read`
- `POST /api/doc/create`
- `POST /api/doc/update`
  - `mode=replace` 會先回 preview 與 `confirmation_id`
  - 真正覆寫必須第二次帶 `confirm=true` 與 `confirmation_id`
- `GET /api/doc/comments`
- `POST /api/doc/comments/suggestion-card`
- `POST /api/doc/comments/poll-suggestion-cards`
- `POST /api/doc/rewrite-from-comments`
  - preview 會回 `confirmation_id`
  - preview 會附 `rewrite_preview_card`
  - 真正套用必須第二次帶 `apply=true`、`confirm=true` 與 `confirmation_id`
  - preview 會附 `patch_plan`
- `GET /api/messages`
- `GET /api/messages/search`
- `GET /api/messages/:message_id`
- `POST /api/messages/reply`
- `POST /api/messages/reply-card`
- `GET /api/calendar/primary`
- `GET /api/calendar/events`
- `POST /api/calendar/events/search`
- `POST /api/calendar/events/create`
- `POST /api/calendar/freebusy`
- `GET /api/tasks`
- `GET /api/tasks/:task_id`
- `POST /api/tasks/create`
- `GET /api/tasks/:task_id/comments`
- `POST /api/tasks/:task_id/comments`
- `GET /api/tasks/:task_id/comments/:comment_id`
- `POST /api/tasks/:task_id/comments/:comment_id`
- `DELETE /api/tasks/:task_id/comments/:comment_id`
- `POST /api/bitable/apps/create`
- `GET /api/bitable/apps/:app_token`
- `POST /api/bitable/apps/:app_token`
- `GET /api/bitable/apps/:app_token/tables`
- `POST /api/bitable/apps/:app_token/tables/create`
- `GET /api/bitable/apps/:app_token/tables/:table_id/records`
- `POST /api/bitable/apps/:app_token/tables/:table_id/records/search`
- `POST /api/bitable/apps/:app_token/tables/:table_id/records/create`
- `POST /api/bitable/apps/:app_token/tables/:table_id/records/bulk-upsert`
- `GET /api/bitable/apps/:app_token/tables/:table_id/records/:record_id`
- `POST /api/bitable/apps/:app_token/tables/:table_id/records/:record_id`
- `DELETE /api/bitable/apps/:app_token/tables/:table_id/records/:record_id`
- `POST /api/sheets/spreadsheets/create`
- `GET /api/sheets/spreadsheets/:spreadsheet_token`
- `POST /api/sheets/spreadsheets/:spreadsheet_token`
- `GET /api/sheets/spreadsheets/:spreadsheet_token/sheets`
- `GET /api/sheets/spreadsheets/:spreadsheet_token/sheets/:sheet_id`
- `POST /api/sheets/spreadsheets/:spreadsheet_token/sheets/:sheet_id/replace`
- `POST /api/sheets/spreadsheets/:spreadsheet_token/sheets/:sheet_id/replace-batch`
- `GET /api/messages/:message_id/reactions`
- `POST /api/messages/:message_id/reactions`
- `DELETE /api/messages/:message_id/reactions/:reaction_id`
- `POST /api/drive/create-folder`
- `POST /api/drive/move`
- `GET /api/drive/task-status`
- `POST /api/drive/delete`
- `POST /api/drive/organize/preview`
- `POST /api/drive/organize/apply`
- `GET /api/wiki/spaces`
- `GET /api/wiki/spaces/:space_id/nodes`
- `POST /api/wiki/create-node`
- `POST /api/wiki/move`
- `POST /api/wiki/organize/preview`
- `POST /api/wiki/organize/apply`

### Sync / Search / Answer

- `POST /sync/full`
- `POST /sync/incremental`
- `GET /search?q=...`
- `GET /answer?q=...`

### Secure Agent Wrapper

- `GET /agent/security/status`
- `POST /agent/tasks`
- `POST /agent/tasks/:task_id/actions`
- `POST /agent/tasks/:task_id/finish`
- `POST /agent/tasks/:task_id/rollback`
- `GET /agent/approvals`
- `POST /agent/approvals/:request_id/approve`
- `POST /agent/approvals/:request_id/reject`

這組 API 會把本機操作轉交給 [lobster_security](/Users/seanhan/Documents/Playground/lobster_security)。
預設是 `strict` 審批模式，工作區限制在 `~/lobster-workspace`，沒有批准就不會執行高風險動作。

## 啟動

預設有兩種模式：

- `npm start`
  - 只啟動 HTTP API
  - entry: [`/Users/seanhan/Documents/Playground/src/http-only.mjs`](/Users/seanhan/Documents/Playground/src/http-only.mjs)
- `npm run start:full`
  - 啟動 HTTP API + Lark 長連線 bot
  - entry: [`/Users/seanhan/Documents/Playground/src/index.mjs`](/Users/seanhan/Documents/Playground/src/index.mjs)

如果你要讓龍蝦直接在 Lark 裡收訊息，應使用 `npm run start:full`，或讓 LaunchAgent 指到 `src/index.mjs`。

```bash
npm install
npm run auth:check
npm run start:full
```

`npm run start:full` 啟動後會同時開：

- Lark WS bot
- HTTP API server，預設 `http://localhost:3333`

`npm start` 則只會開 HTTP server，不會連 Lark 長連線。

## 第一次授權

```bash
open http://localhost:3333/oauth/lark/login
```

授權完成後先檢查：

```bash
curl http://localhost:3333/api/auth/status
curl http://localhost:3333/api/drive/root
curl http://localhost:3333/api/wiki/spaces
```

## 同步

完整同步：

```bash
curl -X POST http://localhost:3333/sync/full
```

增量同步：

```bash
curl -X POST http://localhost:3333/sync/incremental
```

## Search / Answer

```bash
curl "http://localhost:3333/search?q=客服 SOP"
curl "http://localhost:3333/answer?q=客服 SOP 是什麼？"
```

## OpenClaw Plugin

plugin 位置在 [openclaw-plugin/lark-kb](/Users/seanhan/Documents/Playground/openclaw-plugin/lark-kb)。

目前對 OpenClaw 暴露的主要 tools 包含：
- `lark_kb_status`
- `lark_kb_sync`
- `lark_kb_search`
- `lark_kb_answer`
- `lark_doc_read`
- `lark_doc_create`
- `lark_doc_update`
  - `replace` 採 preview / confirm 兩段式
- `lark_doc_comments`
- `lark_doc_comment_suggestion_card`
- `lark_doc_rewrite_from_comments`
  - 採 preview / confirm 兩段式
- `lark_messages_list`
- `lark_messages_search`
- `lark_message_get`
- `lark_message_reply`
- `lark_message_reply_card`
- `lark_calendar_primary`
- `lark_calendar_events`
- `lark_calendar_search`
- `lark_calendar_create_event`
- `lark_calendar_freebusy`
- `lark_tasks_list`
- `lark_task_get`
- `lark_task_create`
- `lark_task_comments`
- `lark_task_comment_create`
- `lark_task_comment_update`
- `lark_task_comment_delete`
- `lark_bitable_app_create`
- `lark_bitable_tables_list`
- `lark_bitable_table_create`
- `lark_bitable_records_list`
- `lark_bitable_records_search`
- `lark_bitable_record_create`
- `lark_bitable_record_update`
- `lark_bitable_record_delete`
- `lark_bitable_records_bulk_upsert`
- `lark_spreadsheet_create`
- `lark_spreadsheet_sheets`
- `lark_spreadsheet_replace`
- `lark_spreadsheet_replace_batch`
- `lark_message_reactions`
- `lark_message_reaction_create`
- `lark_message_reaction_delete`
- `lark_drive_list`
- `lark_drive_create_folder`
- `lark_drive_move`
- `lark_drive_task_status`
- `lark_drive_delete`
- `lark_drive_organize`
- `lark_wiki_spaces`
- `lark_wiki_nodes`
- `lark_wiki_create_node`
- `lark_wiki_move`
- `lark_wiki_organize`
- `lobster_security_status`
- `lobster_security_start_task`
- `lobster_security_run_action`
- `lobster_security_finish_task`
- `lobster_security_rollback`
- `lobster_security_list_approvals`
- `lobster_security_resolve_approval`

plugin config:

```json
{
  "baseUrl": "http://127.0.0.1:3333",
  "timeoutMs": 20000
}
```

驗證 linkage 時，先確認：

```bash
curl http://127.0.0.1:3333/health
curl http://127.0.0.1:3333/api/auth/status
curl http://127.0.0.1:3333/api/wiki/spaces
curl "http://127.0.0.1:3333/search?q=test"
```

## .env 範例

參考 [.env.example](/Users/seanhan/Documents/Playground/.env.example)

## 增量同步策略

- 每輪都重新掃 metadata
- 若 `title / updated_at_remote / revision / raw_text` 有變化，重抓內容
- 若本輪沒有再次看到文件，標記 `inactive`
- 保留 `sync_jobs` 與 `synced_at / last_synced_at`

## 權限策略

- 只同步「授權使用者可見」的內容
- 不做跨人員共享 ACL 推斷
- 已預留 `acl_json`

## 已知邊界

- 目前已補上 `docx` 直接讀 / 建 / 改
- `sheet / slides / file / 舊版 doc` 目前仍不做內容抽取
- `bitable / sheet` 已補基礎操作，但不是完整內容抽取與分析管線
- `unread-only semantics`、`send as user`、`streaming card`、`task subtasks` 仍未補進目前這版 Lobster Lark service

## 這一輪新增能力

- 聊天上下文
  - 讀最近訊息
  - 依關鍵字搜索群聊內容
  - 讀單條訊息
  - 直接文字回覆
  - 用簡單卡片回覆
- 日程
  - 取得主日曆
  - 列日程
  - 搜索日程
  - 建立日程
- 任務
  - 列任務
  - 查任務
  - 建立任務
  - 任務評論 CRUD
- 協作資料
  - 多維表格建立 / 表列出 / 記錄 CRUD / 篩選搜尋
  - 電子表格建立 / 讀取 / 工作表列出 / 單元格替換
- 互動層
  - 訊息 reaction 查詢 / 新增 / 刪除
  - busy-free 查詢

## OAuth 注意

- 如果你之前已經授權過，需要重新授權，新的訊息能力才會生效
- 目前 `.env.example` 已補上建議的 `im:*` scopes
- `calendar / task / bitable / sheet / reaction` 能力都需要你在 Lark 後台補對應權限後重新授權
- 若你希望本地 token 不以明文落地，請設定 `LARK_TOKEN_ENCRYPTION_SECRET`
- 搜尋層現在是 `SQLite FTS5 + local semantic embedding sidecar`
- 若之後要更強語義檢索，仍可替換成 pgvector / qdrant

## 對照飛書官方插件

對照文件整理在：

- [lark_feishu_capability_gap.md](/Users/seanhan/Documents/Playground/lark_feishu_capability_gap.md)

這一輪已先補：

- 雲文檔直接讀取
- 雲文檔直接建立
- 雲文檔追加 / 覆寫更新
- 文檔評論讀取
- 根據評論生成改稿預覽
- 先生成 patch plan 與受影響段落摘要
- 經確認後套用評論改稿到 docx

## 文檔評論改稿

現在已可走這條鏈：

- 先讀一份 doc 的評論
- 根據未解評論生成改稿預覽
- 預覽裡會帶 `patch_plan`
- 取得 `confirmation_id`
- 再確認後才覆寫原 doc
- 可選擇同步把已處理評論標成 solved

預設是 preview，不會直接改文檔。

目標文檔現在可用兩種方式指定：

- 直接傳 `document_id` / `doc_token`
- 直接傳 doc 連結，例如 `document_url` / `document_link` / `doc_link`

示例：

```bash
curl "http://127.0.0.1:3333/api/doc/comments?document_id=doccnxxxx"

curl "http://127.0.0.1:3333/api/doc/comments?document_url=https%3A%2F%2Flarksuite.com%2Fdocx%2Fdoccnxxxx"

curl -X POST http://127.0.0.1:3333/api/doc/comments/suggestion-card \
  -H 'Content-Type: application/json' \
  -d '{
    "document_id": "doccnxxxx",
    "mark_seen": true
  }'

curl -X POST http://127.0.0.1:3333/api/doc/rewrite-from-comments \
  -H 'Content-Type: application/json' \
  -d '{
    "document_id": "doccnxxxx",
    "apply": false
  }'
```

如果要真的寫回：

```bash
curl -X POST http://127.0.0.1:3333/api/doc/rewrite-from-comments \
  -H 'Content-Type: application/json' \
  -d '{
    "document_id": "doccnxxxx",
    "apply": true,
    "confirm": true,
    "confirmation_id": "replace-preview-id",
    "resolve_comments": true
  }'
```

如果你已經完成過 OAuth，新增寫入 scope 後需要重新授權一次，才能真的使用文檔寫入能力。

若要確認是不是 scope 問題，先看 `GET /api/auth/status` 回傳的 `scope` 是否已包含目前 `.env` 裡要求的 doc 讀寫權限；如果 scope 已齊，但仍是 `missing_document_id`，優先檢查輸入是不是只帶了整理結果、沒有帶目標 doc token 或 doc link。

`/api/doc/comments/suggestion-card` 會先檢查是否有新的未解評論；如果有，就直接產生一張可回傳或可回覆到訊息裡的改稿建議卡，並附 `confirmation_id` 給後續 apply 使用。

如果你有要長期追蹤的文件，可以設定：

- `LARK_COMMENT_SUGGESTION_POLL_ENABLED=true`
- `LARK_COMMENT_SUGGESTION_POLL_INTERVAL_SECONDS=300`
- `LARK_COMMENT_SUGGESTION_WATCHES=.data/doc-comment-suggestion-watches.json`

服務啟動後會定時檢查 watched 文件的新評論。需要手動驗證時，可以直接呼叫：

```bash
curl -X POST http://127.0.0.1:3333/api/doc/comments/poll-suggestion-cards
```

`LARK_COMMENT_SUGGESTION_WATCHES` 內容可使用：

```json
[
  {
    "account_id": "acct_xxx",
    "document_id": "MFK7dDFLFoVlOGxWCv5cTXKmnMh",
    "message_id": "om_xxx",
    "reply_in_thread": true,
    "resolve_comments": false,
    "mark_seen": true,
    "enabled": true
  }
]
```

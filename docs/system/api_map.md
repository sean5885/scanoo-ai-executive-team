# API Map

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

The main HTTP surface is implemented in `/Users/seanhan/Documents/Playground/src/http-server.mjs`.

## Core HTTP Routes

- `GET /health`
  - Handler: inline in `startHttpServer()`
  - Module: HTTP API
  - Purpose: health check

- `GET /oauth/lark/login`
  - Handler: inline redirect branch
  - Module: OAuth
  - Purpose: start user OAuth

- `GET /oauth/lark/callback`
  - Handler: inline callback branch
  - Module: OAuth
  - Purpose: exchange code and persist token

- `GET /api/auth/status`
  - Handler: `handleAuthStatus`
  - Module: OAuth
  - Purpose: inspect authorization state

- `GET /api/system/runtime-info`
  - Handler: `handleRuntimeInfo`
  - Module: runtime / HTTP API
  - Purpose: expose the current DB path, node PID, working directory, and service start time for the running HTTP process
  - Log note: emits `stage=runtime_info`

- `POST /api/runtime/resolve-scopes`
  - Handler: `handleRuntimeResolveScopes`
  - Module: runtime scope resolution
  - Purpose: resolve one binding/session/workspace/sandbox result from Lark-style identity input, including capability lane

- `GET /api/runtime/sessions`
  - Handler: `handleRuntimeSessions`
  - Module: runtime scope resolution
  - Purpose: inspect persisted peer-scoped session keys and capability lanes

- `GET /api/drive/root`
- `GET /api/drive/list`
  - Handler: `handleDriveList`
  - Module: drive browse
  - Purpose: list drive items

- `POST /api/drive/create-folder`
  - Handler: `handleDriveCreateFolder`
  - Purpose: create folder

- `POST /api/drive/move`
  - Handler: `handleDriveMove`
  - Purpose: move item

- `GET /api/drive/task-status`
  - Handler: `handleDriveTaskStatus`
  - Purpose: check async drive task

- `POST /api/drive/delete`
  - Handler: `handleDriveDelete`
  - Purpose: delete/trash item

- `POST /api/drive/organize/preview`
- `POST /api/drive/organize/apply`
  - Handler: `handleDriveOrganize`
  - Purpose: preview/apply drive organization

- `GET /api/wiki/spaces`
  - Handler: inline wiki spaces branch
  - Purpose: list accessible wiki spaces

- `GET /api/wiki/spaces/:space_id/nodes`
  - Handler: inline `wikiNodesMatch`
  - Purpose: list wiki nodes

- `POST /api/wiki/create-node`
  - Handler: `handleWikiCreateNode`
  - Purpose: create wiki doc node

- `POST /api/wiki/move`
  - Handler: `handleWikiMove`
  - Purpose: move wiki node

- `POST /api/wiki/organize/preview`
- `POST /api/wiki/organize/apply`
  - Handler: `handleWikiOrganize`
  - Purpose: preview/apply wiki organization

- `GET /api/doc/read`
  - Handler: `handleDocumentRead`
  - Purpose: read one docx document

- `GET /api/doc/lifecycle`
  - Handler: `handleDocumentLifecycleList`
  - Purpose: list API-created document lifecycle rows by `status`
  - Response shape: `doc_id`, `external_key`, `failure_reason`, `indexed_at`, `verified_at`, `created_at`, `updated_at`

- `GET /api/doc/lifecycle/summary`
  - Handler: `handleDocumentLifecycleSummary`
  - Purpose: return lifecycle counts for `created`, `indexed`, `verified`, `create_failed`, `index_failed`, and `verify_failed`
  - Log note: emits `stage=document_lifecycle_summary`

- `GET /api/company-brain/docs`
  - Handler: `handleCompanyBrainDocsList`
  - Purpose: list the minimal verified-doc mirror from `company_brain_docs`
  - Response shape: `doc_id`, `title`, `source`, `created_at`, `creator`
  - Query note: supports `limit`
  - Log note: emits `stage=company_brain_list`

- `GET /api/company-brain/docs/:doc_id`
  - Handler: `handleCompanyBrainDocDetail`
  - Purpose: return one minimal verified-doc mirror row from `company_brain_docs`
  - Response shape: `doc_id`, `title`, `source`, `created_at`, `creator`
  - Not-found note: returns `ok=false` with `error=not_found`
  - Log note: emits `stage=company_brain_detail`

- `GET /api/company-brain/search?q=...`
  - Handler: `handleCompanyBrainSearch`
  - Purpose: search the minimal verified-doc mirror by `title` or `doc_id`
  - Response shape: `total`, `items`; each item keeps the same minimal shape as list/detail
  - Validation note: empty `q` returns `ok=false` with `error=invalid_query`
  - Log note: emits `stage=company_brain_search`

- `POST /api/doc/lifecycle/retry`
  - Handler: `handleDocumentLifecycleRetry`
  - Purpose: retry only `index_failed` / `verify_failed` lifecycle rows
  - Retry note: `create_failed` is intentionally not auto-retried; the route re-runs only the index/verify portion of the lifecycle and logs transitions under `stage=document_lifecycle_retry`

- `POST /api/doc/create`
  - Handler: `handleDocumentCreate`
  - Purpose: create docx, optional initial content
  - Side effect note: the docx adapter keeps `POST /open-apis/docx/v1/documents`, adds structured create-error diagnostics, and may fall back from folder-scoped create to root create when the platform rejects the folder target with `1063003`
  - Route behavior note: document creation is the blocking step; post-create manager-permission grant is non-blocking, skipped when the current user is already the owner, and returned as `permission_grant_failed` / `permission_grant_skipped` / `permission_grant_error`
  - Index note: after create succeeds, the route writes normalized metadata `{ doc_id, source, created_at, creator: { account_id, open_id }, title, folder_token }` into the existing `lark_sources` / `lark_documents` index as a non-blocking `document_index` step; this is not a separate company-brain module
  - Lifecycle note: the route now advances `lark_documents.status` through `created -> indexed -> verified`, records `indexed_at` / `verified_at`, and writes `create_failed` / `index_failed` / `verify_failed` plus `failure_reason` on the corresponding failure path, with `document_lifecycle_update` logs for each transition
  - Company-brain note: when the lifecycle reaches `verified`, the route also attempts a non-blocking mirror write into `company_brain_docs` with `{ doc_id, title, source, created_at, creator }`, logging under `stage=company_brain_ingest`

- `POST /api/doc/update`
  - Handler: `handleDocumentUpdate`
  - Purpose: append doc content, or preview-then-confirm replace
  - Side effect note: `replace` now creates a temporary confirmation artifact before real overwrite

- `GET /api/doc/comments`
  - Handler: `handleDocumentComments`
  - Purpose: list doc comments

- `POST /api/doc/comments/suggestion-card`
  - Handler: `handleDocumentCommentSuggestionCard`
  - Purpose: detect unseen unresolved comments, generate a rewrite preview, and return/send a suggestion card
  - Side effect note: may mark comments as seen in local watch state and may send a Lark reply card if `message_id` is provided

- `POST /api/doc/comments/poll-suggestion-cards`
  - Handler: `handleDocumentCommentSuggestionPoll`
  - Module: comment suggestion workflow
  - Purpose: run one poll pass over configured watched documents and generate suggestion-card results
  - Side effect note: may send Lark reply cards, update local seen-comment state, and consume stored account tokens without request body account selection

- `POST /api/doc/rewrite-from-comments`
  - Handler: `handleDocumentRewriteFromComments`
  - Purpose: preview comment-driven patch plan, then confirm before apply
  - Side effect note: preview path also returns a rewrite summary card; apply path depends on a temporary confirmation artifact, carries a patch plan, and may resolve comments after write

- `GET /api/messages`
  - Handler: `handleMessagesList`
  - Purpose: list chat history

- `GET /api/messages/search`
  - Handler: `handleMessageSearch`
  - Purpose: search message history

- `GET /api/messages/:message_id`
  - Handler: `handleMessageGet`
  - Purpose: get one message

- `POST /api/messages/reply`
  - Handler: `handleMessageReply`
  - Purpose: text reply

- `POST /api/messages/reply-card`
  - Handler: `handleMessageReply`
  - Purpose: card reply

- `GET /api/calendar/primary`
  - Handler: `handleCalendarPrimary`
  - Purpose: resolve primary calendar

- `GET /api/calendar/events`
  - Handler: `handleCalendarEvents`
  - Purpose: list calendar events

- `POST /api/calendar/events/search`
  - Handler: `handleCalendarSearch`
  - Purpose: search events

- `POST /api/calendar/events/create`
  - Handler: `handleCalendarCreateEvent`
  - Purpose: create event

- `POST /api/calendar/freebusy`
  - Handler: `handleCalendarFreebusy`
  - Purpose: query busy/free slots for one user or room

- `GET /api/tasks`
  - Handler: `handleTasksList`
  - Purpose: list tasks

- `GET /api/tasks/:task_id`
  - Handler: `handleTaskGet`
  - Purpose: get task

- `POST /api/tasks/create`
  - Handler: `handleTaskCreate`
  - Purpose: create task

- `GET /api/tasks/:task_id/comments`
- `POST /api/tasks/:task_id/comments`
  - Handler: `handleTaskCommentsList` / `handleTaskCommentCreate`
  - Purpose: list or create task comments

- `GET /api/tasks/:task_id/comments/:comment_id`
- `POST|PUT|PATCH /api/tasks/:task_id/comments/:comment_id`
- `DELETE /api/tasks/:task_id/comments/:comment_id`
  - Handler: `handleTaskCommentGet` / `handleTaskCommentUpdate` / `handleTaskCommentDelete`
  - Purpose: manage one task comment

- `POST /api/bitable/apps/create`
  - Handler: `handleBitableAppCreate`
  - Purpose: create one Bitable app

- `GET /api/bitable/apps/:app_token`
- `POST|PATCH /api/bitable/apps/:app_token`
  - Handler: `handleBitableAppGet` / `handleBitableAppUpdate`
  - Purpose: inspect or update one Bitable app

- `GET /api/bitable/apps/:app_token/tables`
- `POST /api/bitable/apps/:app_token/tables/create`
  - Handler: `handleBitableTablesList` / `handleBitableTableCreate`
  - Purpose: list or create tables

- `GET /api/bitable/apps/:app_token/tables/:table_id/records`
- `POST /api/bitable/apps/:app_token/tables/:table_id/records/search`
- `POST /api/bitable/apps/:app_token/tables/:table_id/records/create`
 - `POST /api/bitable/apps/:app_token/tables/:table_id/records/bulk-upsert`
  - Handler: `handleBitableRecordsList` / `handleBitableRecordsSearch` / `handleBitableRecordCreate`
  - `handleBitableRecordsBulkUpsert`
  - Purpose: browse, filter, create, or bulk-upsert records

- `GET /api/bitable/apps/:app_token/tables/:table_id/records/:record_id`
- `POST|PATCH /api/bitable/apps/:app_token/tables/:table_id/records/:record_id`
- `DELETE /api/bitable/apps/:app_token/tables/:table_id/records/:record_id`
  - Handler: `handleBitableRecordGet` / `handleBitableRecordUpdate` / `handleBitableRecordDelete`
  - Purpose: manage one Bitable record

- `POST /api/sheets/spreadsheets/create`
  - Handler: `handleSpreadsheetCreate`
  - Purpose: create spreadsheet

- `GET /api/sheets/spreadsheets/:spreadsheet_token`
- `POST|PATCH /api/sheets/spreadsheets/:spreadsheet_token`
  - Handler: `handleSpreadsheetGet` / `handleSpreadsheetUpdate`
  - Purpose: inspect or rename spreadsheet

- `GET /api/sheets/spreadsheets/:spreadsheet_token/sheets`
- `GET /api/sheets/spreadsheets/:spreadsheet_token/sheets/:sheet_id`
  - Handler: `handleSpreadsheetSheetsList` / `handleSpreadsheetSheetGet`
  - Purpose: inspect spreadsheet sheets

- `POST /api/sheets/spreadsheets/:spreadsheet_token/sheets/:sheet_id/replace`
 - `POST /api/sheets/spreadsheets/:spreadsheet_token/sheets/:sheet_id/replace-batch`
  - Handler: `handleSpreadsheetReplace`
  - `handleSpreadsheetReplaceBatch`
  - Purpose: replace matching cell values in one range or in batch

- `GET /api/messages/:message_id/reactions`
- `POST /api/messages/:message_id/reactions`
- `DELETE /api/messages/:message_id/reactions/:reaction_id`
  - Handler: `handleMessageReactionsList` / `handleMessageReactionCreate` / `handleMessageReactionDelete`
  - Purpose: manage message reactions

- `POST /sync/full`
- `POST /sync/incremental`
  - Handler: `handleSync`
  - Purpose: run sync job

- `GET /search`
  - Handler: `handleSearch`
  - Purpose: hybrid retrieval search

- `GET /answer`
  - Handler: `handleAnswer`
  - Purpose: retrieve and answer

- `GET /agent/security/status`
  - Handler: `handleSecurityStatus`
  - Purpose: inspect security wrapper status

- `GET /agent/approvals`
  - Handler: `handleApprovalList`
  - Purpose: list pending approvals

- `POST /agent/docs/create`
  - Handler: `handleAgentCreateDoc`
  - Purpose: expose `/api/doc/create` through an agent-facing bridge
  - Response shape: `{ ok, action, data, trace_id }` with `action=create_doc`
  - Log note: emits `stage=agent_bridge`

- `GET /agent/company-brain/docs`
  - Handler: `handleAgentListCompanyBrainDocs`
  - Purpose: expose `/api/company-brain/docs` through an agent-facing bridge
  - Response shape: `{ ok, action, data, trace_id }` with `action=list_company_brain_docs`
  - Log note: emits `stage=agent_bridge`

- `GET /agent/system/runtime-info`
  - Handler: `handleAgentRuntimeInfo`
  - Purpose: expose `/api/system/runtime-info` through an agent-facing bridge
  - Response shape: `{ ok, action, data, trace_id }` with `action=get_runtime_info`
  - Log note: emits `stage=agent_bridge`

- `POST /agent/approvals/:request_id/approve`
- `POST /agent/approvals/:request_id/reject`
  - Handler: `handleApprovalResolution`
  - Purpose: resolve approval request

- `POST /agent/tasks`
  - Handler: `handleSecureTaskStart`
  - Purpose: start guarded local task

- `POST /agent/tasks/:task_id/actions`
  - Handler: `handleSecureAction`
  - Purpose: run guarded action

- `POST /agent/tasks/:task_id/finish`
  - Handler: `handleSecureTaskFinish`
  - Purpose: finish guarded task

- `POST /agent/tasks/:task_id/rollback`
  - Handler: `handleSecureTaskRollback`
  - Purpose: rollback guarded task

## Non-HTTP Integration Surface

- OpenClaw plugin tools
  - `/Users/seanhan/Documents/Playground/openclaw-plugin/lark-kb/index.ts`
  - Purpose: call local HTTP API as tools

- Lark long connection event
  - `/Users/seanhan/Documents/Playground/src/index.mjs`
  - Event: `im.message.receive_v1`
  - Purpose: basic echo-style bot behavior

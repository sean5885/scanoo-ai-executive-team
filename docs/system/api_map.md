# API Map

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

The main HTTP surface is implemented in `/Users/seanhan/Documents/Playground/src/http-server.mjs`.

## Write-Route Idempotency

- JSON write requests handled by `POST` / `PUT` / `PATCH` may include an optional `idempotency_key` in the request body
  - runtime scope is `method + pathname + explicit account_id when provided + idempotency_key`
  - repeated requests with the same scope do not re-run the handler; they replay the first persisted JSON result
  - first-response persistence lives in SQLite `http_request_idempotency`
  - mutation-runtime now also keeps a narrower in-process idempotency state entry when callers pass `context.idempotency_key` into `/Users/seanhan/Documents/Playground/src/mutation-runtime.mjs`
  - the runtime-local entry is keyed only by that explicit context key, moves through `pending -> done`, returns `idempotency_in_progress` for overlapping retries, only stores the first successful runtime response, clears pending state on non-success, and is cleared when the Node process restarts

## Core HTTP Routes

- `GET /health`
  - Handler: inline in `startHttpServer()`
  - Module: HTTP API
  - Purpose: health check

- `GET /monitoring`
  - Handler: `handleMonitoringDashboard`
  - Module: runtime / monitoring
  - Purpose: render a simple local HTML monitoring dashboard
  - Query note: supports `requests_limit|recent_limit` and `errors_limit|error_limit`
  - Output note: shows success rate, error rate, recent errors, and recent requests from the persisted request-monitor store

- `GET /oauth/lark/login`
  - Handler: inline redirect branch
  - Module: OAuth
  - Purpose: start user OAuth

- `GET /oauth/lark/callback`
  - Handler: inline callback branch
  - Module: OAuth
  - Purpose: exchange code and persist token
  - Persistence note: stores `access_token`, `refresh_token`, `expires_at`, and `refresh_expires_at` into the local SQLite token table before later API use

- `GET /api/auth/status`
  - Handler: `handleAuthStatus`
  - Module: OAuth
  - Purpose: inspect authorization state

- `GET /api/system/runtime-info`
  - Handler: `handleRuntimeInfo`
  - Module: runtime / HTTP API
  - Purpose: expose the current DB path, node PID, working directory, and service start time for the running HTTP process
  - Response shape: `{ ok, action, db_path, node_pid, cwd, service_start_time }` with `action=get_runtime_info`
  - Log note: emits `stage=runtime_info`

- `POST /api/runtime/resolve-scopes`
  - Handler: `handleRuntimeResolveScopes`
  - Module: runtime scope resolution
  - Purpose: resolve one binding/session/workspace/sandbox result from Lark-style identity input, including capability lane

- `GET /api/runtime/sessions`
  - Handler: `handleRuntimeSessions`
  - Module: runtime scope resolution
  - Purpose: inspect persisted peer-scoped session keys and capability lanes

- `GET /api/monitoring/requests`
  - Handler: `handleMonitoringRequests`
  - Module: runtime / monitoring
  - Purpose: list recent persisted HTTP request summaries
  - Query note: supports `limit`, default `50`
  - Response shape: `trace_id`, `request_id`, `method`, `pathname`, `route_name`, `status_code`, `ok`, `error_code`, `error_message`, `duration_ms`, `started_at`, `finished_at`

- `GET /api/monitoring/errors`
  - Handler: `handleMonitoringErrors`
  - Module: runtime / monitoring
  - Purpose: list recent persisted error requests
  - Query note: supports `limit`, default `10`
  - Response shape: same as `/api/monitoring/requests`, filtered to error requests

- `GET /api/monitoring/errors/latest`
  - Handler: `handleMonitoringLatestError`
  - Module: runtime / monitoring
  - Purpose: return the latest persisted error request, or `null` when none exists

- `GET /api/monitoring/metrics`
  - Handler: `handleMonitoringMetrics`
  - Module: runtime / monitoring
  - Purpose: return aggregate request counts plus `success_rate` and `error_rate`
  - Response shape: `total_requests`, `success_count`, `error_count`, `success_rate`, `error_rate`

- `GET /api/monitoring/learning`
  - Handler: `handleMonitoringLearningSummary`
  - Module: runtime / monitoring
  - Purpose: summarize recent monitoring / trace history into routing hotspots, tool success-rate summaries, latency metrics, and draft improvement proposals
  - Query note: supports `lookback_hours`, `request_limit`, `min_sample_size`, `max_routing_items`, and `max_tool_items`
  - Ranking note: routing/tool lists keep the strongest failure/success signal first, but equal-score ties now break toward the newest sampled requests so older buckets do not crowd out fresher regression samples
  - Determinism note: for a fixed sampled request set, the returned summary and `draft_proposals` are deterministic; proposal ids are stable instead of per-call random
  - Review note: this route does not apply changes; it only returns a review-first summary plus `draft_proposals`

- `GET /api/drive/root`
- `GET /api/drive/list`
  - Handler: `handleDriveList`
  - Module: drive browse
  - Purpose: list drive items

- `POST /api/drive/create-folder`
  - Handler: `handleDriveCreateFolder`
  - Purpose: create folder
  - Guard note: the final folder-create mutation now routes through `executeLarkWrite(...)` and the local Lark write-budget / duplicate guard

- `POST /api/drive/move`
  - Handler: `handleDriveMove`
  - Purpose: move item
  - Guard note: the final move mutation now routes through `executeLarkWrite(...)` and the local Lark write-budget / duplicate guard

- `GET /api/drive/task-status`
  - Handler: `handleDriveTaskStatus`
  - Purpose: check async drive task

- `POST /api/drive/delete`
  - Handler: `handleDriveDelete`
  - Purpose: delete/trash item
  - Guard note: the final delete mutation now routes through `executeLarkWrite(...)` and the local Lark write-budget / duplicate guard

- `POST /api/drive/organize/preview`
- `POST /api/drive/organize/apply`
  - Handler: `handleDriveOrganize`
  - Purpose: preview/apply drive organization
  - Guard note: apply now routes the final mutation through the shared `executeLarkWrite(...)` entry and checks the local Lark write-budget / duplicate guard before any folder create or move submission
  - Apply note: if budget soft-limit / hard-limit or duplicate suppression triggers, the route does not mutate Drive and remains on the existing preview/review workflow boundary

- `GET /api/wiki/spaces`
  - Handler: inline wiki spaces branch
  - Purpose: list accessible wiki spaces

- `GET /api/wiki/spaces/:space_id/nodes`
  - Handler: inline `wikiNodesMatch`
  - Purpose: list wiki nodes

- `POST /api/wiki/create-node`
  - Handler: `handleWikiCreateNode`
  - Purpose: create wiki doc node
  - Guard note: the final create mutation now routes through `executeLarkWrite(...)` and the local Lark write-budget / duplicate guard

- `POST /api/wiki/move`
  - Handler: `handleWikiMove`
  - Purpose: move wiki node
  - Guard note: the final move mutation now routes through `executeLarkWrite(...)` and the local Lark write-budget / duplicate guard

- `POST /api/wiki/organize/preview`
- `POST /api/wiki/organize/apply`
  - Handler: `handleWikiOrganize`
  - Purpose: preview/apply wiki organization
  - Guard note: apply now routes the final mutation through the shared `executeLarkWrite(...)` entry and checks the local Lark write-budget / duplicate guard before any wiki node create or move submission
  - Apply note: if budget soft-limit / hard-limit or duplicate suppression triggers, the route does not mutate Wiki and remains on the existing preview/review workflow boundary

- `GET /api/doc/read`
  - Handler: `handleDocumentRead`
  - Purpose: read one docx document
  - Input note: accepts `document_id` / `doc_token`, and also doc URLs passed as `document_url` / `document_link` / `doc_link`
  - Read note: the route now enters `read-runtime.mjs` with `primary_authority=live` and `freshness=live_required`; it does not supplement live reads with mirror fallback

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

- `GET /agent/company-brain/docs`
  - Handler: `handleAgentListCompanyBrainDocs`
  - Purpose: planner-facing list action over the verified-doc mirror
  - Response shape: `{ ok, action, data, trace_id }`, where `data` keeps a unified `{ success, data, error }` envelope
  - Data note: result items contain structured `summary` and `learning_state`; no raw full text is returned
  - Log note: emits `stage=agent_bridge`

- `POST /agent/improvements/learning/generate`
  - Handler: `handleLearningImprovementGeneration`
  - Purpose: convert the current monitoring-backed learning summary into persisted improvement proposals for human review
  - Input note: accepts optional `account_id`, `session_key`, `lookback_hours`, `request_limit`, `min_sample_size`, `max_routing_items`, and `max_tool_items`
  - Response note: generated items are archived through the existing improvement workflow and returned as `pending_approval` entries; no routing/tool weight is auto-applied

- `GET /agent/company-brain/search?q=...`
  - Handler: `handleAgentSearchCompanyBrainDocs`
  - Purpose: planner-facing search action with composite ranking over keyword match, semantic-lite similarity, learning tags/key concepts, and recency
  - Response shape: `{ ok, action, data, trace_id }`, where `data` keeps a unified `{ success, data, error }` envelope
  - Input note: accepts `q` plus `top_k` (default `5`); legacy `limit` remains as a compatibility alias
  - Data note: search items contain `doc_id`, `title`, optional mirrored `url`, structured `summary`, `learning_state`, and `match`; `match` now includes composite `score`, per-signal scores, and simplified `ranking_basis`
  - Validation note: empty `q` returns `ok=false` with `error=invalid_query`
  - Log note: emits `stage=agent_bridge`

- `GET /agent/company-brain/docs/:doc_id`
  - Handler: `handleAgentGetCompanyBrainDocDetail`
  - Purpose: planner-facing detail action for one mirrored doc
  - Response shape: `{ ok, action, data, trace_id }`, where `data` keeps a unified `{ success, data, error }` envelope
  - Data note: detail result returns `{ doc, summary, learning_state }`; no raw full text is returned
  - Not-found note: returns `ok=false` with `error=not_found`
  - Log note: emits `stage=agent_bridge`

- `GET /agent/company-brain/approved/docs`
  - Handler: `handleAgentListApprovedCompanyBrainKnowledge`
  - Purpose: list only explicitly applied approved company-brain knowledge
  - Response shape: `{ ok, action, data, trace_id }`, with the same unified `{ success, data, error }` envelope
  - Data note: items include `knowledge_state.stage=approved` and still avoid raw full text
  - Read-authority note: the route now enters `read-runtime.mjs` with `primary_authority=derived`

- `GET /agent/company-brain/approved/search?q=...`
  - Handler: `handleAgentSearchApprovedCompanyBrainKnowledge`
  - Purpose: search only approved company-brain knowledge after review and apply have completed
  - Response shape: `{ ok, action, data, trace_id }`, with the same unified `{ success, data, error }` envelope
  - Data note: search items include `knowledge_state`, `match`, `summary`, and `learning_state`
  - Read-authority note: the route now enters `read-runtime.mjs` with `primary_authority=derived`

- `GET /agent/company-brain/approved/docs/:doc_id`
  - Handler: `handleAgentGetApprovedCompanyBrainKnowledgeDetail`
  - Purpose: fetch one explicitly approved company-brain doc
  - Response shape: `{ ok, action, data, trace_id }`, with the same unified `{ success, data, error }` envelope
  - Data note: detail result returns `{ doc, summary, learning_state, knowledge_state }`
  - Read-authority note: the route now enters `read-runtime.mjs` with `primary_authority=derived`

- `POST /agent/company-brain/review`
  - Handler: `handleAgentReviewCompanyBrainDoc`
  - Purpose: stage the explicit review boundary for one mirrored doc before formal admission
  - Input note: accepts `doc_id`, optional `title`, optional `action`, optional `target_stage`, and bounded overlap hints
  - Response note: success returns both `intake_boundary` and persisted `review_state`

- `POST /agent/company-brain/conflicts`
  - Handler: `handleAgentCheckCompanyBrainConflicts`
  - Purpose: run the explicit bounded conflict-check step before approval/apply
  - Input note: accepts `doc_id`, optional `title`, optional `action`, optional `target_stage`, and bounded overlap hints
  - Response note: success returns `conflict_state=none|possible|confirmed`, `conflict_items`, and the current review/approval state envelope
  - Runtime note: the route now builds a canonical mutation request and passes through `mutation-runtime`; `knowledge_write_v1` only requires durable review-state evidence when conflict-check actually stages a review-state mutation

- `POST /agent/company-brain/approval-transition`
  - Handler: `handleAgentCompanyBrainApprovalTransition`
  - Purpose: record the explicit approve/reject decision for one company-brain candidate
  - Input note: accepts `doc_id`, `decision=approve|reject`, optional `actor`, and optional `notes`
  - Boundary note: this decision step is explicit, but it still does not apply the doc into approved knowledge by itself

- `POST /agent/company-brain/docs/:doc_id/apply`
  - Handler: `handleAgentApplyApprovedCompanyBrainKnowledge`
  - Purpose: apply one already-approved review decision into `company_brain_approved_knowledge`
  - Input note: accepts `doc_id`, optional `actor`, and optional `source_stage`
  - Validation note: returns `ok=false` with `error=approval_required` until the approval-transition step has recorded `review_status=approved`

- `POST /agent/company-brain/learning/ingest`
  - Handler: `handleAgentIngestLearningDoc`
  - Purpose: learn one verified company-brain mirror doc into the simplified learning sidecar
  - Response shape: `{ ok, action, data, trace_id }`, where `data` keeps a unified `{ success, data, error }` envelope
  - Data note: success returns `{ doc, learning_state }`, where `learning_state` stores deterministic `structured_summary`, `key_concepts`, and `tags`
  - Boundary note: this is not approved company-brain admission; it only updates the simplified learning sidecar

- `POST /agent/company-brain/learning/state`
  - Handler: `handleAgentUpdateLearningState`
  - Purpose: update one mirrored doc's simplified learning state
  - Response shape: `{ ok, action, data, trace_id }`, where `data` keeps a unified `{ success, data, error }` envelope
  - Input note: accepts `doc_id` plus optional `status`, `notes`, `tags`, and `key_concepts`
  - Runtime note: the route now builds a canonical mutation request and routes the final sidecar write through `mutation-runtime` with `knowledge_write_v1` durable-write verification
  - Boundary note: this stays outside approval-governed company-brain memory admission

- `POST /api/doc/lifecycle/retry`
  - Handler: `handleDocumentLifecycleRetry`
  - Purpose: retry only `index_failed` / `verify_failed` lifecycle rows
  - Retry note: `create_failed` is intentionally not auto-retried; the route re-runs only the index/verify portion of the lifecycle and logs transitions under `stage=document_lifecycle_retry`

- `POST /api/doc/create`
  - Handler: `handleDocumentCreate`
  - Purpose: create docx, optional initial content
  - Guard note: the route is now preview-first for live create; the first request returns a temporary `document_create` confirmation artifact and the real create path requires both `confirm=true` and `confirmation_id`
  - Guard note: live document creation remains fail-closed by default on the actual write path; `NODE_ENV=production` stays a hard stop even if write env flags are set
  - Guard note: titles/sources that look like `test` / `demo` / `verify` / `smoke` / `e2e` are sandbox-only; they are redirected to `LARK_WRITE_SANDBOX_FOLDER_TOKEN` when configured, otherwise blocked
  - Side effect note: the confirmed write path now performs `peek -> consume -> executeLarkWrite(...) -> createDocument/updateDocument`; the docx adapter still adds structured create-error diagnostics and still avoids root-create fallback unless `ALLOW_LARK_CREATE_ROOT_FALLBACK=true` is explicitly enabled
  - Budget note: confirmed create also checks the local Lark write-budget / duplicate guard before any real doc create or initial replace write
  - Route behavior note: document creation is the blocking step; post-create manager-permission grant is non-blocking, skipped when the current user is already the owner, and returned as `permission_grant_failed` / `permission_grant_skipped` / `permission_grant_error`
  - Index note: after create succeeds, the route writes normalized metadata `{ doc_id, source, created_at, creator: { account_id, open_id }, title, folder_token }` into the existing `lark_sources` / `lark_documents` index as a non-blocking `document_index` step; this is not a separate company-brain module
  - Lifecycle note: the route now advances `lark_documents.status` through `created -> indexed -> verified`, records `indexed_at` / `verified_at`, and writes `create_failed` / `index_failed` / `verify_failed` plus `failure_reason` on the corresponding failure path, with `document_lifecycle_update` logs for each transition
  - Company-brain note: when the lifecycle reaches `verified`, the route also attempts a non-blocking mirror write into `company_brain_docs` with `{ doc_id, title, source, created_at, creator }`, logging under `stage=company_brain_ingest`

- `POST /api/doc/update`
  - Handler: `handleDocumentUpdate`
  - Purpose: append doc content immediately, or preview/confirm replace and heading-targeted insert for doc content
  - Input note: target doc can be supplied as `document_id` / `doc_token`, or as a doc URL via `document_url` / `document_link` / `doc_link`
  - Input note: heading-targeted insert is enabled by `target_heading` plus optional `target_position=end_of_section|after_heading`
  - Final-write note: preview can still resolve doc URLs and heading aliases, but the real write step now requires explicit `document_id` plus `section_heading`; missing either returns structured `missing_explicit_write_target`
  - Side effect note: replace and heading-targeted updates create a temporary confirmation artifact before real overwrite; append keeps its existing external behavior but the final write now still routes through `executeLarkWrite(...)`
  - Budget note: all final doc writes now check the local Lark write-budget / duplicate guard before calling Lark

- `GET /api/doc/comments`
  - Handler: `handleDocumentComments`
  - Purpose: list doc comments
  - Input note: target doc can be supplied as `document_id` / `doc_token`, or as a doc URL via `document_url` / `document_link` / `doc_link`
  - Read note: the route now enters `read-runtime.mjs` with `primary_authority=live` and `freshness=live_required`; it does not supplement live reads with mirror fallback

- `POST /api/doc/comments/suggestion-card`
  - Handler: `handleDocumentCommentSuggestionCard`
  - Purpose: detect unseen unresolved comments, generate a rewrite preview, and return/send a suggestion card
  - Input note: target doc can be supplied as `document_id` / `doc_token`, or as a doc URL via `document_url` / `document_link` / `doc_link`
  - Side effect note: may mark comments as seen in local watch state and may send a Lark reply card if `message_id` is provided

- `POST /api/doc/comments/poll-suggestion-cards`
  - Handler: `handleDocumentCommentSuggestionPoll`
  - Module: comment suggestion workflow
  - Purpose: run one poll pass over configured watched documents and generate suggestion-card results
  - Side effect note: may send Lark reply cards, update local seen-comment state, and consume stored account tokens without request body account selection

- `POST /api/doc/rewrite-from-comments`
  - Handler: `handleDocumentRewriteFromComments`
  - Purpose: preview comment-driven patch plan, then confirm before apply
  - Input note: target doc can be supplied as `document_id` / `doc_token`, a doc URL field, or a nested `target_document.url`
  - Read note: preview-time source reads and apply-time stale-confirmation verification reads now enter `read-runtime.mjs` with `primary_authority=live`; mirror and live are not mixed inside the same rewrite flow
  - Side effect note: preview path also returns a rewrite summary card; apply path depends on a temporary confirmation artifact, enters the shared `executeLarkWrite(...)` path, carries a patch plan, and may resolve comments after write; direct internal helper apply is disabled so this route is the only supported writeback entry
  - Budget note: confirmed apply now also checks the local Lark write-budget / duplicate guard before replacing the doc

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
  - Guard note: the final reply mutation now routes through `executeLarkWrite(...)` and the local Lark write-budget / duplicate guard

- `POST /api/messages/reply-card`
  - Handler: `handleMessageReply`
  - Purpose: card reply
  - Guard note: the final reply mutation now routes through `executeLarkWrite(...)` and the local Lark write-budget / duplicate guard

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
  - Guard note: the final calendar create mutation now routes through `executeLarkWrite(...)` and the local Lark write-budget / duplicate guard

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
  - Guard note: the final task create mutation now routes through `executeLarkWrite(...)` and the local Lark write-budget / duplicate guard

- `GET /api/tasks/:task_id/comments`
- `POST /api/tasks/:task_id/comments`
  - Handler: `handleTaskCommentsList` / `handleTaskCommentCreate`
  - Purpose: list or create task comments
  - Guard note: the create mutation now routes through `executeLarkWrite(...)` and the local Lark write-budget / duplicate guard

- `GET /api/tasks/:task_id/comments/:comment_id`
- `POST|PUT|PATCH /api/tasks/:task_id/comments/:comment_id`
- `DELETE /api/tasks/:task_id/comments/:comment_id`
  - Handler: `handleTaskCommentGet` / `handleTaskCommentUpdate` / `handleTaskCommentDelete`
  - Purpose: manage one task comment
  - Guard note: update/delete now route through `executeLarkWrite(...)` and the local Lark write-budget / duplicate guard

- `POST /api/bitable/apps/create`
  - Handler: `handleBitableAppCreate`
  - Purpose: create one Bitable app
  - Guard note: the final create mutation now routes through `executeLarkWrite(...)` and the local Lark write-budget / duplicate guard

- `GET /api/bitable/apps/:app_token`
- `POST|PATCH /api/bitable/apps/:app_token`
  - Handler: `handleBitableAppGet` / `handleBitableAppUpdate`
  - Purpose: inspect or update one Bitable app
  - Guard note: the update mutation now routes through `executeLarkWrite(...)` and the local Lark write-budget / duplicate guard

- `GET /api/bitable/apps/:app_token/tables`
- `POST /api/bitable/apps/:app_token/tables/create`
  - Handler: `handleBitableTablesList` / `handleBitableTableCreate`
  - Purpose: list or create tables
  - Guard note: the create mutation now routes through `executeLarkWrite(...)` and the local Lark write-budget / duplicate guard

- `GET /api/bitable/apps/:app_token/tables/:table_id/records`
- `POST /api/bitable/apps/:app_token/tables/:table_id/records/search`
- `POST /api/bitable/apps/:app_token/tables/:table_id/records/create`
 - `POST /api/bitable/apps/:app_token/tables/:table_id/records/bulk-upsert`
  - Handler: `handleBitableRecordsList` / `handleBitableRecordsSearch` / `handleBitableRecordCreate`
  - `handleBitableRecordsBulkUpsert`
  - Purpose: browse, filter, create, or bulk-upsert records
  - Guard note: create and bulk-upsert now route through `executeLarkWrite(...)` and the local Lark write-budget / duplicate guard

- `GET /api/bitable/apps/:app_token/tables/:table_id/records/:record_id`
- `POST|PATCH /api/bitable/apps/:app_token/tables/:table_id/records/:record_id`
- `DELETE /api/bitable/apps/:app_token/tables/:table_id/records/:record_id`
  - Handler: `handleBitableRecordGet` / `handleBitableRecordUpdate` / `handleBitableRecordDelete`
  - Purpose: manage one Bitable record
  - Guard note: update/delete now route through `executeLarkWrite(...)` and the local Lark write-budget / duplicate guard

- `POST /api/sheets/spreadsheets/create`
  - Handler: `handleSpreadsheetCreate`
  - Purpose: create spreadsheet
  - Guard note: the final create mutation now routes through `executeLarkWrite(...)` and the local Lark write-budget / duplicate guard

- `GET /api/sheets/spreadsheets/:spreadsheet_token`
- `POST|PATCH /api/sheets/spreadsheets/:spreadsheet_token`
  - Handler: `handleSpreadsheetGet` / `handleSpreadsheetUpdate`
  - Purpose: inspect or rename spreadsheet
  - Guard note: the rename mutation now routes through `executeLarkWrite(...)` and the local Lark write-budget / duplicate guard

- `GET /api/sheets/spreadsheets/:spreadsheet_token/sheets`
- `GET /api/sheets/spreadsheets/:spreadsheet_token/sheets/:sheet_id`
  - Handler: `handleSpreadsheetSheetsList` / `handleSpreadsheetSheetGet`
  - Purpose: inspect spreadsheet sheets

- `POST /api/sheets/spreadsheets/:spreadsheet_token/sheets/:sheet_id/replace`
 - `POST /api/sheets/spreadsheets/:spreadsheet_token/sheets/:sheet_id/replace-batch`
  - Handler: `handleSpreadsheetReplace`
  - `handleSpreadsheetReplaceBatch`
  - Purpose: replace matching cell values in one range or in batch
  - Guard note: both replace paths now route through `executeLarkWrite(...)` and the local Lark write-budget / duplicate guard

- `GET /api/messages/:message_id/reactions`
- `POST /api/messages/:message_id/reactions`
- `DELETE /api/messages/:message_id/reactions/:reaction_id`
  - Handler: `handleMessageReactionsList` / `handleMessageReactionCreate` / `handleMessageReactionDelete`
  - Purpose: manage message reactions
  - Guard note: create/delete now route through `executeLarkWrite(...)` and the local Lark write-budget / duplicate guard

- `POST /sync/full`
- `POST /sync/incremental`
  - Handler: `handleSync`
  - Purpose: run sync job

- `GET /search`
  - Handler: `handleSearch`
  - Purpose: hybrid retrieval search
  - Read note: the route now enters `read-runtime.mjs` with `primary_authority=index`; the index branch is backed by `/Users/seanhan/Documents/Playground/src/index-read-authority.mjs` over the existing `rag-repository.mjs` chunk search helpers, and it does not mix index results with mirror/live fallback in the same read

- `GET /answer`
  - Handler: `handleAnswer`
  - Purpose: force user text through planner decision before any execution
  - Read note: answer generation remains in `/Users/seanhan/Documents/Playground/src/answer-service.mjs`, but its retrieval stage now also enters `read-runtime.mjs` with `primary_authority=index` before any answer synthesis happens
  - Response note: planner must first emit strict legacy `{ action, params }` or bounded multi-step `{ steps: [{ action, params }] }`; wrapped/non-JSON output is rejected as `error=planner_failed`
  - Response note: both success and controlled failure now pass through a final `normalizeUserResponse()` boundary
  - Response note: the outward body is always natural-language JSON shaped as `{ ok, answer, sources, limitations }`
  - Response note: for document-search style results, `sources[]` keep bounded evidence-backed points derived only from retrieved rows; they may merge near-duplicate reasons while preserving ranked evidence order, and can still include document title, concrete reason, and link when the mirrored source URL exists
  - Response note: chat-style rendering over that same body is fixed to `結論 / 重點 / 下一步`; `sources[]` are reused as evidence-backed `重點`, `limitations[]` prefer query-aware next-step guidance, and when no verified content summary exists the reply must explicitly mark source insufficiency instead of adding unsupported detail
  - Response note: planner/executor internals such as `action`, `params`, `error`, `details`, `execution_result`, `trace`, and `trace_id` do not appear in the response body; request trace remains available through the HTTP trace header / monitoring path

- `GET /agent/security/status`
  - Handler: `handleSecurityStatus`
  - Purpose: inspect security wrapper status

- `GET /agent/approvals`
  - Handler: `handleApprovalList`
  - Purpose: list pending approvals

- `POST /agent/docs/create`
  - Handler: `handleAgentCreateDoc`
  - Purpose: expose `/api/doc/create` through an agent-facing bridge
  - Input note: this bridge now requires bounded entry governance fields `source`, `owner`, `intent`, and `type`; missing any of them returns `error=entry_governance_required`
  - Compatibility note: when an older one-shot caller omits `confirmation_id`, the bridge internally creates a preview artifact and immediately consumes that confirmation before the final write so the agent-facing contract stays one-step compatible
  - Response shape: `{ ok, action, data, trace_id }` with `action=create_doc`
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
  - Log note: each tool execution emits a unified `lobster_tool_execution` payload with `request_id`, `action`, `params`, and normalized `result`
  - Request note: plugin calls forward the same `request_id` to HTTP as `X-Request-Id`

- Lark long connection event
  - `/Users/seanhan/Documents/Playground/src/index.mjs`
  - Event: `im.message.receive_v1`
  - Purpose: basic echo-style bot behavior

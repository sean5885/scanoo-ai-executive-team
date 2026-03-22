# Data Flow

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Request Flow

This request-flow mirror now reflects the current fail-closed routing baseline.

### OAuth

1. User opens `/oauth/lark/login`
2. Service redirects to Lark authorization
3. Callback hits `/oauth/lark/callback`
4. Service exchanges code for user token
5. Callback persists `access_token`, `refresh_token`, `expires_at`, and `refresh_expires_at` into the local SQLite `lark_tokens` table
6. The stored account row remains the lookup anchor for later request-scoped token refresh

### Browse / Write Flow

1. HTTP route resolves account and user-token state
2. request-layer adapters (`lark-content.mjs` / `lark-connectors.mjs`) re-check token validity before each Lark API call
3. if the stored token is expired, the request layer refreshes it with the persisted `refresh_token` and writes the replacement token back into SQLite
4. only when refresh cannot recover does the HTTP path fail soft with `error=oauth_reauth_required`
   - runtime observability now also emits an immediate console alert for `oauth_reauth_required`, rate-limited in-memory to avoid repeated bursts from the same failing account
5. for heading-targeted doc updates, preview may still resolve the target doc from explicit IDs or shared doc URLs and then read current raw markdown
6. the handler resolves the target heading section and turns the requested insert into a full-document replace candidate
7. targeted updates then reuse the same preview/confirm replace gate instead of introducing a second Lark write primitive
8. the final write step no longer trusts preview-time URL resolution alone; it requires explicit `document_id` and `section_heading`, otherwise it returns structured `missing_explicit_write_target`
9. handler calls `lark-content.mjs`
10. `lark-content.mjs` calls Lark SDK
11. for Lobster-created `docx` files, the initiating user's `open_id` is granted `full_access`
12. Result is normalized and returned
13. if the JSON write request included `idempotency_key`, the HTTP layer persists the first response into SQLite `http_request_idempotency`
14. later repeated requests with the same `method + pathname + explicit account_id when provided + idempotency_key` replay that first persisted result instead of re-running the write path
15. direct-message cleanup requests can also delete the latest Lobster meeting doc through tenant-token fallback and persist a chat-only failure-report preference

### Sync Flow

1. `/sync/full` or `/sync/incremental`
2. `runSync(...)` starts sync job
3. connectors scan Drive and Wiki trees
4. doc text is extracted
5. text is chunked
6. repository writes sources, documents, chunks, and FTS rows
7. sync summary is written to `sync_jobs`

### Search / Answer Flow

1. `/search` or `/answer`
2. account context is resolved
3. FTS search runs against `lark_chunks_fts`
4. `/search` returns hits directly
5. `/answer` first goes through `executive-planner.mjs`
   - planner must emit strict legacy `{ action, params }` or bounded multi-step `{ steps: [{ action, params }] }`
   - wrapped/non-JSON planner output is rejected as `{ error: "planner_failed" }`
   - runtime observability now also emits an immediate console alert for `planner_failed`, rate-limited in-memory to avoid repeated bursts from malformed planner output
   - actions outside `planner_contract.json` are rejected before execution
   - valid single-step decisions run the corresponding contract-bound action/preset; valid multi-step decisions run ordered contract-bound tool actions through the existing planner dispatcher and return a structured planner envelope
6. the legacy/internal `answer-service.mjs` prompt path still prefers:
   - current question
   - compact workflow checkpoint
   - trimmed retrieved snippets
   - XML-wrapped sections with anti-hallucination rules and user-intent self-check instructions
   - stable section labels for cache-friendly prefixes
7. shared generation settings clamp variability to `temperature=0.1` and `top_p=0.7~0.8`
8. workflow state is written to an external checkpoint store instead of replaying full prior rounds
9. cloud-document organization follow-ups use a split path:
   - generic "what still needs second confirmation?" turns reuse a session-scoped cached review summary
   - explicit reassignment / re-review turns rerun the slower MiniMax second-pass semantic review

### External Skill Governance Flow

1. high-priority Lobster tasks first resolve whether an external skill should be used
2. the external skill layer lives outside the repo under `~/.agents` and `~/.codex`
3. the repo mirrors only the governance view of those skills:
   - routing map
   - audit summary
4. first-batch Lobster-critical skills are now translated into Traditional Chinese and aligned to:
   - Codex usage
   - Lobster workflow fit
   - lower-context, stronger-operational guidance
5. remaining skills still require staged audit before being treated as governed production skills

### Comment Rewrite Flow

1. `/api/doc/rewrite-from-comments`
2. service reads document content
3. service reads unresolved comments
4. service loads document-specific workflow checkpoint
5. service builds rewrite prompt from:
   - rewrite goal / constraints
   - checkpoint summary
   - document structure
   - focused excerpts around commented paragraphs
   - compact comment summary
   - capped full-document fallback only when still needed
   - XML anti-hallucination / self-check policy wrapper
5. LLM returns:
   - change summary
   - revised full document content
6. preview mode returns proposal only
7. apply mode replaces doc content
8. optional comment resolution marks comments as solved
9. rewrite checkpoint is updated externally after preview/apply

### Comment Suggestion Card Flow

1. `/api/doc/comments/suggestion-card`
2. service reads unresolved comments
3. local watch state filters to unseen comments
4. rewrite preview is generated from those comments
5. confirmation artifact is created
6. human-readable suggestion card is returned
7. optional `message_id` path replies with the card
8. optional `mark_seen=true` records those comments in local watch state

### HTTP High-Risk Route Governance

1. `http-server.mjs` creates a per-request `trace_id`
2. the HTTP layer echoes that trace through JSON `trace_id` payload injection when the response is an object, and through the `X-Trace-Id` header for every response
3. when the response finishes, the runtime writes one compact row into SQLite `http_request_monitor` with request identity, status, outcome, error summary, and duration
4. high-risk routes use route-level child loggers (`route_started` / `route_succeeded` / `route_failed`)
5. high-risk handlers emit step logs for start, validation failure, and completion
6. current high-risk coverage includes:
   - drive organize preview/apply
   - wiki organize preview/apply
   - bitable records list/search/create/get/update/delete
   - calendar event create/freebusy
   - task get/create/comments list/create/update/delete
7. `/api/monitoring/requests`, `/api/monitoring/errors`, `/api/monitoring/errors/latest`, and `/api/monitoring/metrics` query that persisted request-monitor table
8. `/monitoring` renders a simple server-side HTML dashboard from the same monitoring snapshot, showing success rate, error rate, recent errors, and recent requests
9. `tool_execution` events now also persist into `http_request_trace_events`, including `duration_ms`, so later analysis can measure per-tool success rate and latency without scraping console logs
10. `/api/monitoring/learning` and `scripts/monitoring-cli.mjs learning ...` derive a review-first learning summary from recent request rows plus trace events
11. `POST /agent/improvements/learning/generate` converts that summary into `pending_approval` improvement proposals instead of auto-applying routing/tool changes
12. success-path smoke fixtures verify these routes can initialize and return shaped JSON with `trace_id`
13. self-check verifies both preview/read and apply/write route-contract presence for these high-risk HTTP families

### Meeting Flow

1. User can start the workflow in three ways:
   - send `/meeting ...` for immediate transcript processing
   - send menu wake text `會議` / `会议` / `meeting`
   - send a natural-language start phrase such as `我要開會了`
   - short offline meeting cues such as `線下會議 請記錄`, `okr 周例會`, or `現在正要開始 請準備記錄吧`
     - lane execution now tries to auto-bind the current or nearest calendar event with a `meeting_url` before falling back to chat-only capture
   - if the user says `開始旁聽這場會議` or `/meeting current`, lane execution first resolves the current or nearest calendar event with a `meeting_url`
2. if the start signal does not yet contain transcript content, lane execution opens a chat-scoped meeting capture mode
   - when local microphone capture is enabled and available, the host machine starts recording through `ffmpeg`
   - a dedicated Lark meeting document is created immediately and seeded with a draft placeholder
   - the meeting starter is granted `full_access` on that document instead of read-only access
   - if user OAuth refresh is invalid, the capture path can still fall back to tenant-token document creation for offline meeting capture
   - later plain-text messages in the same chat are appended silently into a local capture buffer
   - explicit status-check questions such as `請問在持續記錄中嗎` return a short status reply instead of being appended to the transcript
   - microphone process metadata is persisted with the meeting session so status/stop can recover after a service restart
   - if an existing meeting document is reused, the same `full_access` grant is repaired on reuse
3. user ends capture by saying `會議結束了` or `/meeting stop`
4. on stop, the host recording is stopped and transcribed through local `faster-whisper` by default, or a configured OpenAI-compatible endpoint when explicitly selected
5. captured audio transcript text plus chat-captured text, or the original `/meeting ...` content, is passed into `meeting-agent.mjs`
   - any image-bearing meeting messages are first converted into compact structured image notes before they join the chat transcript
   - chat transcript passed into summary prompting is capped so the full raw transcript is not repeatedly injected into the text model
6. `meeting-agent.mjs` classifies the content as `weekly` or `general`
7. fixed-format summary is generated
   - LLM JSON output is retried when malformed before sanitizers consume it
   - a structured meeting artifact is also generated with:
     - summary
     - decisions
     - action_items
     - owner
     - deadline
     - risks
     - open_questions
     - conflicts
     - knowledge_writeback
     - task_writeback
     - follow_up_recommendations
8. for chat-capture sessions, the final meeting document is replaced with:
   - a usable meeting-minutes section
   - the merged raw transcript section
   - if local audio exists but transcription returns no usable text, the document is replaced with a clear failure note instead of a fake meeting summary
   - low-signal control chatter such as acknowledgements or status checks is filtered out of the transcript section
   - if the account preference `meeting_failure_report_mode=chat_only` is set, failed-capture docs are deleted and the failure explanation is returned only in chat
9. for direct `/meeting ...` preview requests, the older confirmation flow still applies
   - current default is an interactive card with a confirm button that opens `/meeting/confirm`
10. a pending confirmation artifact is stored locally
11. no document write happens before confirmation in that preview-only path
12. user confirms via card button, `/meeting confirm <confirmation_id>`, or `POST /api/meeting/confirm`
13. service finds an existing mapped meeting doc or creates a stable doc on demand
14. new meeting entry is prepended to the top of the target document
15. if meeting type is `weekly`, structured todo tracker rows are upserted after the doc write
16. on confirmed write, meeting knowledge writeback is registered into pending proposal memory instead of jumping straight into approved long-term knowledge

## Event Flow

### Long Connection Event

1. `src/index.mjs` starts `Lark.WSClient`
2. `im.message.receive_v1` events enter event dispatcher
3. binding/session/workspace keys are resolved from peer identity
4. capability lane is resolved from peer scope plus structured message content
   - lane detection now reads explicit `document_id` / `doc_token` style fields from payload JSON
   - message parsing also reads pasted Bitable `base/...` URLs from text or structured link payloads
   - reply-chain follow-up text like "幫我看一下" can route into the doc lane when it is replying to a shared doc context
5. session scope is persisted locally
6. lane executor chooses one lane strategy:
  - `group-shared-assistant`
  - `personal-assistant`
  - `doc-editor`
  - `knowledge-assistant`
   - executive orchestration layer for slash agents and active multi-turn executive tasks
   - checked-in slash-agent dispatcher for `/generalist`, `/ceo`, `/product`, `/prd`, `/cmo`, `/consult`, `/cdo`, `/delivery`, `/ops`, `/tech`, and `/knowledge *`
   - command-scoped `/meeting` workflow before the lane-specific default behavior
   - image-only or image+text requests are also split through a modality router before plain text lane fallback
7. lane-specific service calls run
   - if the message is a slash-agent command, or the current session already has an active executive task, the executive planner can:
     - start a new task
     - continue the current task
     - hand off to another registered agent
     - attach a compact work plan with primary and supporting agents
     - run supporting-agent passes in parallel async calls
     - feed those supporting outputs back into the primary agent for synthesis
     - render the final visible reply as:
       - direct answer first
       - orchestration context only when useful
       - visible subtask list
       - visible supporting-agent summaries
     - initialize task rules and lifecycle state
     - collect execution evidence
     - run verifier pass/fail checks before completion
     - if verification fails, return the task to `executing`, `blocked`, or `escalated`
     - append reflection records and improvement proposals after important turns
     - persist reflection records and improvement proposals into dedicated stores
     - low-risk `auto_apply` improvements can be marked applied immediately
     - `proposal_only` and `human_approval` improvements now enter an explicit approval workflow
     - end the active executive task when the user explicitly exits
     - when direct `LLM_API_KEY` is unavailable, registered slash agents and the executive planner now try the local OpenClaw MiniMax text channel through the dedicated `lobster-backend` agent before any extractive-only fallback
   - slash-agent messages are parsed first; knowledge subcommands and persona agents reuse retrieval grounding plus compact role prompts instead of falling back to generic private-chat replies
   - slash-agent messages that include images first call the Nano Banana-oriented image adapter, then only pass compact structured image fields into the text model
   - DM requests like "把我的雲文檔做分類 指派給對應的角色" now enter a chat-scoped cloud-doc organization workflow mode inside the personal lane
   - while that mode is active, follow-up turns about learning, unrelated docs, and reassignment stay on the same organization preview path instead of falling back to meeting/private-chat boilerplate
   - a second-pass role-review branch can now take those follow-up turns and run a small MiniMax semantic re-review only on ambiguous documents, returning reassignment candidates and manual-review candidates instead of only top-level category counts
   - if the user says the second-pass output is hard to understand, that same workflow now stays in mode and returns a plain-language version instead of leaking internal classifier reasons such as `local_rule_fallback`
   - follow-up questions like `這些待人工確認的文件，為什麼不能直接分配？` now force the cloud-doc organization workflow back into a reason-explainer branch, even if the earlier workflow mode was not successfully resumed
   - once the cloud-doc organization workflow mode is active, generic follow-ups like `還有什麼內容需要我二次確認` now stay in second-pass review instead of dropping back to the first-pass category overview
   - the cloud-doc organization follow-up logic is now isolated in `src/cloud-doc-organization-workflow.mjs`, so these follow-ups can be regression-tested without reloading the full lane executor
   - users can exit that mode explicitly with phrases such as `退出分類模式`
   - image-only tasks now call the Nano Banana-oriented image adapter first and can return directly without sending long image descriptions into the text model
   - mixed image+text tasks now call the image adapter first, then only pass compact structured image fields into the downstream text synthesis step; if image analysis is unavailable, the text lane can still continue instead of failing the whole turn on image-config errors
   - doc lane may fetch referenced upstream messages to recover document tokens from shared cards or reply wrappers
   - upstream token recovery now accepts both prefixed doc tokens and plain `document_id` values from structured payloads
   - shared Bitable links are preflighted before default lane fallback so pasted base URLs can resolve app/table context directly
8. service sends text or card reply directly back to chat
   - for planner OKR / BD / delivery read flows, any `action_layer.next_actions` now also sync into a minimal local `task lifecycle v1` sidecar store before the planner turn summary is compacted; later task-oriented follow-ups such as `進度`, `誰負責`, `何時到期`, `這個卡住了`, and `這個完成了` first read/update that local store instead of dispatching a doc route, and can single-target one task by ordinal, `這個`, or unique `owner`; the same sidecar now also keeps `last_active_task_id`, so planner decision-time task driving can stay attached to the current task and prefer document/theme-matched scopes before falling back to the latest snapshot; ambiguous targeting returns candidate tasks and does not update state; this remains local JSON state only and does not change the visible planner response contract or write into DB/company-brain
9. structured runtime logs are emitted for:
   - per-event `trace_id`
   - per-request HTTP `trace_id`
   - event intake and skip reasons
   - HTTP request start / finish / parse-failure / request-failure
   - HTTP route child logs for auth/doc/meeting/messages/knowledge/drive/wiki/bitable/calendar/tasks
   - handler step logs for drive/wiki organize, bitable records, calendar create/freebusy, and task comments
   - lane resolution
   - registered-agent retrieval / generation
   - meeting doc prepare / update / delete / confirm-write
   - image analysis route and fallback
   - doc token resolution hits / misses / upstream lookup failures
   - reply send success
   - event-level failures
10. duplicate long-connection message re-deliveries with the same `message_id` are skipped before lane execution
11. while meeting capture is active, normal note text is suppressed into the transcript but explicit status checks can still return a short reply
12. if lane execution fails after the event is accepted, the bot now returns a user-visible structured error envelope (for example `ROUTING_NO_MATCH`, `INVALID_ACTION`, or `FALLBACK_DISABLED`) instead of silently failing or emitting a canned default reply

This is now a capability-lane event path with a closed-loop executive planner layered inside it. It is still not an async job-queue planner system.

## Governance / Health Flow

1. `npm run release-check`
2. local operator entry = `scripts/release-check.mjs`; CI/pipeline entry = `scripts/release-check-ci.mjs`
3. release-check internally reuses `runSystemSelfCheck(...)` from `src/system-self-check.mjs`
4. self-check validates:
   - registered agent completeness
   - minimum agent contract fields
   - knowledge subcommand coverage
   - key HTTP route-contract coverage, including high-risk write/apply paths
   - core service-module initialization
   - latest routing diagnostics snapshot from `.tmp/routing-diagnostics-history/`, plus compare against the previous routing snapshot when available
   - current planner contract gate from `scripts/planner-contract-check.mjs`, using the same blocking criteria for undefined actions, undefined presets, and selector/contract mismatches
   - planner compare against the latest archived planner diagnostics snapshot in `.tmp/planner-diagnostics-history/`, when one exists
   - archive the unified self-check result itself into `.tmp/system-self-check-history/manifest.json` and `.tmp/system-self-check-history/snapshots/<run-id>.json`
   - unified summary fields:
     - `system_summary`
     - `routing_summary`
     - `planner_summary`
   - self-check archive manifest fields:
     - `run_id`
     - `timestamp`
     - `system_status`
     - `routing_status`
     - `planner_status`
5. `release-check` then compresses the same evidence into one merge/release preflight answer:
   - human-readable output only answers:
     - `能否放心合併/發布：可以 / 先不要`
     - `若不能，先修哪一條線：system regression / routing regression / planner contract failure / 無`
     - `先看哪類 case：doc / meeting / runtime / mixed / 無`
   - `--json` output stays minimal:
     - `overall_status`
     - `blocking_checks`
     - `suggested_next_step`
     - `failing_area`
     - `representative_fail_case`
     - `drilldown_source`
   - `blocking_checks` only emits first-level triage classes:
     - `system_regression`
     - `routing_regression`
     - `planner_contract_failure`
   - `suggested_next_step` stays single-line and points to the module family or file type to inspect first:
     - system regression -> `src/agent-registry.mjs`, `src/http-route-contracts.mjs`, or failing service modules
     - routing regression -> routing rule modules (`src/router.js`, `src/planner-*-flow.mjs`) or eval fixture files (`evals/routing-eval-set.mjs`, `tests/routing-eval*.test.mjs`)
     - planner contract failure -> planner registry / flow-route modules first, and `docs/system/planner_contract.json` only for intentional stable targets
   - CI output stays on the same minimal JSON shape:
     - `overall_status`
     - `blocking_checks`
     - `suggested_next_step`
     - `failing_area`
     - `representative_fail_case`
     - `drilldown_source`
   - every `release-check` and `release-check:ci` run also archives the current report into `.tmp/release-check-history/`
   - release-check archive manifest fields:
     - `run_id`
     - `timestamp`
     - `overall_status`
     - `blocking_checks`
     - `suggested_next_step`
   - exit code contract is strict and binary:
     - `overall_status = pass` -> exit `0` -> pass -> can proceed in merge/deploy pipeline
     - `overall_status = fail` -> exit `1` -> fail -> must block merge/deploy until the blocking line is fixed
   - `release-check` is read-only:
     - it does not rerun routing eval
     - it does not change routing
     - it does not add fallback
     - it does not change planner gate rules
     - it does not auto-fix anything
6. fail handling order for the unified self-check and release-check:
   - if base registry / route / service checks fail, fix those first
   - else if `routing_summary.status != pass` or routing compare shows obvious regression, inspect routing first
   - else if `planner_summary.gate = fail` or planner compare shows obvious regression, inspect planner first
7. line separation rule:
   - routing line = archived behavior regression evidence from latest snapshot / compare (`accuracy_ratio`, `trend_report`, `decision_advice`, error drift)
   - planner line = current runtime / contract drift evidence (`gate`, `undefined_actions`, `undefined_presets`, `selector_contract_mismatches`, `deprecated_reachable_targets`)
8. when to run each entry:
   - local/manual use: run `npm run release-check` when a developer wants the bounded two-line merge/release verdict
   - CI/pipeline use: run `npm run release-check:ci` when a job needs machine-readable JSON plus strict exit code
   - PR validation: if the PR changes planner contract, selector/route wiring, release gate scripts, or `docs/system` governance/runtime docs tied to those checks, `release-check:ci` must run in the PR pipeline
   - merge gate: run `npm run release-check:ci` before allowing merge to the protected branch
   - release gate: rerun `npm run release-check:ci` in the release/deploy pipeline before deployment
   - run `npm run self-check` during normal development when you still need the fuller base/routing/planner summary
   - `release-check` does not replace `npm test` or other release verification commands; it only compresses the governance/readiness lines above into one preflight verdict
9. default `self-check` CLI output is still the short human-readable verdict; `npm run self-check -- --json` emits the full JSON report for CI or follow-up tooling
10. compare mode is also available on the same read-only path:
   - `npm run self-check -- --compare-previous`
   - `npm run self-check -- --compare-snapshot <run-id|path>`
   - compare output stays minimal and only answers:
     - whether `system` became better / worse / unchanged
     - whether `routing` regressed
     - whether `planner` regressed
   - compare does not modify routing, add fallback, change planner gate rules, or auto-fix anything
11. release-check compare is also available on the same read-only archive path:
   - `npm run release-check -- --compare-previous`
   - `npm run release-check -- --compare-snapshot <run-id|path>`
   - `npm run release-check:ci -- --compare-previous`
   - `npm run release-check:ci -- --compare-snapshot <run-id|path>`
   - compare only answers:
     - whether `release` status became better / worse / unchanged
     - whether `blocking_checks` changed
     - whether `suggested_next_step` changed
   - compare does not modify gate ordering, add fallback, auto-fix anything, or introduce a new decision layer

Minimal platform-neutral pipeline shape:

```bash
npm ci
npm test
npm run release-check:ci
```

The last command is the merge/deploy blocker for this preflight line:

- exit `0` = pass = can continue the current pipeline stage
- exit `1` = fail = stop merge/deploy and inspect `blocking_checks[0]` first

## Improvement Approval Flow

1. executive closed-loop layer generates reflection and improvement proposals
2. reflections are archived to `executive-reflections`
3. improvement proposals are archived to `executive-improvements`
4. proposal modes behave as follows:
   - `auto_apply` -> stored as applied immediately
   - `proposal_only` -> stored as `pending_approval`
   - `human_approval` -> stored as `pending_approval`
5. operators can use:
   - `GET /agent/improvements`
   - `POST /agent/improvements/learning/generate`
   - `POST /agent/improvements/:proposal_id/approve`
   - `POST /agent/improvements/:proposal_id/reject`
   - `POST /agent/improvements/:proposal_id/apply`
6. approve / reject / apply now target the newest matching stored proposal record for a given `proposal_id`, so old archived duplicates do not silently update the wrong task-local proposal state
7. monitoring-derived routing/tool proposals reuse the same workflow, but stay `pending_approval` by default even when the suggestion is a weight adjustment
8. once approved and applied, the proposal is written into approved memory as an `improvement_applied` record
9. if every proposal on the task is applied, the task can advance to `improved`

## Async and Background Flow

- Sync work is request-triggered, not queue-backed.
- Drive move/delete may return async Lark task IDs, then caller polls `/api/drive/task-status`.
- There is no internal job queue or worker process in this repo.
- Comment suggestion cards can run from:
  - startup timer poller when enabled
  - one-shot manual poll via `POST /api/doc/comments/poll-suggestion-cards`

## Security Approval Flow

1. OpenClaw tool or HTTP caller starts secure task
2. HTTP server calls `lobster-security-bridge.mjs`
3. bridge invokes Python CLI
4. wrapper evaluates policy
5. action either:
   - completes
   - requires approval
   - fails closed
6. pending approvals are persisted under `.data/lobster-security`
7. approval endpoints resolve them later

## Agent-Like Flow

This repo has AI-assisted flows, but not a planner/router/specialist team.

Actual AI-like execution paths:

- semantic document classification
  - organizer -> `lark-drive-semantic-classifier.mjs` -> governed XML batch prompt -> OpenClaw agent
  - malformed or incomplete classifier JSON triggers a repair retry before local-rule fallback

- planner-gated retrieval / tool execution
  - answer route -> `executive-planner.mjs` strict single-step `{ action, params }` or bounded `{ steps: [{ action, params }] }` decision -> contract-bound planner action/preset execution or sequential planner tool execution
  - direct user-input answer fallback is disabled; `answer-service.mjs` is no longer the first responder for `/answer` or the knowledge-assistant lane

- comment-driven rewrite
  - rewrite route -> `doc-comment-rewrite.mjs` -> external checkpoint + governed XML prompt -> optional LLM
  - comment images are reduced to compact attachment counts instead of long raw image payload text

- image understanding
  - lane executor -> `modality-router.mjs` -> `image-understanding-service.mjs` -> Nano Banana-style provider -> compact structured image result
  - Playground now sends Nano Banana image understanding through Gemini `generateContent` with inline image parts, not through OpenAI-style chat completions
  - directly reachable image URLs are fetched and converted to inline image parts
  - Lark `image_key` payloads can also be downloaded through `lark-content.mjs` and converted to inline image parts before analysis
  - if a mixed image+text turn hits an image download / analysis exception, lane execution degrades back to the text lane so the text question still gets answered

- OpenClaw tool execution
  - plugin formatter -> compact payload summary
  - avoids echoing full JSON / logs / long API payloads back into agent context by default

## Boundaries

- Local boundary:
  - Node service
  - SQLite database
  - local JSON state

- External boundary:
  - Lark APIs
  - OpenAI-compatible LLM endpoint
  - OpenClaw runtime
  - Python `lobster_security` subproject

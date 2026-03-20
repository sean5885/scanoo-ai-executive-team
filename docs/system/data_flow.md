# Data Flow

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Request Flow

### OAuth

1. User opens `/oauth/lark/login`
2. Service redirects to Lark authorization
3. Callback hits `/oauth/lark/callback`
4. Service exchanges code for user token
5. Account and token are persisted to local storage

### Browse / Write Flow

1. HTTP route resolves account and valid token
2. Handler calls `lark-content.mjs`
3. `lark-content.mjs` calls Lark SDK
4. for Lobster-created `docx` files, the initiating user's `open_id` is granted `full_access`
5. Result is normalized and returned
6. direct-message cleanup requests can also delete the latest Lobster meeting doc through tenant-token fallback and persist a chat-only failure-report preference

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
5. `/answer` either:
   - calls the dedicated OpenClaw MiniMax text path when direct text credentials are absent
   - or calls OpenAI-compatible chat completions with governed context
   - only falls back to retrieval-summary output if text generation fails
6. governed answer prompts now prefer:
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
2. high-risk routes use route-level child loggers (`route_started` / `route_succeeded` / `route_failed`)
3. high-risk handlers emit step logs for start, validation failure, and completion
4. current high-risk coverage includes:
   - drive organize preview/apply
   - wiki organize preview/apply
   - bitable records list/search/create/get/update/delete
   - calendar event create/freebusy
   - task get/create/comments list/create/update/delete
5. success-path smoke fixtures verify these routes can initialize and return shaped JSON with `trace_id`
6. self-check verifies both preview/read and apply/write route-contract presence for these high-risk HTTP families

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
   - for planner OKR / BD / delivery read flows, any `action_layer.next_actions` now also sync into a minimal local `task lifecycle v1` sidecar store before the planner turn summary is compacted; later task-oriented follow-ups such as `進度`, `誰負責`, `何時到期`, `這個卡住了`, and `這個完成了` first read/update that local store instead of dispatching a doc route, and can single-target one task by ordinal, `這個`, or unique `owner`; ambiguous targeting returns candidate tasks and does not update state; this remains local JSON state only and does not change the visible planner response contract or write into DB/company-brain
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
12. if lane execution fails after the event is accepted, the bot now sends a user-visible fallback reply instead of failing silently

This is now a capability-lane event path with a closed-loop executive planner layered inside it. It is still not an async job-queue planner system.

## Governance / Health Flow

1. `npm run self-check`
2. `scripts/self-check.mjs` imports `src/system-self-check.mjs`
3. self-check validates:
   - registered agent completeness
   - minimum agent contract fields
   - knowledge subcommand coverage
   - key HTTP route-contract coverage, including high-risk write/apply paths
   - core service-module initialization
4. result is emitted as JSON so CI or operators can quickly detect obvious chain breaks before runtime debugging

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
   - `POST /agent/improvements/:proposal_id/approve`
   - `POST /agent/improvements/:proposal_id/reject`
   - `POST /agent/improvements/:proposal_id/apply`
6. once approved and applied, the proposal is written into approved memory as an `improvement_applied` record
7. if every proposal on the task is applied, the task can advance to `improved`

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

- retrieval QA
  - answer route -> `answer-service.mjs` -> external checkpoint + governed XML prompt -> optional LLM

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

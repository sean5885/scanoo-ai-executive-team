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
4. Result is normalized and returned

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
   - returns extractive answer
   - or calls OpenAI-compatible chat completions with governed context
6. governed answer prompts now prefer:
   - current question
   - compact workflow checkpoint
   - trimmed retrieved snippets
   - stable section labels for cache-friendly prefixes
7. workflow state is written to an external checkpoint store instead of replaying full prior rounds

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

### Meeting Flow

1. User sends `/meeting ...` in a long-connection chat or calls `POST /api/meeting/process`
2. `meeting-agent.mjs` classifies the content as `weekly` or `general`
3. fixed-format summary is generated
4. summary is sent to the designated Lark group using the message adapter
   - current default is an interactive card with a confirm button that opens `/meeting/confirm`
5. a pending confirmation artifact is stored locally
6. no document write happens before confirmation
7. user confirms via card button, `/meeting confirm <confirmation_id>`, or `POST /api/meeting/confirm`
8. service finds an existing mapped meeting doc or creates a stable doc on demand
9. new meeting entry is prepended to the top of the target document
10. if meeting type is `weekly`, structured todo tracker rows are upserted after the doc write

## Event Flow

### Long Connection Event

1. `src/index.mjs` starts `Lark.WSClient`
2. `im.message.receive_v1` events enter event dispatcher
3. binding/session/workspace keys are resolved from peer identity
4. capability lane is resolved from peer scope plus structured message content
   - lane detection now reads explicit `document_id` / `doc_token` style fields from payload JSON
   - reply-chain follow-up text like "幫我看一下" can route into the doc lane when it is replying to a shared doc context
5. session scope is persisted locally
6. lane executor chooses one lane strategy:
  - `group-shared-assistant`
  - `personal-assistant`
  - `doc-editor`
  - `knowledge-assistant`
   - command-scoped `/meeting` workflow before the lane-specific default behavior
7. lane-specific service calls run
   - doc lane may fetch referenced upstream messages to recover document tokens from shared cards or reply wrappers
   - upstream token recovery now accepts both prefixed doc tokens and plain `document_id` values from structured payloads
8. service sends text or card reply directly back to chat
9. structured runtime logs are emitted for:
   - event intake and skip reasons
   - lane resolution
   - doc token resolution hits / misses / upstream lookup failures
   - reply send success
   - event-level failures
10. if lane execution fails after the event is accepted, the bot now sends a user-visible fallback reply instead of failing silently

This is still not a planner-dispatch flow. It is a capability-lane event path.

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
  - organizer -> `lark-drive-semantic-classifier.mjs` -> governed batch prompt -> OpenClaw agent

- retrieval QA
  - answer route -> `answer-service.mjs` -> external checkpoint + governed prompt -> optional LLM

- comment-driven rewrite
  - rewrite route -> `doc-comment-rewrite.mjs` -> external checkpoint + governed prompt -> optional LLM

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

# Modules

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Module Inventory

### 1. Runtime Entrypoints

- Location:
  - `/Users/seanhan/Documents/Playground/src/index.mjs`
  - `/Users/seanhan/Documents/Playground/src/http-only.mjs`
  - `/Users/seanhan/Documents/Playground/src/runtime-observability.mjs`
- Responsibility:
  - start long-connection listener and/or HTTP server
  - emit structured runtime logs for long-connection event intake, lane routing, reply send, and failure paths
- Main entry:
  - `startHttpServer()`
- Depends on:
  - `config.mjs`
  - `http-server.mjs`
- Core path:
  - yes

### 1A. Binding / Session Runtime

- Location:
  - `/Users/seanhan/Documents/Playground/src/binding-runtime.mjs`
  - `/Users/seanhan/Documents/Playground/src/session-scope-store.mjs`
- Responsibility:
  - resolve Lark peer identity into binding/session/workspace/sandbox keys
  - persist latest peer-scoped session touches
  - provide capability-lane routing keys for downstream execution
- Main entry:
  - `resolveLarkBindingRuntime()`
  - `touchResolvedSession()`
- Depends on:
  - `config.mjs`
  - `token-store.mjs`
- Core path:
  - yes for future Lark assistant expansion

### 2. HTTP API Layer

- Location:
  - `/Users/seanhan/Documents/Playground/src/http-server.mjs`
  - `/Users/seanhan/Documents/Playground/src/http-route-contracts.mjs`
- Responsibility:
  - route parsing
  - route method contract
  - auth checks
  - HTTP endpoint handling
  - response shaping
- Main entry:
  - `startHttpServer()`
- Depends on:
  - OAuth, content, sync, answer, security bridge modules
- Core path:
  - yes
- Coupling note:
  - still high, but route method contracts now live outside the server file
  - comment suggestion cards and preview-confirm doc writes are also coordinated here

### 3. OAuth and User Context

- Location:
  - `/Users/seanhan/Documents/Playground/src/lark-user-auth.mjs`
  - `/Users/seanhan/Documents/Playground/src/token-store.mjs`
- Responsibility:
  - build login URL
  - exchange code
  - refresh token
  - resolve valid user token
- Core path:
  - yes

### 3A. Comment Preview and Watch State

- Location:
  - `/Users/seanhan/Documents/Playground/src/doc-preview-cards.mjs`
  - `/Users/seanhan/Documents/Playground/src/doc-update-confirmations.mjs`
  - `/Users/seanhan/Documents/Playground/src/comment-watch-store.mjs`
- Responsibility:
  - build human-readable replace/rewrite preview cards
  - persist confirmation artifacts for two-step apply
  - track unseen document comments for suggestion-card workflows
  - run reusable suggestion-card generation flow
  - support watched-document polling
- Core path:
  - yes for safe doc editing

### 4. Lark Content Service

- Location:
  - `/Users/seanhan/Documents/Playground/src/lark-content.mjs`
- Responsibility:
  - direct Lark SDK calls for drive, wiki, doc, comments, messages, reactions, calendar, freebusy, tasks, bitable, and sheets
- Core path:
  - yes

### 5. Lark Tree Scanning Connectors

- Location:
  - `/Users/seanhan/Documents/Playground/src/lark-connectors.mjs`
- Responsibility:
  - recursive drive and wiki scan
  - doc text extraction
- Core path:
  - yes for sync

### 6. Sync and Indexing

- Location:
  - `/Users/seanhan/Documents/Playground/src/lark-sync-service.mjs`
  - `/Users/seanhan/Documents/Playground/src/chunking.mjs`
- Responsibility:
  - scan authorized content
  - normalize content
  - write documents and chunks
- Core path:
  - yes

### 7. Storage and Repository

- Location:
  - `/Users/seanhan/Documents/Playground/src/db.mjs`
  - `/Users/seanhan/Documents/Playground/src/rag-repository.mjs`
- Responsibility:
  - schema
  - persistence
  - FTS indexing
  - sync job recording
- Core path:
  - yes

### 8. Search and Answer

- Location:
  - `/Users/seanhan/Documents/Playground/src/answer-service.mjs`
- Responsibility:
  - FTS retrieval
  - extractive fallback
  - optional LLM answer
  - prompt-budget governance and workflow-checkpoint-aware knowledge answers
- Core path:
  - yes

### 8A. Agent Token Governance

- Location:
  - `/Users/seanhan/Documents/Playground/src/agent-token-governance.mjs`
  - `/Users/seanhan/Documents/Playground/src/agent-workflow-state.mjs`
- Responsibility:
  - prompt slimming
  - context budget staging
  - structured rolling checkpoint summary
  - tool output compression
  - external workflow state persistence
- Core path:
  - yes for AI-heavy flows

### 9. Drive and Wiki Organization

- Location:
  - `/Users/seanhan/Documents/Playground/src/lark-drive-organizer.mjs`
  - `/Users/seanhan/Documents/Playground/src/lark-wiki-organizer.mjs`
  - `/Users/seanhan/Documents/Playground/src/lark-drive-semantic-classifier.mjs`
- Responsibility:
  - semantic classification
  - preview/apply organization plans
- Core path:
  - important, but not base runtime

### 10. Comment Rewrite

- Location:
  - `/Users/seanhan/Documents/Playground/src/doc-comment-rewrite.mjs`
- Responsibility:
  - collect comments
  - call LLM
  - generate rewrite preview
  - keep rewrite-specific checkpoint state and use focused excerpts instead of full raw document when possible
  - optionally write back and resolve comments
- Core path:
  - important recent capability

### 10A. Lane Execution

- Location:
  - `/Users/seanhan/Documents/Playground/src/capability-lane.mjs`
  - `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`
  - `/Users/seanhan/Documents/Playground/src/message-intent-utils.mjs`
- Responsibility:
  - resolve one lane from message intent and peer scope
  - normalize structured Lark message content into reusable intent signals
  - extract document IDs from raw message payloads, shared links, and reply-chain upstream messages
  - execute lane-specific reply and tool strategy for DM, group, doc, and knowledge requests
  - for doc lane, also inspect referenced upstream messages when current message only contains a share/reply wrapper
  - keep group-summary prompts in the group lane instead of over-matching the knowledge lane
  - emit doc-resolution and auth-context runtime logs to support live payload debugging
- Core path:
  - yes for long-connection assistant behavior

### 11. OpenClaw Plugin

- Location:
  - `/Users/seanhan/Documents/Playground/openclaw-plugin/lark-kb`
- Responsibility:
  - expose repo HTTP API as OpenClaw tools
  - compress oversized tool payloads before they are returned into agent context
- Main entry:
  - `register(...)` in `index.ts`
- Core path:
  - yes for OpenClaw users

### 12. Secure Local Action Bridge

- Location:
  - `/Users/seanhan/Documents/Playground/src/lobster-security-bridge.mjs`
- Responsibility:
  - invoke Python security wrapper CLI
  - manage pending approval state
- Core path:
  - yes for secured agent actions

### 13. Python Security Subproject

- Location:
  - `/Users/seanhan/Documents/Playground/lobster_security`
- Responsibility:
  - workspace sandbox
  - command policy
  - network guard
  - approval
  - audit
  - rollback
- Core path:
  - separate but integrated subproject

## File-Level High-Value Entry Files

- `/Users/seanhan/Documents/Playground/src/http-server.mjs`
  - API router and operational center

- `/Users/seanhan/Documents/Playground/src/lark-content.mjs`
  - all direct user-token Lark operations

- `/Users/seanhan/Documents/Playground/src/lark-sync-service.mjs`
  - sync orchestrator

- `/Users/seanhan/Documents/Playground/src/rag-repository.mjs`
  - persistence and FTS query layer
  - local semantic embedding storage

- `/Users/seanhan/Documents/Playground/src/answer-service.mjs`
  - hybrid retrieval-to-answer pipeline
  - now uses stable prompt sections, checkpoint summaries, and retrieved-snippet budgets instead of stuffing raw chunks

- `/Users/seanhan/Documents/Playground/src/doc-comment-rewrite.mjs`
  - comment-to-doc patch-plan workflow
  - now prefers focused excerpts, compact comment summaries, and doc-specific checkpoints over full-doc replay

- `/Users/seanhan/Documents/Playground/src/doc-update-confirmations.mjs`
  - preview / confirm state store for safe doc overwrite and patch-plan apply

- `/Users/seanhan/Documents/Playground/src/agent-token-governance.mjs`
  - shared context budget, rolling-summary, and tool-output compression logic

- `/Users/seanhan/Documents/Playground/src/agent-workflow-state.mjs`
  - external checkpoint persistence for multi-round AI workflows

- `/Users/seanhan/Documents/Playground/src/secret-crypto.mjs`
  - token-at-rest encryption helper

- `/Users/seanhan/Documents/Playground/src/semantic-embeddings.mjs`
  - local semantic embedding generation and similarity

- `/Users/seanhan/Documents/Playground/src/runtime-contract.mjs`
  - Node/Python runtime compatibility check

- `/Users/seanhan/Documents/Playground/openclaw-plugin/lark-kb/index.ts`
  - external tool contract surface

## Dependency Shape

- entrypoints -> `http-server`
- `http-server` -> auth/content/sync/answer/security bridge
- sync -> connectors -> repository
- answer -> repository -> optional LLM
- comment rewrite -> content service -> optional LLM -> content service
- plugin -> HTTP API
- security bridge -> python `lobster_security` CLI

## Responsibility Risks

- `http-server.mjs` is too broad and mixes:
  - OAuth
  - browse
  - write
  - search
  - answer
  - security bridge

- `lark-content.mjs` is a strong central adapter, but it now spans multiple product domains:
  - doc
  - comments
  - messages
  - calendar
  - task
  - bitable
  - sheets
  - task
  - drive
  - wiki

- `lark-drive-semantic-classifier.mjs` depends on OpenClaw runtime conventions that live outside pure repo code.

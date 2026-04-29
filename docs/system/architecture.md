# Architecture

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## System Overview

This repository is a Lark-first local service for:

- user OAuth to Lark
- Drive / Docx / Wiki browsing and editing
- sync into a local SQLite RAG index
- keyword search and optional LLM answer generation
- OpenClaw tool exposure
- guarded local actions through `lobster_security`

It is not a browser frontend app. It now includes a closed-loop executive orchestration layer with compact work-plan synthesis, evidence-based verification, reflection, and improvement proposals, but it is still not a full background-planner system with autonomous worker queues.

## Architecture Layer vs Runtime Layer

This repo needs two different views:

- architecture layer
  - what logical responsibilities exist in code
  - how modules are separated into presentation / application / service / data
  - how requests move across those modules

- runtime layer
  - which actual processes start on a machine
  - which external services those processes depend on
  - where state is persisted at runtime

Use this file for the architecture view.
Use [deployment.md](/Users/seanhan/Documents/Playground/docs/system/deployment.md) for the runtime view.

## Layers

### Presentation Layer

- HTTP server
  - `/Users/seanhan/Documents/Playground/src/http-server.mjs`
- optional Lark long-connection bot
  - `/Users/seanhan/Documents/Playground/src/index.mjs`
- OpenClaw plugin tool surface
  - `/Users/seanhan/Documents/Playground/openclaw-plugin/lark-kb/index.ts`
  - current checked-in plugin entry first re-enters the Node runtime through `/Users/seanhan/Documents/Playground/src/lark-plugin-dispatch-adapter.mjs` via `POST /agent/lark-plugin/dispatch`

### Application Layer

- OAuth and account resolution
  - `/Users/seanhan/Documents/Playground/src/lark-user-auth.mjs`
- request handlers and route dispatch
  - `/Users/seanhan/Documents/Playground/src/http-server.mjs`
  - `/Users/seanhan/Documents/Playground/src/http-route-contracts.mjs`
  - `/Users/seanhan/Documents/Playground/src/monitoring-store.mjs`
  - `/Users/seanhan/Documents/Playground/src/lark-plugin-dispatch-adapter.mjs`
- comment rewrite orchestration
  - `/Users/seanhan/Documents/Playground/src/doc-comment-rewrite.mjs`
  - `/Users/seanhan/Documents/Playground/src/doc-preview-cards.mjs`
  - `/Users/seanhan/Documents/Playground/src/doc-update-confirmations.mjs`
  - `/Users/seanhan/Documents/Playground/src/doc-targeting.mjs`
- runtime scope resolution
  - `/Users/seanhan/Documents/Playground/src/binding-runtime.mjs`
  - `/Users/seanhan/Documents/Playground/src/session-scope-store.mjs`
  - `/Users/seanhan/Documents/Playground/src/capability-lane.mjs`
  - `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`
- answer orchestration
  - `/Users/seanhan/Documents/Playground/src/answer-service.mjs`
- task-layer helper orchestration
  - `/Users/seanhan/Documents/Playground/src/task-layer/task-classifier.mjs`
  - `/Users/seanhan/Documents/Playground/src/task-layer/task-dependency.mjs`
  - `/Users/seanhan/Documents/Playground/src/task-layer/task-skill-map.mjs`
  - `/Users/seanhan/Documents/Playground/src/task-layer/task-aggregator.mjs`
  - `/Users/seanhan/Documents/Playground/src/task-layer/task-to-answer.mjs`
  - `/Users/seanhan/Documents/Playground/src/task-layer/orchestrator.mjs`
  - may be consulted by `/Users/seanhan/Documents/Playground/src/executive-planner.mjs` as an optional planner pre-pass when a caller provides `runSkill`
- executive orchestration
  - `/Users/seanhan/Documents/Playground/src/executive-planner.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-task-state.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-orchestrator.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-closed-loop.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-lifecycle.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-verifier.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-reflection.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-improvement.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-memory.mjs`
  - `/Users/seanhan/Documents/Playground/src/single-machine-runtime-coordination.mjs`
  - additive planner plane scaffolds (contract/evidence/execution facade, no behavior change yet):
    - `/Users/seanhan/Documents/Playground/src/contracts/index.mjs`
    - `/Users/seanhan/Documents/Playground/src/evidence/index.mjs`
    - `/Users/seanhan/Documents/Playground/src/execution/index.mjs`
- sync orchestration
  - `/Users/seanhan/Documents/Playground/src/lark-sync-service.mjs`
- comment suggestion workflow and poller
  - `/Users/seanhan/Documents/Playground/src/comment-suggestion-workflow.mjs`
  - `/Users/seanhan/Documents/Playground/src/comment-suggestion-poller.mjs`

### Service Layer

- Lark content API adapter
  - `/Users/seanhan/Documents/Playground/src/lark-content.mjs`
- Lark tree scanning connectors
  - `/Users/seanhan/Documents/Playground/src/lark-connectors.mjs`
- drive/wiki organization and semantic classification
  - `/Users/seanhan/Documents/Playground/src/lark-drive-organizer.mjs`
  - `/Users/seanhan/Documents/Playground/src/lark-wiki-organizer.mjs`
  - `/Users/seanhan/Documents/Playground/src/lark-drive-semantic-classifier.mjs`
- secure local action bridge
  - `/Users/seanhan/Documents/Playground/src/lobster-security-bridge.mjs`

### Data Layer

- SQLite database and schema
  - `/Users/seanhan/Documents/Playground/src/db.mjs`
- repository operations and FTS indexing
  - `/Users/seanhan/Documents/Playground/src/rag-repository.mjs`
- request monitoring persistence and query
  - `/Users/seanhan/Documents/Playground/src/monitoring-store.mjs`
- local semantic embedding
  - `/Users/seanhan/Documents/Playground/src/semantic-embeddings.mjs`
- SQLite-backed OAuth token store
  - `/Users/seanhan/Documents/Playground/src/db.mjs`
  - `/Users/seanhan/Documents/Playground/src/rag-repository.mjs`
- token encryption helper
  - `/Users/seanhan/Documents/Playground/src/secret-crypto.mjs`
- local runtime files
  - `/Users/seanhan/Documents/Playground/.data`
  - includes session scope state for Lark peer isolation
  - includes doc rewrite confirmations and comment watch state

## What Belongs To Architecture, Not Deployment

The following are architecture concerns:

- route dispatch shape in `http-server.mjs`
- domain adapter boundaries in `lark-content.mjs`
- sync pipeline shape
- answer pipeline shape
- comment rewrite orchestration
- heading-targeted document update planning before replace apply
- plugin-to-HTTP contract
- security bridge boundary between Node and Python

These describe code structure and responsibility, not how many processes are running.

## Core Services and Relationships

- `http-server.mjs`
  - central runtime process
  - exposes all HTTP routes
  - calls OAuth, Lark content, sync, search/answer, security bridge, and monitoring query modules
  - now also exposes the checked-in plugin hybrid dispatch ingress and keeps direct `/answer` separate from the official plugin entry

- `monitoring-store.mjs`
  - persists one compact summary row per HTTP request into SQLite
  - persists trace-correlated runtime events into SQLite for request reconstruction
  - supports recent-request, recent-error, trace-reconstruction, and success/error-rate queries for local monitoring routes and CLI

- `agent-learning-loop.mjs`
  - reads recent request-monitor rows plus persisted trace events
  - summarizes routing failure patterns, tool success-rate/latency patterns, and draft routing/tool-weight proposals
  - adds bounded time-split A/B replay evidence (`control` vs `candidate`) plus `improvement_delta` for each draft proposal
  - low-risk learning proposals (`tool_weight_adjustment`) can be upgraded to `auto_apply`, while high-risk routing proposals stay `human_approval`
  - writes proposals into the existing improvement workflow with replay evidence so apply-stage verification can compare before/after metrics

- `binding-runtime.mjs`
  - converts Lark event identity into binding/session/workspace/sandbox keys

- `session-scope-store.mjs`
  - persists latest session scope touches for inspection and future agent routing

- `lane-executor.mjs`
  - turns capability lanes into real execution strategies instead of lane intro only
  - returns either text replies or card replies

- `doc-preview-cards.mjs` and `comment-watch-store.mjs`
  - turn rewrite proposals into human-readable cards
  - let the service detect newly arrived comments instead of treating every unresolved comment as new

- `lark-content.mjs`
  - wraps Lark SDK calls for doc, message, calendar, task, drive, wiki, and comment operations

- `lark-sync-service.mjs`
  - scans authorized Lark content and writes normalized documents/chunks into SQLite

- `answer-service.mjs`
  - performs hybrid retrieval and optionally calls an OpenAI-compatible model

- `executive-closed-loop.mjs`
  - turns execution output into evidence, verification, reflection, and improvement proposals
  - also records an additive plan-vs-execution reflection snapshot at `task.meta.execution_reflection` before verifier/improvement persistence, using structured step-level `success_match / deviation / reason` codes without changing user-visible answer output
  - after reflection, attaches the lightweight `improvement_proposal` onto `task.execution_journal` for internal traceability without changing the visible answer body

- `executive-improvement.mjs`
  - derives one lightweight pure `improvement_proposal` from `reflection_result`
  - task-journal proposal shape remains limited to `type / summary / action_suggestion`
  - provides shared low/high-risk policy resolution (`resolveImprovementExecutionPolicy`) used by both reflection proposals and learning-loop proposals
  - when a proposal is generated, it also stages one create-only JSON record under `/Users/seanhan/Documents/Playground/src/knowledge/pending/` with `id / type / summary / action_suggestion / confidence / created_at`
  - that file staging is pending-only and does not auto-approve or promote into `/Users/seanhan/Documents/Playground/src/knowledge/approved/`; workflow metadata and improvement-review persistence are still added downstream by the closed-loop improvement workflow

- `executive-improvement-workflow.mjs`
  - normalizes proposal risk/mode using shared policy before persistence
  - auto-apply proposals now require additive `effect_evidence` with before/after metric comparison and delta status
  - only measurable `improved` deltas stay `applied`; `same`/`regressed` outcomes are fail-soft rolled back
  - proposal records now carry strategy versioning metadata (`strategy_version`, `active_strategy_version`, `strategy_history`)
  - non-improving or regressed effect evidence triggers rollback state (`status=rolled_back`) with rollback record and version rollback target

- `knowledge/approve.mjs`
  - provides manual-only local helpers for staged improvement knowledge files
  - `listPendingProposals()` reads pending JSON records from `/Users/seanhan/Documents/Playground/src/knowledge/pending/`
  - `approve(id)` moves one pending file into `/Users/seanhan/Documents/Playground/src/knowledge/approved/` without overwriting an existing approved file
  - `reject(id)` removes one pending file; it does not auto-archive, auto-approve, or attach itself to any runtime automation path

- `single-machine-runtime-coordination.mjs`
  - serializes same-account same-session executive/workflow entrypoints inside one local process
  - keeps start/continue/finalize ownership on one in-process coordination line instead of letting overlapping session turns race each other

- `meeting-agent.mjs`
  - emits structured meeting artifacts and proposal-first knowledge writeback

- `doc-comment-rewrite.mjs`
  - reads a doc, reads comments, builds a patch-oriented rewrite preview, then optionally materializes the approved patch back to the doc

- `openclaw-plugin/lark-kb`
  - maps OpenClaw tool calls into the checked-in plugin hybrid dispatch ingress first
  - every tool call now carries `requested_capability` and `capability_source`; the current checked-in minimal capability set only specializes `knowledge_answer`, `scanoo_diagnose`, `scanoo_compare`, and `scanoo_optimize`, while other plugin-native tools still pass their tool name through that same dispatch envelope
  - `scanoo_diagnose / scanoo_compare / scanoo_optimize` no longer stop at a generic lane-backend label only; the adapter now records an explicit capability-to-lane mapping before execution
  - the checked-in repo now exposes two dedicated minimal Scanoo lanes:
    - `scanoo_compare -> scanoo-compare`
    - `scanoo_diagnose -> scanoo-diagnose`
  - both lanes stay thin on purpose: they preserve distinct routing / trace / execution identity, but still reuse the existing planner answer-edge helper for stable answer/analysis execution
  - `scanoo-compare` now adds one checked-in compare brief immediately before the shared planner answer-edge call so the compare reply is constrained to the fixed section order `【比較對象】 -> 【比較維度】 -> 【核心差異】 -> 【原因假設】 -> 【證據 / 不確定性】 -> 【建議行動】`
  - `scanoo-diagnose` now also adds one checked-in diagnose brief immediately before that same shared planner answer-edge call so the diagnose reply is constrained to the fixed section order `【問題現象】 -> 【可能原因】 -> 【目前證據】 -> 【不確定性】 -> 【建議下一步】`
  - `scanoo-diagnose` now resolves doc ids before deciding whether to keep the plain planner reply: it still checks the current message, bounded `plugin_context.document_refs`, and referenced upstream message first, and when a handoff ref only carries `title` the diagnose-only wrapper now fail-soft searches mirror docs by that title to recover a bounded `document_id`
  - once that diagnose wrapper has a resolved doc id and explicit user auth, it now forces the checked-in official live read helper `readDocumentFromRuntime(...)` unless planner already executed a document-read action, then returns the same deterministic diagnose-shaped five-section reply that cites the official read as evidence while keeping the diagnosis non-conclusive
  - when that same diagnose fallback still lacks an explicit user access token, it no longer drops back to the planner's generic fail copy: if prompt/context already carry hydrated doc refs, bounded evidence, or readable auth context, it returns a weak-but-usable diagnose reply grounded in those signals; otherwise it still returns an explicit-limitation diagnose reply with prompt-backed observations, 2-3 possible causes, and verifiable next steps
  - when that compare-lane reply still lands in an insufficient-evidence state and has not already executed a doc-read action, the same wrapper now re-enters the checked-in mirror read path via `searchCompanyBrainDocsFromRuntime(...)` and returns a deterministic compare-shaped docs-candidate reply instead of over-claiming a conclusion
  - compare synthesis now applies a three-way decision on the docs-candidate evidence: only `>=2` valid evidences with two-sided query-metric coverage can return normal compare; one valid side plus explicit opposite-side gaps returns partial compare; both sides insufficient remains gap-only
  - partial compare output is constrained to include a confirmed-side observation, explicit missing dimensions on the opposite side, one inferred difference-direction hint from known indicators, and one minimal data-backfill next step
  - both dedicated Scanoo lanes now also arm one lane-local pre-timeout hook before the shared planner soft timeout:
    - `scanoo-compare` aborts planner early enough to force one evidence search fallback first; only if that mirror search path also cannot produce a bounded reply does the lane allow `request_timeout` to surface
    - `scanoo-diagnose` aborts planner early enough to force one official-read fallback first; it still resolves doc ids through current message / plugin-context refs / title-search recovery, and only allows `request_timeout` to surface when that live-read recovery path also fails
  - that compare fallback now applies one bounded evidence guard before rendering candidate docs: hits whose `title / doc_id / url / source` look like demo / verify / verification / success fixtures are dropped, and when zero eligible hits remain it still returns the same bounded compare fallback reply instead of forcing a hard compare
  - before that compare fallback mirror read runs, `/Users/seanhan/Documents/Playground/src/lane-executor.mjs` now applies one bounded hard-coded query-shaping step to the original user text: it extracts up to two `*店` compare targets plus any matched metric terms from `流量 / 轉化 / 留存 / 排名`, strips the minimal stopwords `比較 / 一下 / 幫我 / 看看`, and prefers the shaped query form `A店 vs B店 + 指標`; if two store names cannot be recovered, it fail-soft falls back to the stopword-stripped query instead of sending the full user sentence to mirror search
  - both injected briefs remain wrapper-side bounded constraints; they do not change planner ingress or the public `answer -> sources -> limitations` rendering contract
  - only when the dedicated `scanoo-compare` lane is unavailable does the adapter fall back to `knowledge-assistant`, recording `lane_mapping_source=fallback` plus `fallback_reason=missing_exact_scanoo_compare_lane_fallback_to_knowledge_assistant`
  - only when the dedicated `scanoo-diagnose` lane is unavailable does the adapter fall back to `knowledge-assistant`, recording `lane_mapping_source=fallback` plus `fallback_reason=missing_exact_scanoo_diagnose_lane_fallback_to_knowledge_assistant`
  - `scanoo_optimize` still has no dedicated checked-in lane and continues to fall back to `knowledge-assistant`
  - plugin-native document/message/calendar/task-style tools are still forwarded to their existing HTTP routes after dispatch classification

- `lobster_security`
  - separate Python runtime
  - used only through bridge routes and CLI invocation

## Main Runtime Modes

- HTTP-only mode
  - `/Users/seanhan/Documents/Playground/src/http-only.mjs`
  - starts only the HTTP API server

- Full mode
  - `/Users/seanhan/Documents/Playground/src/index.mjs`
  - starts the HTTP server plus a basic Lark long-connection listener

These modes are still part of architecture because they define which application entrypoint is used.
Actual process startup commands and dependency boundaries are documented in [deployment.md](/Users/seanhan/Documents/Playground/docs/system/deployment.md).

## Main Flow

1. User authorizes Lobster with Lark OAuth.
2. HTTP server resolves account and valid user token.
3. Long-connection events or plugin/API callers resolve peer scope.
4. User or plugin calls browse, sync, search, answer, doc-write, or security endpoints.
5. Each HTTP request is tagged with a `trace_id`, echoed back to the caller, and persisted as a compact request-monitor row at response finish.
6. The same request-scoped runtime logger now also persists structured trace events keyed by `trace_id`, including request input, route/planner/lane steps, and terminal failure/success signals.
7. Planner tool executions now also persist normalized `tool_execution` trace events with success/failure and `duration_ms`, so monitoring can be used as a learning signal instead of only a debug surface.
8. The learning loop can summarize that recent monitoring window into routing/tool proposals and persist them for human review before any apply step.
9. For sync/search, content is stored and queried from SQLite FTS plus local semantic embedding.
10. For OpenClaw usage, plugin tools call the same HTTP API.
11. For guarded local actions, HTTP routes forward to the Python `lobster_security` CLI.

## Deployment Shape That Can Be Confirmed

Only the high-level runtime shape is noted here:

- local-first execution
- Node main service
- optional Python sidecar-style local security runtime
- OpenClaw plugin talking to the local HTTP server

Detailed startup paths, runtime dependencies, and external service boundaries live in [deployment.md](/Users/seanhan/Documents/Playground/docs/system/deployment.md).

## Implemented vs Early-Stage

Implemented:

- OAuth and token refresh
- per-call request-layer token validation and refresh for Lark adapters
- Drive / Docx / Wiki browse and organization
- local sync and FTS search
- answer generation
- OpenClaw plugin tool bridge
- message / calendar / task basic operations
- comment-driven doc rewrite preview/apply flow
- capability-lane execution for DM / group / doc / knowledge requests
- watched-comment polling for rewrite suggestion cards
- security wrapper bridge
- evidence-based verification before executive completion
- reflection and improvement proposal generation after important turns
- proposal-first memory path for uncertain knowledge writes

Early-stage or partial:

- semantic classification quality tuning
- unread-message semantics
- higher-level Bitable / Sheet workflows and content extraction
- richer message cards and workflow automation
- comment rewrite safety beyond full replace
- comment suggestion cards still rely on timer/manual polling, not native Lark comment events

## Boundary Summary

- architecture answer:
  - what modules exist
  - who calls whom
  - where the main flows are implemented

- deployment answer:
  - what starts
  - what binaries and credentials are required
  - what depends on Lark, OpenClaw, LLM APIs, local files, and Python

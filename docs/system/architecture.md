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

### Application Layer

- OAuth and account resolution
  - `/Users/seanhan/Documents/Playground/src/lark-user-auth.mjs`
- request handlers and route dispatch
  - `/Users/seanhan/Documents/Playground/src/http-server.mjs`
  - `/Users/seanhan/Documents/Playground/src/http-route-contracts.mjs`
  - `/Users/seanhan/Documents/Playground/src/monitoring-store.mjs`
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

- `monitoring-store.mjs`
  - persists one compact summary row per HTTP request into SQLite
  - persists trace-correlated runtime events into SQLite for request reconstruction
  - supports recent-request, recent-error, trace-reconstruction, and success/error-rate queries for local monitoring routes and CLI

- `agent-learning-loop.mjs`
  - reads recent request-monitor rows plus persisted trace events
  - summarizes routing failure patterns, tool success-rate/latency patterns, and draft routing/tool-weight proposals
  - writes those proposals into the existing improvement workflow only as human-reviewable pending items

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

- `single-machine-runtime-coordination.mjs`
  - serializes same-account same-session executive/workflow entrypoints inside one local process
  - keeps start/continue/finalize ownership on one in-process coordination line instead of letting overlapping session turns race each other

- `meeting-agent.mjs`
  - emits structured meeting artifacts and proposal-first knowledge writeback

- `doc-comment-rewrite.mjs`
  - reads a doc, reads comments, builds a patch-oriented rewrite preview, then optionally materializes the approved patch back to the doc

- `openclaw-plugin/lark-kb`
  - maps OpenClaw tool calls to repo HTTP routes

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

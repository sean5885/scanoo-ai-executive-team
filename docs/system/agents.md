# Agents

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Agent Architecture Status

An AI-enabled system exists here, but it is not a planner/router/specialist team like a multi-agent executive server.

What exists:

- OpenClaw plugin tools
- binding-based capability lanes
- lane-specific execution strategies
- command-style `/meeting` workflow built on top of the lane executor
- OpenClaw-backed semantic classifier
- LLM answer generation
- LLM comment rewrite

What does not exist in current code:

- planner
- router
- specialist agents
- slash-agent registry
- memory orchestration layer
- company_brain

## Current Agent-Like Components

### OpenClaw Plugin Layer

- Name:
  - `lark-kb` plugin
- Role:
  - exposes repo capabilities as OpenClaw tools
- Input:
  - tool parameters
- Output:
  - HTTP-backed result payloads
- Dependencies:
  - `http-server.mjs`
- Called by:
  - OpenClaw runtime
- Calls:
  - local HTTP API

### Binding / Session Runtime

- Name:
  - binding/session runtime
- Code:
  - `/Users/seanhan/Documents/Playground/src/binding-runtime.mjs`
  - `/Users/seanhan/Documents/Playground/src/session-scope-store.mjs`
- Role:
  - convert incoming Lark identity into binding/session/workspace/sandbox scopes
- Input:
  - `chat_id`
  - `open_id`
  - `chat_type`
  - message identifiers
- Output:
  - `agent_binding_key`
  - `capability_lane`
  - `lane_label`
  - `workspace_key`
  - `session_key`
  - `sandbox_key`
- Dependencies:
  - config
  - local JSON state
- Called by:
  - `src/index.mjs`
  - `POST /api/runtime/resolve-scopes`
- Calls:
  - local session scope store

### Capability Lane Resolver

- Name:
  - capability lane resolver
- Code:
  - `/Users/seanhan/Documents/Playground/src/capability-lane.mjs`
- Role:
  - map peer scope plus message intent into one practical assistant lane
- Input:
  - chat type
  - session scope
  - message text heuristics
  - structured Lark message payload fields such as `document_id` and `doc_token`
  - reply-chain follow-up hints when the current message is replying to a shared doc
- Output:
  - `group-shared-assistant`
  - `personal-assistant`
  - `doc-editor`
  - `knowledge-assistant`
- Dependencies:
  - binding runtime
- Called by:
  - `src/binding-runtime.mjs`
  - `src/index.mjs`
- Calls:
  - none

### Capability Lane Executor

- Name:
  - capability lane executor
- Code:
  - `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`
- Role:
  - run one concrete reply strategy after a lane is resolved
  - also intercept `/meeting` as a command workflow before default lane replies
- Input:
  - long-connection event
  - resolved lane scope
- Output:
  - human-readable text reply or card reply payload
- Dependencies:
  - answer service
  - doc suggestion workflow
  - Lark content adapter
  - OAuth account context
  - message intent utilities for document reference extraction
- Called by:
  - `src/index.mjs`
- Calls:
  - lane-specific service functions
  - referenced-message lookups for doc share recovery

### Meeting Command Workflow

- Name:
  - `/meeting`
- Code:
  - `/Users/seanhan/Documents/Playground/src/meeting-agent.mjs`
  - `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`
  - `/Users/seanhan/Documents/Playground/src/http-server.mjs`
- Role:
  - classify meeting content into `weekly` or `general`
  - generate a fixed summary format
  - send summary to a target group
  - attach a confirm-write button via interactive card
  - hold a pending confirmation state
  - write to meeting docs only after confirmation
  - update weekly todo tracker for weekly meetings
- Input:
  - `/meeting` command text
  - referenced doc content
  - HTTP meeting payload
- Output:
  - group-safe summary
  - confirmation id
  - doc write result after confirm
- Dependencies:
  - `lark-content.mjs`
  - `doc-update-confirmations.mjs`
  - SQLite meeting mapping / tracker tables

### Semantic Classifier

- Name:
  - semantic classifier
- Code:
  - `/Users/seanhan/Documents/Playground/src/lark-drive-semantic-classifier.mjs`
- Role:
  - categorize docs for drive organization
- Input:
  - title, path, content summary
- Output:
  - category, confidence, reason
- Dependencies:
  - OpenClaw CLI
- Called by:
  - drive organizer
- Calls:
  - OpenClaw agent session

### Answer Generator

- Name:
  - answer service
- Code:
  - `/Users/seanhan/Documents/Playground/src/answer-service.mjs`
- Role:
  - answer questions from synced knowledge base
- Input:
  - account id, user question
- Output:
  - answer and sources
- Dependencies:
  - SQLite repository
  - optional LLM API
- Called by:
  - `/answer`
- Calls:
  - repository and optional LLM endpoint

### Comment Rewrite Assistant

- Name:
  - doc comment rewrite
- Code:
  - `/Users/seanhan/Documents/Playground/src/doc-comment-rewrite.mjs`
- Role:
  - turn doc comments into revised doc content
- Input:
  - doc id, selected comments, apply flag
- Output:
  - preview or rewritten doc content
- Dependencies:
  - `lark-content.mjs`
  - optional LLM API
- Called by:
  - `/api/doc/rewrite-from-comments`
- Calls:
  - Lark content APIs
  - optional LLM endpoint

### Comment Suggestion Workflow

- Name:
  - comment suggestion workflow
- Code:
  - `/Users/seanhan/Documents/Playground/src/comment-suggestion-workflow.mjs`
  - `/Users/seanhan/Documents/Playground/src/comment-suggestion-poller.mjs`
- Role:
  - detect unseen unresolved comments
  - build rewrite preview cards
  - optionally poll watched documents
- Input:
  - account id
  - document id
  - optional target message id
- Output:
  - rewrite preview card
  - confirmation id
  - optional notification side effect
- Dependencies:
  - Lark content APIs
  - local watch state
  - confirmation store
- Called by:
  - `/api/doc/comments/suggestion-card`
  - `/api/doc/comments/poll-suggestion-cards`
  - `lane-executor.mjs`
- Calls:
  - comment rewrite preview generation
  - Lark reply API

### Security Wrapper

- Name:
  - `lobster_security`
- Role:
  - guard local file/command/network actions
- Input:
  - action envelope
- Output:
  - allow / deny / approval required / rollback diff
- Dependencies:
  - Python subproject
- Called by:
  - secure action HTTP routes
- Calls:
  - internal Python security modules

## Knowledge and Memory

- Knowledge pipeline:
  - yes, SQLite-backed sync and FTS retrieval
- Memory system:
  - no agent memory layer found
- company_brain:
  - not present

## Fallback Behavior

- answer path:
  - extractive fallback when no LLM key exists

- semantic classifier:
  - local rules now exist as fallback when OpenClaw is unavailable

- comment rewrite:
  - no rewrite without LLM key

## Maturity

- tool layer: implemented
- semantic classification: implemented, quality-sensitive
- planner/router/specialist collaboration: not implemented in this repo

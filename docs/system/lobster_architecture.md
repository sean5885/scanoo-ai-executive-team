# Lobster Architecture

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Important Boundary

This repository uses the name Lobster and integrates with OpenClaw, but it is not the same architecture as the Python `ai-server` executive team repo.

Current real structure here is:

- Lark OAuth + browse/write service
- local sync + retrieval
- OpenClaw plugin tool surface
- optional long-connection reply bot
- binding/session/workspace runtime scoping
- security wrapper bridge

## Planner as Decision Center

- Not present in this repo.
- There is no planner module.

## Router Behavior

- Not present as a specialist router.
- The HTTP server routes requests by URL path only.

## Specialist Division

- Not present.
- The closest analog is capability grouping:
  - browse/write
  - sync/search/answer
  - organization
  - secure local action

## Heuristic vs AI Fallback

What exists:

- heuristic retrieval:
  - SQLite FTS and substring fallback

- AI paths:
  - answer generation via optional LLM
  - semantic classification via OpenClaw
  - comment rewrite via optional LLM

What does not exist:

- planner-level heuristic routing
- AI fallback for agent dispatch

## Collaboration Model

- OpenClaw plugin calls local HTTP API
- HTTP API calls Lark SDK or local repository
- organization flow may call semantic classifier
- secure local task flow calls Python wrapper

This is integration-oriented collaboration, not specialist-agent collaboration.

## Binding / Session / Workspace

Implemented foundation:

- shared workspace
- per-peer session
- per-peer sandbox key
- binding resolution from Lark event identity
- lane-specific execution after scope resolution

Detailed spec:

- [/Users/seanhan/Documents/Playground/docs/system/binding_session_workspace.md](/Users/seanhan/Documents/Playground/docs/system/binding_session_workspace.md)

## Implemented Capabilities

- Drive / Wiki / Doc browse and write
- Sync into local SQLite
- Search and answer
- Chat / calendar / task operations
- comment-driven doc rewrite
- comment suggestion cards with timer/manual polling
- secure local action wrapper

## Early-Stage or Partial

- richer Lark assistant workflows
- unread-message semantics
- Bitable and Sheet manipulation
- stronger comment rewrite safety
- hosted deployment story

## Agent Learning Status

- no agent learning pipeline found
- no specialist knowledge distillation found
- no company-brain-like canonical knowledge layer found

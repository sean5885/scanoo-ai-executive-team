# Repository Agent Rules

This repository contains an AI-enabled Lark system, but it is not a full planner-specialist executive stack. The current AI surfaces are:

- OpenClaw plugin tools in `/Users/seanhan/Documents/Playground/openclaw-plugin`
- OpenClaw-backed semantic classification in `/Users/seanhan/Documents/Playground/src/lark-drive-semantic-classifier.mjs`
- LLM-assisted answer generation and document-comment rewrite in `/Users/seanhan/Documents/Playground/src/answer-service.mjs` and `/Users/seanhan/Documents/Playground/src/doc-comment-rewrite.mjs`

## Technical Mirror

- `/Users/seanhan/Documents/Playground/docs/system` is the single technical mirror for this repo.
- Before changing code, read the relevant files in `/Users/seanhan/Documents/Playground/docs/system`.
- After any architecture, module, API, data-flow, plugin, or infra change, update `/Users/seanhan/Documents/Playground/docs/system` in the same change.

## Source of Truth

- Do not assume architecture from old chat context.
- Infer behavior from code, config, scripts, and checked-in docs.
- If docs and code disagree, treat code as current truth and record the conflict in `/Users/seanhan/Documents/Playground/docs/system/open_questions.md`.
- If architecture cannot be confirmed from code, say so explicitly and log it in `open_questions.md`.

## High-Risk Change Areas

Be especially careful when modifying:

- OAuth and token persistence
- Lark scopes, endpoints, and write operations
- SQLite schema, FTS indexing, and sync logic
- OpenClaw plugin tool names and payload contracts
- Comment-driven document rewrite
- `lobster_security` approval, audit, and rollback behavior

## Documentation Discipline

- Documentation must not lag behind the codebase for long periods.
- Any routing, agent, planner, or specialist claim must be supported by code.
- This repo does not currently have a true planner/router/specialist agent team; do not describe it as one unless code is added.

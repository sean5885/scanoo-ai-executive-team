# System State Snapshot

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This file is the current checked-in baseline snapshot for the latest agent-system stabilization round.

It records only behavior that can already be grounded in the checked-in code and the technical mirror.

## Baseline Coverage

This snapshot covers the following thread110 commits:

- `67a0bd6` `fix(dispatcher): render natural language fallback errors`
- `28ba87b` `fix(orchestrator): render natural language executive fallback errors`
- `7c037a5` `fix(dispatcher): guard registered agent success output boundary`
- `cbf29d0` `fix(orchestrator): reject json-like specialist and merge replies`
- `b452d7c` `fix(knowledge): clean and stabilize snippet extraction`
- `88b9d1e` `fix(knowledge): improve bd retrieval ranking`
- `cee5659` `fix(knowledge): suppress generic business alias in bd queries`

## This Round Solved

- chat-facing fallback paths in `/Users/seanhan/Documents/Playground/src/agent-dispatcher.mjs` and `/Users/seanhan/Documents/Playground/src/executive-orchestrator.mjs` no longer expose raw `{ ok, error, details }` JSON to users; they now pass through the shared natural-language reply boundary while preserving machine-readable error state in runtime data
- registered-agent success output now has an explicit boundary guard in `/Users/seanhan/Documents/Playground/src/agent-dispatcher.mjs`, intercepting JSON-like object/fenced/nested payloads before they leak directly into chat
- executive specialist and merge replies now reject JSON-like structured envelopes in `/Users/seanhan/Documents/Playground/src/executive-orchestrator.mjs`, preventing structured blobs from being treated as valid brief text and keeping fail-soft synthesis on the existing generalist path
- local `docs/system` retrieval preview quality improved in `/Users/seanhan/Documents/Playground/src/knowledge/knowledge-service.mjs` and `/Users/seanhan/Documents/Playground/src/knowledge/snippet-cleaner.mjs` through block-first snippet extraction, stronger line cleanup, and low-value fragment rejection
- BD-oriented local retrieval ranking in `/Users/seanhan/Documents/Playground/src/knowledge/rank-results.mjs` now boosts BD-flow evidence and soft-penalizes generic inventory docs so BD snippets surface ahead of broad system overviews
- explicit BD / 商機 queries in `/Users/seanhan/Documents/Playground/src/knowledge/knowledge-service.mjs` now suppress generic `business` alias expansion unless the user actually typed `business`, reducing alias leakage into unrelated results

## Modules Touched

- `/Users/seanhan/Documents/Playground/src/agent-dispatcher.mjs`
- `/Users/seanhan/Documents/Playground/src/executive-orchestrator.mjs`
- `/Users/seanhan/Documents/Playground/src/knowledge/knowledge-service.mjs`
- `/Users/seanhan/Documents/Playground/src/knowledge/snippet-cleaner.mjs`
- `/Users/seanhan/Documents/Playground/src/knowledge/rank-results.mjs`
- technical mirror updates in:
  - `/Users/seanhan/Documents/Playground/docs/system/summary.md`
  - `/Users/seanhan/Documents/Playground/docs/system/modules.md`
  - `/Users/seanhan/Documents/Playground/docs/system/knowledge_pipeline.md`
  - `/Users/seanhan/Documents/Playground/docs/system/planner_agent_alignment.md`
  - `/Users/seanhan/Documents/Playground/docs/system/agents.md`
  - `/Users/seanhan/Documents/Playground/docs/system/repo_thread_inventory.md`

## Known Boundaries And Limits

- the new output-boundary hardening changes visible chat rendering only; machine-readable `error`, `details`, and `context` are still preserved for runtime/log/programmatic use when present
- executive orchestration is still sequential and bounded to the current checked-in registered agents; this round does not add parallel specialist execution, a worker mesh, or a new handoff runtime
- the local knowledge helpers still read only from checked-in `docs/system`; they are not wired into SQLite retrieval, company-brain approval governance, or a tenant-wide canonical knowledge layer
- BD retrieval ranking is still a checked-in heuristic with deterministic boosts/penalties, not a learned ranker or semantic approval pipeline

## Next Suggested Focus

- keep this round as the rollback/reference baseline for future dispatcher/orchestrator output-boundary work
- add or refresh deterministic eval fixtures when adjusting registered-agent boundary rules or local knowledge query expansion again
- if a later round revisits retrieval quality, prefer tightening local query normalization and fixture coverage before expanding the read-side utility into broader company-brain/runtime claims

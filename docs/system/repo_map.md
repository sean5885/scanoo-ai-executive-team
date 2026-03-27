# Repo Map

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Key Directories

- `/Users/seanhan/Documents/Playground/src`
  - Main Node service code.
  - Contains OAuth, HTTP API, sync, indexing, Lark content operations, search/answer, organization flows, semantic classification, security bridge, and small local knowledge helpers.

- `/Users/seanhan/Documents/Playground/src/knowledge`
  - Local knowledge helper directory.
  - Currently contains only local in-memory doc helpers and a cached local query helper; these are not wired into the main runtime, retrieval index, or company-brain approval path.

- `/Users/seanhan/Documents/Playground/openclaw-plugin/lark-kb`
  - OpenClaw plugin package.
  - Exposes repo HTTP routes as OpenClaw tools.

- `/Users/seanhan/Documents/Playground/lobster_security`
  - Separate Python subproject.
  - Security wrapper with approval, command policy, network guard, audit, snapshot, and rollback.

- `/Users/seanhan/Documents/Playground/config`
  - Repo-local config directory.
  - Current root config usage is limited; most runtime config is environment-based.

- `/Users/seanhan/Documents/Playground/scripts`
  - Small utility scripts.
  - Includes workflow baseline, monitoring, trace debug, routing eval entrypoints, local retrieval eval runners, a manual real-user prompt smoke loop, and a small manual review logger.

- `/Users/seanhan/Documents/Playground/evals`
  - Checked-in deterministic eval fixtures.
  - Currently stores the routing regression baseline set, a small real-world retrieval query set, workflow smoke fixture sets, and a small manual real-user prompt set.

- `/Users/seanhan/Documents/Playground/.data`
  - Local runtime data.
  - Includes SQLite RAG database and lobster-security approval state.

- `/Users/seanhan/Documents/Playground/docs/system`
  - System technical mirror.
  - Must stay aligned with code.

## Core Module Areas

- HTTP API and OAuth
  - `/Users/seanhan/Documents/Playground/src/http-server.mjs`
  - `/Users/seanhan/Documents/Playground/src/lark-user-auth.mjs`

- Lark content operations
  - `/Users/seanhan/Documents/Playground/src/lark-content.mjs`
  - `/Users/seanhan/Documents/Playground/src/lark-connectors.mjs`

- Sync and indexing
  - `/Users/seanhan/Documents/Playground/src/lark-sync-service.mjs`
  - `/Users/seanhan/Documents/Playground/src/chunking.mjs`
  - `/Users/seanhan/Documents/Playground/src/db.mjs`
  - `/Users/seanhan/Documents/Playground/src/rag-repository.mjs`

- Search and answer
  - `/Users/seanhan/Documents/Playground/src/answer-service.mjs`
  - `/Users/seanhan/Documents/Playground/src/read-runtime.mjs`
  - `/Users/seanhan/Documents/Playground/src/index-read-authority.mjs`

- Routing eval baseline
  - `/Users/seanhan/Documents/Playground/src/routing-eval.mjs`
  - `/Users/seanhan/Documents/Playground/src/routing-eval-diagnostics.mjs`
  - `/Users/seanhan/Documents/Playground/src/routing-diagnostics-history.mjs`
  - `/Users/seanhan/Documents/Playground/src/routing-eval-fixture-candidates.mjs`
  - `/Users/seanhan/Documents/Playground/evals/routing-eval-set.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/routing-eval.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/routing-eval-fixture-candidates.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/routing-eval-closed-loop.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/routing-diagnostics.mjs`

- Local retrieval eval helpers
  - `/Users/seanhan/Documents/Playground/evals/retrieval-realworld-set.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/retrieval-eval.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/retrieval-realworld-eval.mjs`

- Manual real-user prompt smoke loop
  - `/Users/seanhan/Documents/Playground/evals/real-user-tasks.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/real-user-loop.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/real-user-review-log.mjs`

- Document workflow eval helpers
  - `/Users/seanhan/Documents/Playground/evals/doc-workflow-set.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/doc-workflow-eval.mjs`

- Meeting workflow eval helpers
  - `/Users/seanhan/Documents/Playground/evals/meeting-workflow-set.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/meeting-workflow-eval.mjs`

- Planner diagnostics governance
  - `/Users/seanhan/Documents/Playground/src/planner-contract-consistency.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner-diagnostics-history.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/planner-contract-check.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/planner-diagnostics.mjs`

- Document organization
  - `/Users/seanhan/Documents/Playground/src/lark-drive-organizer.mjs`
  - `/Users/seanhan/Documents/Playground/src/lark-wiki-organizer.mjs`
  - `/Users/seanhan/Documents/Playground/src/lark-drive-semantic-classifier.mjs`

- Comment-driven doc rewrite
  - `/Users/seanhan/Documents/Playground/src/doc-comment-rewrite.mjs`

- Mutation governance
  - `/Users/seanhan/Documents/Playground/src/mutation-admission.mjs`
  - `/Users/seanhan/Documents/Playground/src/mutation-runtime.mjs`
  - `mutation-admission.mjs` is the current checked-in admission adapter path for the Phase 1 routes.
  - `mutation-runtime.mjs` is currently only a narrow execution-mode scaffold used by the `create_doc` HTTP execute path; it returns `missing_execute` when no executor is provided, derives `meta.execution_mode` from `context.execution_mode` with a default of `passthrough`, records `meta.duration_ms` around the downstream executor call, and now includes a small `meta.journal` with `action / status / started_at` plus `error` on failure. Execution-failure fail-soft results also support an optional `context.rollback` hook and expose its outcome via `journal.rollback.status` (`success`, `failed`, or `pending` when no rollback hook is supplied). For `execution_mode="controlled"` it still forwards the same request with an extra `controlled: true` marker into the downstream executor. The `create_doc` route still unwraps the nested write result before sending the HTTP response, so it does not yet replace route-local guards, verifiers, admission, or execute logic.

- Local knowledge helpers
  - `/Users/seanhan/Documents/Playground/src/knowledge/doc-index.mjs`
  - `/Users/seanhan/Documents/Playground/src/knowledge/doc-loader.mjs`
  - `/Users/seanhan/Documents/Playground/src/knowledge/rank-results.mjs`
  - `/Users/seanhan/Documents/Playground/src/knowledge/knowledge-service.mjs`

- Local company-brain memory helper
  - `/Users/seanhan/Documents/Playground/src/company-brain-memory-authority.mjs`
  - Process-local `Map`-backed read/write/prefix-list helper for experimental company-brain memory entries.
  - Not wired into `read-runtime.mjs`, `mutation-runtime.mjs`, SQLite persistence, planner routing, or company-brain approval/governance paths.
  - `/Users/seanhan/Documents/Playground/src/memory-write-guard.mjs`
  - Small wrapper that normalizes process-local memory writes before delegating to `company-brain-memory-authority.mjs`.
  - Also not wired into `read-runtime.mjs`, `mutation-runtime.mjs`, SQLite persistence, planner routing, or company-brain approval/governance paths.
  - Current local helper callers also include `/Users/seanhan/Documents/Playground/src/session-scope-store.mjs` and `/Users/seanhan/Documents/Playground/src/executive-memory.mjs` as process-local authority-first writes plus read-through caches over their existing file-backed stores.

- OpenClaw tool layer
  - `/Users/seanhan/Documents/Playground/openclaw-plugin/lark-kb/index.ts`

- Secure local action wrapper
  - `/Users/seanhan/Documents/Playground/src/lobster-security-bridge.mjs`
  - `/Users/seanhan/Documents/Playground/lobster_security`

## Suspected Historical or Non-Core Areas

- `/Users/seanhan/Documents/Playground/.tmp/scanoo-web`
  - Extracted workspace artifact, not part of core runtime.

- `/Users/seanhan/Documents/Playground/scanoo_web_backend_function_map.md`
- `/Users/seanhan/Documents/Playground/scanoo_web_iteration_planning.md`
- `/Users/seanhan/Documents/Playground/SKILLS_RISK_GUIDE.md`
  - Project-adjacent analysis docs, not runtime modules.

- `/Users/seanhan/Documents/Playground/config`
  - Exists, but current Node runtime appears to rely mostly on environment variables instead of rich config files.

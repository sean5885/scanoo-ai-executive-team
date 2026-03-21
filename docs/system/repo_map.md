# Repo Map

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Key Directories

- `/Users/seanhan/Documents/Playground/src`
  - Main Node service code.
  - Contains OAuth, HTTP API, sync, indexing, Lark content operations, search/answer, organization flows, semantic classification, and security bridge.

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
  - Includes workflow baseline, monitoring, trace debug, and routing eval entrypoints.

- `/Users/seanhan/Documents/Playground/evals`
  - Checked-in deterministic eval fixtures.
  - Currently stores the routing regression baseline set.

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

- Routing eval baseline
  - `/Users/seanhan/Documents/Playground/src/routing-eval.mjs`
  - `/Users/seanhan/Documents/Playground/src/routing-eval-diagnostics.mjs`
  - `/Users/seanhan/Documents/Playground/src/routing-diagnostics-history.mjs`
  - `/Users/seanhan/Documents/Playground/src/routing-eval-fixture-candidates.mjs`
  - `/Users/seanhan/Documents/Playground/evals/routing-eval-set.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/routing-eval.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/routing-eval-fixture-candidates.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/routing-eval-closed-loop.mjs`

- Document organization
  - `/Users/seanhan/Documents/Playground/src/lark-drive-organizer.mjs`
  - `/Users/seanhan/Documents/Playground/src/lark-wiki-organizer.mjs`
  - `/Users/seanhan/Documents/Playground/src/lark-drive-semantic-classifier.mjs`

- Comment-driven doc rewrite
  - `/Users/seanhan/Documents/Playground/src/doc-comment-rewrite.mjs`

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

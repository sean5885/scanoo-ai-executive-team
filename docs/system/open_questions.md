# Open Questions

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

This file only keeps unresolved, code-backed gaps.

Resolved documentation drift and frozen-baseline clarifications were removed from this list.

## High

1. Dual-responder risk still exists if another local responder is started after Playground.
   - Why it matters:
     - reply ownership and trace correlation can drift across processes
   - Current code evidence:
     - `/Users/seanhan/Documents/Playground/src/runtime-conflict-guard.mjs`
   - Remaining gap:
     - the guard only runs when Playground starts; it cannot prevent later manual re-enable

2. `http-server.mjs` is still the dominant integration file.
   - Why it matters:
     - route behavior is implemented and tested, but comprehension cost remains high
   - Current code evidence:
     - `/Users/seanhan/Documents/Playground/src/http-server.mjs`
     - `/Users/seanhan/Documents/Playground/src/http-route-contracts.mjs`

3. Targeted doc update exists at preview/planning level, but final doc mutation is still replace-oriented in the current write adapter.
   - Why it matters:
     - contributors must not describe the current doc write runtime as block-level mutation
   - Current code evidence:
     - `/Users/seanhan/Documents/Playground/src/doc-targeting.mjs`
     - `/Users/seanhan/Documents/Playground/src/doc-comment-rewrite.mjs`
     - `/Users/seanhan/Documents/Playground/src/lark-content.mjs`

4. OAuth scope truth is still partly external to the repo.
   - Why it matters:
     - the repo documents scope families, but tenant-console grants remain outside version control
   - Current code evidence:
     - `/Users/seanhan/Documents/Playground/src/config.mjs`
     - `/Users/seanhan/Documents/Playground/.env.example`

5. Token and account persistence remain local-first.
   - Why it matters:
     - encryption and permissions improved, but this is still not a managed secret store
   - Current code evidence:
     - `/Users/seanhan/Documents/Playground/src/db.mjs`
     - `/Users/seanhan/Documents/Playground/src/secret-crypto.mjs`

6. Sandbox/live tenant isolation still depends on deployed environment variables, not a checked-in canonical tenant mapping.
   - Why it matters:
     - the code is fail-closed, but the intended tenant boundary is not provable from the repo alone
   - Current code evidence:
     - `/Users/seanhan/Documents/Playground/src/lark-write-guard.mjs`

## Medium

7. Retrieval uses local semantic-lite embeddings, not an external vector store.
   - Current code evidence:
     - `/Users/seanhan/Documents/Playground/src/rag-repository.mjs`
     - `/Users/seanhan/Documents/Playground/src/semantic-embeddings.mjs`

8. `lobster_security` remains a separate architecture boundary.
   - Why it matters:
     - contract drift can still happen between the Node bridge and the Python runtime
   - Current code evidence:
     - `/Users/seanhan/Documents/Playground/src/lobster-security-bridge.mjs`
     - `/Users/seanhan/Documents/Playground/lobster_security`

9. Semantic organization has a local fallback, but quality parity with OpenClaw-backed classification is not guaranteed.
   - Current code evidence:
     - `/Users/seanhan/Documents/Playground/src/lark-drive-semantic-classifier.mjs`

10. Bitable and spreadsheet write primitives are implemented, but higher-level product workflow contracts remain thin.
   - Current code evidence:
     - `/Users/seanhan/Documents/Playground/src/http-server.mjs`
     - `/Users/seanhan/Documents/Playground/src/external-mutation-registry.mjs`

11. The repo has a checked-in executive orchestration layer and a bounded company-brain slice, but not background workers, parallel subagent execution, or a tenant-wide memory graph.
   - Why it matters:
     - future docs must keep describing the current scope accurately

12. Comment suggestion cards support manual/timer polling only; there is still no native Lark comment event entering this repo.
   - Current code evidence:
     - `/Users/seanhan/Documents/Playground/src/comment-suggestion-poller.mjs`
     - `/Users/seanhan/Documents/Playground/src/comment-suggestion-workflow.mjs`

13. Workflow checkpoints and planner lifecycle stores are still local JSON state, not a shared multi-runtime store.
   - Current code evidence:
     - `/Users/seanhan/Documents/Playground/src/agent-workflow-state.mjs`
     - `/Users/seanhan/Documents/Playground/src/planner-task-lifecycle-v1.mjs`

14. `/meeting` is implemented, but it remains a specialized workflow rather than a generic planner-managed subtask framework.
   - Current code evidence:
     - `/Users/seanhan/Documents/Playground/src/meeting-agent.mjs`
     - `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`

15. Planner-side runtime-info support exists, but top-level lane routing still does not guarantee every generic runtime question reaches planner mode.
   - Current code evidence:
     - `/Users/seanhan/Documents/Playground/src/capability-lane.mjs`
     - `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`
     - `/Users/seanhan/Documents/Playground/src/planner-runtime-info-flow.mjs`

16. Company-brain conflict evidence is still narrow; current overlap checks are mostly title/doc-match based, not semantic conflict resolution.
   - Why it matters:
     - contributors must not describe the current company-brain conflict path as a rich resolver or approval workflow
   - Current code evidence:
     - `/Users/seanhan/Documents/Playground/src/company-brain-write-intake.mjs`
     - `/Users/seanhan/Documents/Playground/src/company-brain-review.mjs`

17. Runtime-local mutation idempotency and persisted HTTP idempotency still use different scopes.
   - Why it matters:
     - contributors should not assume there is only one idempotency layer
   - Current code evidence:
     - `/Users/seanhan/Documents/Playground/src/mutation-runtime.mjs`
     - `/Users/seanhan/Documents/Playground/src/http-idempotency-store.mjs`

## Cannot Be Confirmed From Code Alone

- whether any hosted deployment exists outside the local machine
- whether OpenClaw is always available in production usage
- the exact Lark app permissions currently granted in tenant console

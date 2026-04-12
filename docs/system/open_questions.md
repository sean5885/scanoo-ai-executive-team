# Open Questions

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

This file keeps only unresolved, code-backed gaps that still deserve closure work.

For this closure-planning pass:

- duplicate items were merged into one thread when they describe the same boundary
- deployment-only unknowns were moved out of the ranked list
- roadmap-style expansion items were removed from the closure set

## Disposition Of Previous Items

1. Dual-responder risk: single-process same-session coordination is now closed in checked-in code; startup-time competing-responder suppression still exists, but it is no longer an active-task ownership gap.
2. `http-server.mjs` dominance: the planner ingress / answer-edge part is now resolved through `/Users/seanhan/Documents/Playground/src/planner-user-input-edge.mjs`; the file remains large, but it is no longer an unresolved planner-ingress ownership gap.
3. Targeted preview vs replace-based final doc apply: resolved for workflow closure tracking; replace-based apply remains documented truth, but preview/review/apply ownership is now single-path.
4. OAuth scope truth partly external: removed from the ranked list; this is deployment truth, not a repo-closable code gap.
5. Token/account persistence local-first: still real, but no longer grouped with the now-closed same-session orchestration path.
6. Sandbox/live tenant mapping lives in deployed env: removed from the ranked list; this is fail-closed in code but not provable from the repo alone.
7. `lobster_security` separate boundary: still real, but cut from the next-three closure order.
8. Semantic fallback quality parity: removed from the closure list; there is no checked-in parity contract to close against yet.
9. Bitable/spreadsheet workflow contracts remain thin: removed from the closure list; this is feature-surface expansion, not closure of a current contract gap.
10. Comment suggestion ingress is polling/manual only: no longer a workflow-closure gap; ingress is still poll/manual, but it now lands on the same checked-in preview/review/apply path.
11. Workflow/planner state is local JSON: same-session orchestration is now serialized in-process for the checked-in executive/workflow path, but other local JSON stores still remain local-first facts.
12. Generic runtime questions do not reliably enter planner mode from the lane layer: resolved through `/Users/seanhan/Documents/Playground/src/planner-ingress-contract.mjs`, which is now shared by lane admission, personal-lane edge guarding, and `/Users/seanhan/Documents/Playground/src/planner-runtime-info-flow.mjs`.
13. HTTP and mutation-runtime idempotency use different scopes: still real, but cut from the next-three closure order.
14. Planner helper doc/code drift (`tool-loop` single-step wording) was observed and resolved on 2026-04-09 by aligning `/Users/seanhan/Documents/Playground/docs/system/modules.md` and `/Users/seanhan/Documents/Playground/docs/system/data_flow.md` to checked-in `next_action` multi-step behavior plus `/Users/seanhan/Documents/Playground/src/planner/execution-pipeline.mjs`.

## Ranked Closure Threads

No ranked closure thread remains from this pass.

Thread C is now closed in checked-in code:

- `/Users/seanhan/Documents/Playground/src/planner-ingress-contract.mjs` is the shared planner ingress rule for document-summary / company-brain / knowledge / runtime-info reads
- `/Users/seanhan/Documents/Playground/src/planner-user-input-edge.mjs` is the shared `/answer` and `knowledge-assistant` answer edge
- `/Users/seanhan/Documents/Playground/src/planner-runtime-info-flow.mjs` now reuses the same runtime-info predicate as lane admission
- `/Users/seanhan/Documents/Playground/src/lane-executor.mjs` now uses that same ingress contract to keep personal-lane planner mismatches fail-soft and explicit

## Real But Outside The Next-Three Cut

- token/account persistence remains local-first.
  - Evidence:
    - `/Users/seanhan/Documents/Playground/src/db.mjs`
    - `/Users/seanhan/Documents/Playground/src/secret-crypto.mjs`
- some local JSON stores still remain process-local persistence rather than a broader shared runtime substrate.
  - Evidence:
    - `/Users/seanhan/Documents/Playground/src/agent-workflow-state.mjs`
    - `/Users/seanhan/Documents/Playground/src/planner-task-lifecycle-v1.mjs`
- `lobster_security` remains a separate Node-to-Python runtime boundary.
  - Evidence:
    - `/Users/seanhan/Documents/Playground/src/lobster-security-bridge.mjs`
    - `/Users/seanhan/Documents/Playground/lobster_security`
- HTTP idempotency and mutation-runtime idempotency still use different scopes.
  - Evidence:
    - `/Users/seanhan/Documents/Playground/src/mutation-runtime.mjs`
    - `/Users/seanhan/Documents/Playground/src/http-idempotency-store.mjs`
- legacy docs still reference pre-refactor persona/knowledge slash inventory even though runtime registry is now core-only (`/generalist`, `/planner`, `/company-brain`).
  - Evidence:
    - `/Users/seanhan/Documents/Playground/docs/system/Lobster AI Executive System Audit Report v1.md`
    - `/Users/seanhan/Documents/Playground/docs/system/usage_layer_eval_schema.md`

## Minimal Closure Order

No remaining ranked closure order is defined in this file after Thread C.

## Cannot Be Confirmed From Code Alone

- whether any hosted deployment exists outside the local machine
- whether OpenClaw is always available in production usage
- the exact Lark app permissions currently granted in tenant console
- the exact sandbox/live tenant allowlists and folder mapping currently active in deployed environment variables

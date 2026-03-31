# Open Questions

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

This file keeps only unresolved, code-backed gaps that still deserve closure work.

For this closure-planning pass:

- duplicate items were merged into one thread when they describe the same boundary
- deployment-only unknowns were moved out of the ranked list
- roadmap-style expansion items were removed from the closure set

## Disposition Of Previous Items

1. Dual-responder risk: still real; merged into `Thread B` because it is another single-machine coordination gap.
2. `http-server.mjs` dominance: still real; merged into `Thread C`.
3. Targeted preview vs replace-based final doc apply: resolved for workflow closure tracking; replace-based apply remains documented truth, but preview/review/apply ownership is now single-path.
4. OAuth scope truth partly external: removed from the ranked list; this is deployment truth, not a repo-closable code gap.
5. Token/account persistence local-first: still real; merged into `Thread B`.
6. Sandbox/live tenant mapping lives in deployed env: removed from the ranked list; this is fail-closed in code but not provable from the repo alone.
7. `lobster_security` separate boundary: still real, but cut from the next-three closure order.
8. Semantic fallback quality parity: removed from the closure list; there is no checked-in parity contract to close against yet.
9. Bitable/spreadsheet workflow contracts remain thin: removed from the closure list; this is feature-surface expansion, not closure of a current contract gap.
10. Comment suggestion ingress is polling/manual only: no longer a workflow-closure gap; ingress is still poll/manual, but it now lands on the same checked-in preview/review/apply path.
11. Workflow/planner state is local JSON: still real; merged into `Thread B`.
12. Generic runtime questions do not reliably enter planner mode from the lane layer: still real; merged into `Thread C`.
13. HTTP and mutation-runtime idempotency use different scopes: still real, but cut from the next-three closure order.

## Ranked Closure Threads

### P0

1. `Thread B — single-machine runtime coordination closure`
   - Why it stays:
     - responder conflict prevention only runs at startup
     - token/account state remains local-first
     - workflow and planner lifecycle state still live in local JSON stores
   - Current code evidence:
     - `/Users/seanhan/Documents/Playground/src/runtime-conflict-guard.mjs`
     - `/Users/seanhan/Documents/Playground/src/db.mjs`
     - `/Users/seanhan/Documents/Playground/src/secret-crypto.mjs`
     - `/Users/seanhan/Documents/Playground/src/agent-workflow-state.mjs`
     - `/Users/seanhan/Documents/Playground/src/planner-task-lifecycle-v1.mjs`
   - Closure target:
     - reduce the number of places where correctness still depends on one local machine staying the only writer/runtime

### P1

2. `Thread C — planner ingress and edge-surface convergence`
   - Why it stays:
     - `http-server.mjs` remains a 9k+ line integration surface
     - the lane layer still does not reliably send generic runtime-health questions into planner/runtime-info flow
   - Current code evidence:
     - `/Users/seanhan/Documents/Playground/src/http-server.mjs`
     - `/Users/seanhan/Documents/Playground/src/http-route-contracts.mjs`
     - `/Users/seanhan/Documents/Playground/src/capability-lane.mjs`
     - `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`
     - `/Users/seanhan/Documents/Playground/src/planner-runtime-info-flow.mjs`
   - Closure target:
     - make planner entry conditions and edge-route ownership explicit enough that runtime-info and adjacent planner reads do not depend on lane heuristics plus one dominant integration file

## Real But Outside The Next-Three Cut

- `lobster_security` remains a separate Node-to-Python runtime boundary.
  - Evidence:
    - `/Users/seanhan/Documents/Playground/src/lobster-security-bridge.mjs`
    - `/Users/seanhan/Documents/Playground/lobster_security`
- HTTP idempotency and mutation-runtime idempotency still use different scopes.
  - Evidence:
    - `/Users/seanhan/Documents/Playground/src/mutation-runtime.mjs`
    - `/Users/seanhan/Documents/Playground/src/http-idempotency-store.mjs`

## Minimal Closure Order

1. Start with `Thread B`.
   - It groups the remaining single-machine assumptions into one closure pass instead of treating responder guard, token persistence, and planner/workflow state as separate threads.

2. Then do `Thread C`.
   - It is worth doing after the first two boundaries are clear, because route extraction and planner-ingress cleanup are safer once doc-write and state boundaries are no longer ambiguous.

## Cannot Be Confirmed From Code Alone

- whether any hosted deployment exists outside the local machine
- whether OpenClaw is always available in production usage
- the exact Lark app permissions currently granted in tenant console
- the exact sandbox/live tenant allowlists and folder mapping currently active in deployed environment variables

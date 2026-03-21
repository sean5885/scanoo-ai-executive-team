# Release Baseline v1.0.0

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

Prepared on 2026-03-21.

## Release Identity

- release tag: `v1.0.0`
- release posture: production baseline
- freeze state: active
- release demo runner: `/Users/seanhan/Documents/Playground/scripts/demo-release-v1.mjs`
- readiness source: [system_readiness_checklist.md](/Users/seanhan/Documents/Playground/docs/system/system_readiness_checklist.md)

## Production Baseline Policy

This release line freezes the currently validated planner/runtime behavior.

After `v1.0.0`:

- do not change planner, company-brain, OAuth, learning, or logging core logic in place
- do not change public route contracts in place
- do not change workflow success/failure semantics in place
- any further logic change must cut a new versioned baseline

Allowed during freeze:

- release notes
- demo materials
- operator runbooks
- non-behavioral documentation

## Frozen Scope

Core logic is frozen for these areas:

- planner routing, execution, verification, reflection, and improvement workflow
- company-brain read-side list/search/detail and approval-gated write-adjacent boundaries
- SQLite-backed OAuth persistence and request-layer refresh
- learning ingest/search/detail sidecar behavior
- request logging, route logging, `trace_id`, and `request_id` propagation
- workflow baseline and self-check surfaces used for regression gating

## Core Capabilities

The `v1.0.0` baseline is intended to demonstrate and publish these repo-grounded capabilities:

- planner-gated knowledge/document flows with explicit verification boundaries
- company-brain read-side search, detail, and simplified learning-state retrieval
- OAuth callback persistence plus automatic request-layer refresh from SQLite-backed token state
- meeting capture, confirmation, and controlled writeback workflow
- high-risk route trace/log coverage across drive, wiki, bitable, calendar, tasks, and meeting/doc flows
- closed-loop reflection and improvement proposal workflow with approval/apply state

## Baseline Verification Commands

Minimum baseline verification:

```bash
npm test
node scripts/self-check.mjs
node scripts/run-workflow-baseline.mjs smoke
node scripts/run-workflow-baseline.mjs integration
```

Recommended release-demo verification:

```bash
node scripts/demo-release-v1.mjs quick
```

The demo runner now prints each executed command with a stable operator-facing structure:

- `Step`: the current verification/demo stage name
- `Command`: the exact child command being executed
- `Result`: `PASS` or `FAIL` with elapsed time
- `Summary`: compact step-specific highlights
  - self-check: system/agent/route/service counts
  - Node test runs: tests/pass/fail/duration
- `Error`: only on failure, with explicit exit code and the most relevant output tail

This output change is presentation-only. It does not change release verification commands, test coverage, or the underlying success/failure semantics of the frozen `v1.0.0` baseline.

Optional live tenant validation:

```bash
node scripts/check-auth.mjs
```

Notes:

- `npm test` is the release gate for the checked-in code baseline
- `check-auth.mjs` only validates app credentials and tenant-token issuance, not every user OAuth path
- real post-restart live OAuth/Lark smoke validation remains an operator step outside repo-only evidence

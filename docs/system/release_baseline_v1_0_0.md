# Release Baseline v1.0.0

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

Prepared on 2026-03-21.

Release / decision checkpoint: Thread 52 + 53 (`release-decision-v1`).

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
npm run release-check
npm run release-check:ci
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

- `npm run release-check` is the single operator-facing preflight for merge/release and only compresses self-check + control status + dependency guardrails + routing status + planner gate into one verdict
- `npm run release-check:ci` is the CI/pipeline entry for the same verdict; it emits only the minimal JSON report and exits `0` on `pass`, `1` on `fail`
- both entries now archive each run into `.tmp/release-check-history/manifest.json` and `.tmp/release-check-history/snapshots/<run-id>.json`
- both entries also support read-only compare against release-check history through `--compare-previous` and `--compare-snapshot <run-id|path>`
- the current release history checkpoint is the snapshot + manifest + compare version over the same release-check gate
- the current release decision layer checkpoint is the CI + triage complete version:
  - CI entry = `release-check:ci`
  - triage classes = `system_regression` / `control_regression` / `dependency_policy_failure` / `write_policy_failure` / `usage_layer_failure` / `routing_regression` / `planner_contract_failure`
  - `suggested_next_step` stays minimal but points to the first module family or file type to inspect
- `npm run self-check` and `npm run release-check` now both treat usage-layer metrics as blocking gate:
  - stage config is `USAGE_LAYER_GATE_STAGE` (`phase1` default)
  - `phase1`: `FTHR >= 70%` and `Generic Rate <= 30%`
  - `phase2`: `FTHR >= 80%` and `Generic Rate <= 20%`
  - self-check blocks `safe_to_change` when `usage_layer_summary.status !== "pass"`
  - release-check blocks merge/release with `usage_layer_failure` when usage gate fails
  - usage metrics unavailable is fail-closed (`usage_eval_error`) and still represented as structured gate failure
- `npm run check:dependencies` is the lockfile-only dependency safety gate:
  - it scans every checked-in `package-lock.json`
  - it currently blocks `axios@1.14.1` and `axios@0.30.4`
  - `npm run test:ci` now runs this gate before the broader test suite
- `npm run self-check` and `npm run release-check` now both treat write governance as a blocking gate:
  - self-check blocks `safe_to_change` when `write_summary.status !== "pass"`
  - release-check blocks merge/release when write governance reports `write_policy_failure`
  - this block is tied to deterministic guard/runtime integration drift only; rollout advisory evidence such as `warn` / `observe`, `rollout_basis`, or `high_risk_routes` remains visible but does not block by itself
  - the checked-in baseline summary for this gate is:
    - 33 metadata routes
    - 33 enforced routes
    - enforcement mode split `enforce:27 / observe:2 / warn:4`
- `npm run self-check` and `npm run release-check` also treat blocked dependency versions as a blocking gate:
  - self-check blocks `safe_to_change` when `dependency_summary.status !== "pass"`
  - release-check blocks merge/release when dependency guardrails report `dependency_policy_failure`
- on this preflight line, `fail` means block merge/deploy; `pass` means this gate can release the next pipeline stage
- recommended cadence:
  - local development: `npm run release-check`
  - PR pipeline: `npm run release-check:ci`
  - protected-branch merge gate: `npm run release-check:ci`
  - release/deploy pipeline: rerun `npm run release-check:ci`
- `npm test` is the release gate for the checked-in code baseline
- `check-auth.mjs` only validates app credentials and tenant-token issuance, not every user OAuth path
- real post-restart live OAuth/Lark smoke validation remains an operator step outside repo-only evidence

Minimal platform-neutral CI shape:

```bash
npm ci
npm run check:dependencies
npm test
npm run release-check:ci
```

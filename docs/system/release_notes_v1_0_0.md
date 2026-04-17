# Release Notes v1.0.0

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

Release date: 2026-03-21

## Planner

- planner stays as the checked-in executive orchestration layer rather than a background worker mesh
- execution remains lifecycle-gated: important tasks move through `created -> ... -> verifying -> completed|failed|blocked|escalated -> reflected -> improvement_proposed -> improved`
- planner outputs stay contract-bound and fail-soft on controlled errors instead of reporting fake completion
- workflow baselines and self-check remain part of the release gate

## Company Brain

- company-brain remains grounded in the implemented read-side boundary: list, search, and detail
- verified mirror ingest and learning sidecar are available, but they are still not equivalent to formal approved long-term knowledge
- review/conflict/approval stays a bounded adjacent path; release claims do not overstate it as a full runtime approval platform
- planner-facing company-brain search/detail flows are part of the stable baseline

## OAuth

- user OAuth callback persists `access_token`, `refresh_token`, and `expires_at` into SQLite-backed account state
- request-layer auth reloads stored token state and refreshes expired tokens automatically through stored `refresh_token`
- restart-equivalent test coverage confirms that closing and reopening the SQLite singleton still allows request auth to recover and call the refresh path
- unrecoverable refresh failure remains explicit as `oauth_reauth_required`

## Learning

- learning remains a simplified sidecar attached to company-brain docs rather than approved knowledge admission
- planner flows can read learned summaries, concepts, and tags through the existing search/detail surfaces
- formal approved knowledge queries continue to exclude mirror-only and learning-only rows until explicit review approval completes

## Logging

- every HTTP request in the baseline carries `trace_id`
- request logs emit `request_started` and `request_finished`
- child route logs inherit `trace_id` and `request_id`
- long-connection lane routing logs include `chosen_lane`
- fail-soft paths remain logged instead of silently swallowed, including the meeting failure-document cleanup fallback path

## Release Posture

- `v1.0.0` is the frozen production baseline for the currently validated repo behavior
- release collateral may continue to evolve, but core logic should not change on this line without cutting a new version

## Post-Release Alignment Note (Phase 2 Slice 3)

- Introduced `recovery_decision_v1` for workflow finalize-fail recovery routing; finalize-fail behavior is no longer uniformly `blocked + *_retry_required`.
- Recovery routing now supports minimal bounded split: `retry/resume`, `escalated`, `waiting_user`, and fail-soft `blocked/failed`.
- Safety posture is strengthened in combination with Phase 2 slice 1 (`verifier gate`) and slice 2 (`durable effect guard`), reducing unsafe retry after guarded write-side uncertainty.
- Boundary remains explicit: this is not a full escalation subsystem, and worker-side retry/escalation behavior is not fully closed-loop yet.

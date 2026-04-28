# System Readiness Checklist

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

Last verified in this repo on 2026-04-28.

## Build And Test

- [x] `npm test` passes end to end
- [x] `node --test tests/release-check.test.mjs tests/system-self-check.test.mjs tests/planner-contract-closure.test.mjs tests/planner-contract-consistency.test.mjs` passes
- [x] monitoring learning regression stays green across unit, HTTP route, and CLI paths
- [x] monitoring learning summaries are deterministic for a fixed sampled request set, including stable draft-proposal ids
- [x] monitoring learning top-N output now prefers fresher equal-score samples so older buckets do not crowd out new regression evidence
- [x] prompt-budget regressions remain green in the full suite
- [x] closed-loop improvement workflow no longer updates stale archived proposals when duplicate `proposal_id` values exist in the local workflow store

## Decision-OS Observability

- [x] `npm run check:self -- --json` returns `decision_os_observability` with stable shape and score output
- [x] `decision_os_observability.readiness_score.score` is available (`92.5`) and level is `ready`
- [x] `decision_os_observability.gate_summary` is fully passed (`10/10`)
- [x] `verification_fail_taxonomy` is present and currently `pass`
- [x] `npm run check:release -- --json` and `npm run release-check:ci` return `decision_os_readiness` with `final_score=92.5`, `readiness_level=ready`, and no blocked reasons
- [x] `npm run routing:closed-loop -- rerun` passes (`Eval gate: pass`)
- [x] `node scripts/memory-influence-gate.mjs --json` passes (`memory_hit_rate=1`, `action_changed_by_memory_rate=1`)

## Error Paths

- [x] controlled failures remain explicit in HTTP and planner paths (`tool_error`, `contract_violation`, `business_error`, `oauth_reauth_required`)
- [x] improvement approval/apply no longer risks fake-success against the wrong archived proposal record
- [x] meeting capture stop flow no longer silently swallows failed cleanup of a failed meeting document; it now logs the delete failure and falls back to writing the failure document

## Logging And Traceability

- [x] HTTP requests emit `request_started` / `request_finished` logs with `trace_id`
- [x] route child logs inherit `trace_id` and `request_id`
- [x] incoming `X-Request-Id` is preserved when present
- [x] long-connection lane-resolution logs include `chosen_lane`

## OAuth And Lark Request Auth

- [x] OAuth callback persists `access_token`, `refresh_token`, and `expires_at` into SQLite
- [x] request-layer auth uses stored valid tokens without unnecessary refresh
- [x] expired stored user tokens auto-refresh and persist replacement tokens
- [x] simulated restart path is covered: after closing and reopening the SQLite singleton, request auth still reloads the persisted token and refreshes it successfully
- [ ] live tenant validation after an actual process restart was not executed in this run; this checklist only confirms the checked-in request/auth code path and automated tests

## Release Gate

- [x] safe to merge from repo-code perspective once the full test suite is green
- [x] release readiness gate output includes Decision-OS score/level, verification taxonomy summary, and rollback candidate list
- [x] high-risk route rollout remains fail-soft: `meeting_confirm_write` stays `warn` until real request-backed sample minimum is satisfied
- [ ] if production readiness requires live Lark verification, perform one post-restart smoke call against the target tenant before rollout

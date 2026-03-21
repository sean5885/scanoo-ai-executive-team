# System Readiness Checklist

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

Last verified in this repo on 2026-03-21.

## Build And Test

- [x] `npm test` passes end to end
- [x] prompt-budget regressions remain green in the full suite
- [x] closed-loop improvement workflow no longer updates stale archived proposals when duplicate `proposal_id` values exist in the local workflow store

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
- [ ] if production readiness requires live Lark verification, perform one post-restart smoke call against the target tenant before rollout

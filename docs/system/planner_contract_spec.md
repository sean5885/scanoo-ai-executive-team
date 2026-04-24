# Planner Contract Spec

`/Users/seanhan/Documents/Playground/docs/system/planner_contract.json` is the checked-in source of truth for planner-side machine contracts.

## Scope

- `actions`
  - stable tool targets callable by planner runtime
  - may also include skill-backed planner actions, as long as dispatch still goes through a checked-in bridge instead of direct skill execution
  - each action defines `input_schema`, `output_schema`, and bridge/tool-side `error_codes`
  - controlled write actions may also define checked-in `governance` metadata such as `external_write`, `confirm_required`, conditional `review_required`, and required entry-governance fields
  - skill-backed actions may define `planner_visibility: "deterministic_only"` so the strict user-input planner prompt does not expose them in `target_catalog` while deterministic selector/runtime code can still use them
  - skill-backed actions may also carry repo-side `skill_surface_policy` metadata such as `surface_layer`, `promotion_stage`, `previous_promotion_stage`, `planner_catalog_eligible`, and `readiness_gate`, but current strict planner gate still treats `internal_only` skill-backed actions as not catalog-visible even if the action exists in `planner_contract.json`
  - `readiness_gate` may mirror checked-in evidence such as regression pass, answer-pipeline enforcement, observability evidence, raw-output blocking, output stability, and side-effect boundary lock; this mirror must not be used to widen planner visibility without the corresponding registry gate
  - current planner follow-up actions that surface through `runPlannerToolFlow(...)` are also part of this checked-in action catalog even when they are satisfied by local planner lifecycle state instead of the HTTP tool registry (`read_task_lifecycle_v1`, `update_task_lifecycle_v1`, `mark_resolved`)
- `presets`
  - stable multi-step planner targets
  - each preset defines `input_schema`, `output_schema`, and `step_actions`
  - `search_and_detail_doc` now only requires `q`; `doc_id` is optional because runtime may derive it from a single search hit
- `errors`
  - checked-in enum for planner/public/runtime-visible error codes
  - includes planner-input failures (`planner_failed`, `invalid_action`, `semantic_mismatch`)
  - includes planner-runtime failures (`contract_violation`, `tool_error`, `runtime_exception`, `business_error`, abort errors)
  - includes deterministic pre-dispatch auth boundary `missing_required_account_id` for planner-visible skills that require account id
  - includes bridge action errors already exposed by agent routes (`missing_user_access_token`, `invalid_query`, `internal_error`)
  - current company-brain document read routes treat `missing_user_access_token` as an explicit fail-closed auth boundary: planner/doc search must carry request-scoped user auth and cannot silently fall back to stored OAuth
  - planner runtime keeps `q` as the canonical search input key; internal tool-layer compatibility now normalizes legacy `query` through registry/contract alias metadata into canonical `q` before required-field validation for `search_company_brain_docs`
- `routing_reason`
  - checked-in enum for stable route-selection reason codes
  - replaces public reliance on free-text reason strings for router / doc-query / planner surfaces
- `release_gates`
  - checked-in release-check gate policy mirror
  - currently includes `closed_loop_non_regression_v1` with feature flag, contract-test requirements, snapshot requirements, and required closed-loop elements (`memory/retrieval/learning/non_regression`)
  - release gate policy is additive and must not widen planner public output schemas

## Public Surfaces

`public_contracts` defines the minimum machine-checkable schemas for:

- `router_decision`
  - normalized router output: `selected_target`, `target_kind`, `routing_reason`, plus `action|preset|error`
- `doc_query_route`
  - normalized doc-query flow route output: router fields plus shaped `payload`
- `planner_tool_flow_output`
  - output of `runPlannerToolFlow(...)`
  - fixed fields are `selected_action`, `execution_result`, `formatted_output`, `routing_reason`, `synthetic_agent_hint`, and `trace_id`
- `planned_user_input_envelope`
  - output of `buildPlannedUserInputEnvelope(...)`
  - strict user-input multi-step decisions may also carry an internal pre-read step `{ "action": "fetch_document", "intent": "retrieve document content before reasoning", "required": true }` when the request text already contains a document card, `document_id`, or a file link
  - this pre-read step is runtime-internal and not a planner-contract catalog action; checked-in strict validation injects and accepts it without widening `target_catalog`

## Alignment Rules

- public `error` / `fallback_reason` values must resolve to `errors`
- public `routing_reason` values must resolve to `routing_reason`
- public `selected_target` must resolve to `actions` or `presets` according to `target_kind`
- planner action governance for controlled writes must stay aligned across `planner_contract.json`, planner tool registry, and checked-in route contracts
- planner skill-backed actions must stay aligned across `planner_contract.json`, planner skill registry/bridge, and selector-emitted `routing_reason`
- planner-visible skill dispatch must satisfy the checked-in account-id guarantee boundary before bridge execution when the skill metadata declares `auth_requirements.account_id.required = true`
- internal-only skill-backed actions must remain hidden from strict planner `target_catalog`
- if runtime behavior changes intentionally, update code and this contract in the same change
- if docs disagree with code, code is the current fact and the conflict must be tracked in `open_questions.md`

## Regression Coverage

`/Users/seanhan/Documents/Playground/tests/planner-contract-regression.test.mjs` locks four representative fixtures:

- `search`
- `invalid`
- `no-match`
- `fallback`

Each fixture validates observed public output against `public_contracts` and asserts that emitted `error` / `routing_reason` / target values are declared in the contract.

`/Users/seanhan/Documents/Playground/src/planner-contract-consistency.mjs` also treats observed planner-side `routing_reason` values as a blocking contract surface. If an emitted `routing_reason` is missing from `planner_contract.json`, diagnostics must fail with `undefined_routing_reasons`.

The current closure guard also scans `src/router.js` literal `action` / `preset` / `routingReason` branches in addition to runtime fixtures, so newly added router targets or routing reasons fail the planner contract gate even before a bespoke fixture is written.

`/Users/seanhan/Documents/Playground/tests/planner-contract-closure.test.mjs` adds the cross-surface closure pack:

- router literal `action` / `preset` / `routingReason` values must all resolve to `planner_contract.json`
- canonical planner action naming must stay stable across planner envelope and answer normalization boundaries
- a canonical planner envelope must still round-trip through planner -> answer normalization -> registered-agent structured boundary without leaking raw machine envelopes

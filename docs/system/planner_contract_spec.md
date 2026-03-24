# Planner Contract Spec

`/Users/seanhan/Documents/Playground/docs/system/planner_contract.json` is the checked-in source of truth for planner-side machine contracts.

## Scope

- `actions`
  - stable tool targets callable by planner runtime
  - each action defines `input_schema`, `output_schema`, and bridge/tool-side `error_codes`
  - controlled write actions may also define checked-in `governance` metadata such as `external_write`, `confirm_required`, and conditional `review_required`
- `presets`
  - stable multi-step planner targets
  - each preset defines `input_schema`, `output_schema`, and `step_actions`
  - `search_and_detail_doc` now only requires `q`; `doc_id` is optional because runtime may derive it from a single search hit
- `errors`
  - checked-in enum for planner/public/runtime-visible error codes
  - includes planner-input failures (`planner_failed`, `invalid_action`, `semantic_mismatch`)
  - includes planner-runtime failures (`contract_violation`, `tool_error`, `runtime_exception`, `business_error`, abort errors)
  - includes bridge action errors already exposed by agent routes (`missing_user_access_token`, `invalid_query`, `internal_error`)
  - current company-brain document read routes treat `missing_user_access_token` as an explicit fail-closed auth boundary: planner/doc search must carry request-scoped user auth and cannot silently fall back to stored OAuth
- `routing_reason`
  - checked-in enum for stable route-selection reason codes
  - replaces public reliance on free-text reason strings for router / doc-query / planner surfaces

## Public Surfaces

`public_contracts` defines the minimum machine-checkable schemas for:

- `router_decision`
  - normalized router output: `selected_target`, `target_kind`, `routing_reason`, plus `action|preset|error`
- `doc_query_route`
  - normalized doc-query flow route output: router fields plus shaped `payload`
- `planner_tool_flow_output`
  - output of `runPlannerToolFlow(...)`
- `planned_user_input_envelope`
  - output of `buildPlannedUserInputEnvelope(...)`

## Alignment Rules

- public `error` / `fallback_reason` values must resolve to `errors`
- public `routing_reason` values must resolve to `routing_reason`
- public `selected_target` must resolve to `actions` or `presets` according to `target_kind`
- planner action governance for controlled writes must stay aligned across `planner_contract.json`, planner tool registry, and checked-in route contracts
- if runtime behavior changes intentionally, update code and this contract in the same change
- if docs disagree with code, code is the current fact and the conflict must be tracked in `open_questions.md`

## Regression Coverage

`/Users/seanhan/Documents/Playground/tests/planner-contract-regression.test.mjs` locks four representative fixtures:

- `search`
- `invalid`
- `no-match`
- `fallback`

Each fixture validates observed public output against `public_contracts` and asserts that emitted `error` / `routing_reason` / target values are declared in the contract.

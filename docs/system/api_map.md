# API Map

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## How To Read This File

This is the grouped HTTP surface mirror for the current repo.

- exhaustive behavior still lives in `/Users/seanhan/Documents/Playground/src/http-server.mjs`
- route-level write policy and method contracts are enforced from `/Users/seanhan/Documents/Playground/src/http-route-contracts.mjs`
- this document groups routes by runtime role so newcomers can find the real entrypoints quickly

## 1. Runtime, Auth, and Monitoring

| Route | Method | Current role | Status |
| --- | --- | --- | --- |
| `/health` | `GET` | health check | implemented |
| `/monitoring` | `GET` | local HTML dashboard over persisted request-monitor data | implemented |
| `/oauth/lark/login` | `GET` | start user OAuth | implemented |
| `/oauth/lark/callback` | `GET` | exchange code and persist token state | implemented |
| `/api/auth/status` | `GET` | inspect current auth state | implemented |
| `/api/system/runtime-info` | `GET` | expose live process facts | implemented |
| `/api/runtime/resolve-scopes` | `POST` | resolve binding/session/workspace/sandbox scope | implemented |
| `/api/runtime/sessions` | `GET` | inspect persisted runtime sessions | implemented |
| `/api/monitoring/requests` | `GET` | recent request summaries | implemented |
| `/api/monitoring/errors` | `GET` | recent error requests | implemented |
| `/api/monitoring/errors/latest` | `GET` | latest persisted error | implemented |
| `/api/monitoring/metrics` | `GET` | aggregate request metrics | implemented |
| `/api/monitoring/learning` | `GET` | review-first learning summary from request traces | implemented |
| `/agent/improvements/learning/generate` | `POST` | persist reviewable improvement proposals | implemented |
| `/agent/lark-plugin/dispatch` | `POST` | official Lark plugin hybrid dispatch entry; normalizes plugin request/session metadata plus `requested_capability / capability_source`, keeps bounded `plugin_context` handoff data for explicit auth and doc/compare refs, mirrors normalized explicit user auth onto the synthetic lane event/context for downstream fallback paths, resolves capability-to-lane mapping (`mapped_lane / lane_mapping_source / fallback_reason`) before deciding `knowledge_answer` vs `lane_backend` vs `plugin_native`, includes dedicated minimal `scanoo-compare` and `scanoo-diagnose` lanes for `scanoo_compare / scanoo_diagnose`, records observability, then either executes the bounded backend path or returns a plugin-native forward decision | implemented |

## 2. Retrieval and Public Answer Surface

| Route | Method | Current role | Status |
| --- | --- | --- | --- |
| `/search` | `GET` | retrieval search over index authority | implemented |
| `/answer` | `GET` | planner-first answer surface with optional ingress-gated `runAgentE2E(...)` canary (`AGENT_E2E_ENABLED` + `AGENT_E2E_RATIO`) as single runtime authority, real dispatch-backed tool executor injection, and explicit-only legacy fallback (`AGENT_E2E_LEGACY_FALLBACK_ENABLED`); final response normalized to `answer -> sources -> limitations`, with minimal partial-success decomposition when a mixed request contains at least one answer-boundary-doable subtask | implemented |
| `/sync/full` | `POST` | full sync | implemented |
| `/sync/incremental` | `POST` | incremental sync | implemented |

### Current `/answer` Truth

- the public route calls `executePlannedUserInput(...)`, not `answer-service.mjs` directly
- the public body is shaped by `/Users/seanhan/Documents/Playground/src/user-response-normalizer.mjs`
- public `answer / sources / limitations` now only read from canonical `execution_result.data`
- direct HTTP `/answer` still exists, but with `LARK_DIRECT_INGRESS_PRIMARY_ENABLED=false` the checked-in runtime marks it as a non-primary direct ingress path rather than the formal plugin entry
- direct HTTP `/answer` can optionally run `runAgentE2E(...)` first when `AGENT_E2E_ENABLED=true` and `AGENT_E2E_RATIO>0`; that path injects a real planner-dispatch-backed tool executor and serves as the single active authority for the request
- canary admission now supports explicit force for diagnostics via `agent_e2e=force` query flag or `x-agent-e2e-force: true` header even when rollout ratio is `0`
- when canary execution fails or has no stable final answer, default behavior is single-runtime fail-soft stop; legacy planner fallback is opt-in only via `AGENT_E2E_LEGACY_FALLBACK_ENABLED=true`
- agent canary path now includes a strict request-level latency budget guard in `runAgentE2E(...)`: default `AGENT_E2E_BUDGET_MS=5000`, computes `request_deadline_at = Date.now() + request_budget_ms`, and propagates these values through agent context
- each agent step now checks the global deadline first, dynamically clamps effective max steps by remaining budget, and fast-fails when remaining budget is too small (`agent_e2e_budget_exhausted` / `latency_budget_step_cap`)
- tool execution timeout is now clamped by remaining budget (`min(step_timeout, remaining_budget)` via `AGENT_E2E_STEP_TIMEOUT_MS` / `AGENT_E2E_HARD_TIMEOUT_MS`), with `<200ms`-class remaining budget defaulting to skip-tool fail-soft behavior
- direct `/answer` now applies one bounded early-abort latency budget window (default `5000ms`, configurable via `ANSWER_LATENCY_BUDGET_MS` or `AGENT_E2E_BUDGET_MS`) to both canary and non-canary planner execution paths, so replies fail-soft before the outer ~60s HTTP timeout
- direct `/answer` agent canary now emits explicit diagnostics around ingress, planner decision, tool execution before/after, continuation decision, and terminal exit
- the public `/answer` payload still does not expose raw planner errors, but the in-process normalized object now carries a non-enumerable `failure_class` for usage-layer eval / telemetry classification
- public `sources[]` lines are derived from canonical source objects through `/Users/seanhan/Documents/Playground/src/answer-source-mapper.mjs`
- `/answer` and plugin-backed planner/lane entrypoints now arm one earlier bounded-fallback abort signal before the outer HTTP timeout, so bounded fail-soft replies can return before the final generic timeout guard
- `answer-service.mjs` still exists as a secondary retrieval-answer helper, but it is not the primary HTTP answer surface

## 3. Company-Brain Read Surfaces

| Route | Method | Current role | Read authority |
| --- | --- | --- | --- |
| `/api/company-brain/docs` | `GET` | minimal mirror list | `mirror` |
| `/api/company-brain/docs/:doc_id` | `GET` | minimal mirror detail | `mirror` |
| `/api/company-brain/search` | `GET` | minimal mirror search | `mirror` |
| `/agent/company-brain/docs` | `GET` | planner-facing mirror list | `mirror` |
| `/agent/company-brain/docs/:doc_id` | `GET` | planner-facing mirror detail | `mirror` |
| `/agent/company-brain/search` | `GET` | planner-facing mirror search | `mirror` |
| `/agent/company-brain/approved/docs` | `GET` | applied approved-knowledge list | `derived` |
| `/agent/company-brain/approved/docs/:doc_id` | `GET` | applied approved-knowledge detail | `derived` |
| `/agent/company-brain/approved/search` | `GET` | applied approved-knowledge search | `derived` |

## 4. Company-Brain Governance Writes

| Route | Method | Current role | Runtime type |
| --- | --- | --- | --- |
| `/agent/company-brain/review` | `POST` | write review state | internal governance write |
| `/agent/company-brain/conflicts` | `POST` | write conflict-check result | internal governance write |
| `/agent/company-brain/approval-transition` | `POST` | write approval decision | internal governance write |
| `/agent/company-brain/docs/:doc_id/apply` | `POST` | promote approved knowledge into applied surface | internal governance write |
| `/agent/company-brain/learning/ingest` | `POST` | learning-doc ingest | internal governance write |
| `/agent/company-brain/learning/state` | `POST` | learning-state update | internal governance write |

Important boundary:

- these routes use `runMutation(...)`
- they do not become external Lark writes
- they do not prove a broader generic company-brain approval runtime beyond the checked-in mirror/review/apply path
- optional review-state paths no longer treat runtime `ok` as sufficient on their own; callers now also require business `success=true`, so `/agent/company-brain/conflicts` and internal review-sync helpers fail closed on business errors

## 5. Doc and Comment Surfaces

| Route | Method | Current role | Status |
| --- | --- | --- | --- |
| `/api/doc/read` | `GET` | live document read | implemented |
| `/api/doc/create` | `POST` | preview-first document create, then confirmed write | implemented |
| `/agent/docs/create` | `POST` | planner-facing wrapper over document create | implemented |
| `/api/doc/update` | `POST` | append or confirmed replace/heading-targeted update | implemented |
| `/api/doc/comments` | `GET` | list document comments | implemented |
| `/api/doc/rewrite-from-comments` | `POST` | preview/apply comment rewrite workflow | implemented |
| `/api/doc/comments/suggestion-card` | `POST` | build suggestion card from unseen comments | implemented |
| `/api/doc/comments/poll-suggestion-cards` | `POST` | manual/timer poll surface | implemented |
| `/api/doc/lifecycle` | `GET` | lifecycle list for API-created docs | implemented |
| `/api/doc/lifecycle/summary` | `GET` | lifecycle aggregate summary | implemented |
| `/api/doc/lifecycle/retry` | `POST` | retry failed lifecycle step | implemented |

Current write truth:

- preview and confirmation are route-level user experience surfaces
- final external mutation still routes through `lark-mutation-runtime -> mutation-runtime -> execute-lark-write`
- heading-targeted update exists at preview/planning level, but doc write materialization is still bounded by the current doc update adapter
- `POST /api/doc/create` and `POST /api/doc/lifecycle/retry` now keep verified company-brain ingest/review sync inside the request lifecycle; if that internal sync fails, the route does not return full success
- `POST /api/doc/update` now treats the follow-up company-brain review sync as part of the route success boundary; if review sync fails at runtime or returns `success=false`, the route returns an error instead of `ok=true`

## 6. Drive and Wiki Surfaces

| Route family | Methods | Current role | Status |
| --- | --- | --- | --- |
| `/api/drive/root`, `/api/drive/list`, `/api/drive/task-status` | `GET` | browse/status | implemented |
| `/api/drive/create-folder`, `/api/drive/move`, `/api/drive/delete` | `POST` | direct external writes | implemented |
| `/api/drive/organize/preview`, `/api/drive/organize/apply` | `POST` | preview/apply organization workflow | implemented |
| `/api/wiki/spaces`, `/api/wiki/spaces/:space_id/nodes` | `GET` | browse wiki | implemented |
| `/api/wiki/create-node`, `/api/wiki/move` | `POST` | direct external writes | implemented |
| `/api/wiki/organize/preview`, `/api/wiki/organize/apply` | `POST` | preview/apply organization workflow | implemented |

## 7. Meeting, Message, Calendar, Task, Bitable, and Sheet Surfaces

| Route family | Current role | Status |
| --- | --- | --- |
| `/api/meeting/process`, `/api/meeting/confirm`, `/meeting/confirm` | meeting preview/confirm/writeback | implemented |
| `/api/messages/*` | message list/search/get/reply/reaction | implemented |
| `/api/calendar/*` | primary calendar, search, create event, freebusy | implemented |
| `/api/tasks/*` | task get/create/comments CRUD | implemented |
| `/api/bitable/*` | app/table/record CRUD and bulk upsert | implemented |
| `/api/spreadsheets/*` | spreadsheet create/update/read/replace | implemented |

## 8. Deprecated or Non-Primary Readings

- treating `/answer` as a direct `answer-service.mjs` wrapper is outdated
- treating company-brain read routes as approval-runtime surfaces is outdated
- treating `company_brain` as entirely unimplemented is outdated; the current repo has a bounded mirror/read/review/apply path, not a full autonomous memory runtime
- treating preview routes as completed write paths is outdated

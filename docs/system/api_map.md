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

## 2. Retrieval and Public Answer Surface

| Route | Method | Current role | Status |
| --- | --- | --- | --- |
| `/search` | `GET` | retrieval search over index authority | implemented |
| `/answer` | `GET` | planner-first answer surface; final response normalized to `answer -> sources -> limitations` | implemented |
| `/sync/full` | `POST` | full sync | implemented |
| `/sync/incremental` | `POST` | incremental sync | implemented |

### Current `/answer` Truth

- the public route calls `executePlannedUserInput(...)`, not `answer-service.mjs` directly
- the public body is shaped by `/Users/seanhan/Documents/Playground/src/user-response-normalizer.mjs`
- public `answer / sources / limitations` now only read from canonical `execution_result.data`
- public `sources[]` lines are derived from canonical source objects through `/Users/seanhan/Documents/Playground/src/answer-source-mapper.mjs`
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
- treating preview routes as completed write paths is outdated

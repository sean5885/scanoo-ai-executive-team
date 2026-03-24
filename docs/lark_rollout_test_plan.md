# Lark Rollout Test Plan

## Purpose

This document is the single rollout and acceptance reference for the current Lark write policy refactor.

Confirmed runtime policy:

`preview-first -> explicit confirmation -> budget guard -> dedupe -> write`

This plan covers the checked-in high-risk paths:

- `POST /api/doc/create`
- `POST /api/doc/update`
- `POST /api/doc/rewrite-from-comments`
- `POST /api/meeting/confirm`
- `GET /meeting/confirm`
- `POST /api/drive/organize/apply`
- `POST /api/wiki/organize/apply`

It also covers:

- local confirmation store behavior
- local Lark write budget / duplicate suppression behavior
- write-side error handling for missing, invalid, and stale confirmations

## Grounded Runtime Notes

- Preview is not write success.
- No high-risk write is considered successful unless the external mutation path actually runs.
- For doc create and doc update, preview is the default first response.
- Real writes require explicit confirmation artifacts.
- Budget guard may downgrade or block confirmed writes before any external mutation.
- Duplicate suppression may downgrade or block writes before any external mutation.
- Confirmation artifacts are single-use and scoped by account plus target-specific payload checks.
- Current doc update final-write contract requires explicit `document_id` plus `section_heading` when `confirm=true`.
- Current doc update stale confirmation behavior returns HTTP `409`.

## Test Matrix

| ID | Area | Scenario | Priority | Suggested test file |
| --- | --- | --- | --- | --- |
| `DC-01` | doc create | first request returns preview only | P0 | `tests/http-server.route-success.test.mjs` |
| `DC-02` | doc create | confirmed request writes only after valid confirmation | P0 | `tests/http-server.route-success.test.mjs` |
| `DC-03` | doc create | missing or invalid confirmation is rejected | P0 | `tests/http-server.route-success.test.mjs` |
| `DU-01` | doc update | append / replace / targeted update are preview-first | P0 | `tests/http-server.route-success.test.mjs` |
| `DU-02` | doc update | confirmed append / replace / targeted update writes once | P0 | `tests/http-server.route-success.test.mjs` |
| `DU-03` | doc update | stale confirmation returns `409` | P0 | `tests/http-server.route-success.test.mjs` |
| `BG-01` | budget | soft limit downgrades non-essential write to preview | P0 | `tests/lark-write-budget-guard.test.mjs` |
| `BG-02` | budget | hard limit blocks non-whitelist write | P0 | `tests/lark-write-budget-guard.test.mjs` |
| `BG-03` | budget | duplicate suppression only blocks true duplicates | P0 | `tests/lark-write-budget-guard.test.mjs` |
| `BG-04` | budget | blocked write is persisted into budget log | P0 | `tests/lark-write-budget-guard.test.mjs` |
| `CL-01` | confirmation | create / replace / rewrite / meeting confirmation lifecycle | P0 | `tests/doc-update-confirmations.test.mjs` |
| `RW-01` | rewrite | rewrite preview then confirmed apply covers full high-risk path | P0 | `tests/http-server.route-success.test.mjs` |
| `ME-01` | meeting | preview does not write before confirm | P0 | `tests/meeting-agent.test.mjs` |
| `ME-02` | meeting | confirmed write prepends or creates target doc | P0 | `tests/meeting-agent.test.mjs` |
| `ME-03` | meeting | confirmed write blocked by budget stays preview-only | P0 | `tests/meeting-agent.test.mjs` |
| `CD-01` | cloud doc | drive apply requires prior preview / review | P0 | `tests/http-server.route-success.test.mjs` |
| `CD-02` | cloud doc | wiki apply requires prior preview / review | P0 | `tests/http-server.route-success.test.mjs` |

## Case Details

### DC-01 doc/create preview-first

- Purpose
  Confirm that the first `POST /api/doc/create` request returns preview only and does not call the real create path.
- Preconditions
  Valid user auth context is available.
  `createDocument(...)` is mocked.
  Confirmation store starts empty.
- Request payload
  `{ "title": "Preview First Draft", "folder_token": "fld-preview", "content": "# Draft" }`
- Preview behavior
  Route must return preview metadata and a `confirmation_id`.
- Confirm condition
  No `confirm=true`; no write is allowed.
- Side effects
  No document create.
  No initial content write.
- Budget behavior
  No budget event should be recorded because no confirmed write is attempted.
- Confirmation lifecycle
  A pending `document_create` item must exist after preview.
- Expected result
  HTTP `200`.
  `ok=true`.
  `action=document_create_preview`.
  `preview_required=true`.
  Response includes `confirmation_id`, `confirmation_type`, `confirmation_expires_at`, `create_preview`.
- Error cases
  Not applicable for this case.

### DC-02 doc/create confirmed create

- Purpose
  Confirm that real create only happens after a valid preview artifact is confirmed.
- Preconditions
  `DC-01` preview succeeded and returned `confirmation_id`.
  `createDocument(...)` and `updateDocument(...)` are mocked.
- Request payload
  Same title / folder / content as preview plus `confirm=true` and `confirmation_id`.
- Preview behavior
  First request still returns preview only.
- Confirm condition
  `confirm=true` and valid `confirmation_id` are both required.
- Side effects
  Exactly one external create call.
  Optional initial content write runs once when content exists.
- Budget behavior
  One allowed `create_doc` budget event is persisted after success.
- Confirmation lifecycle
  Confirmation exists after preview.
  Confirmation is consumed after apply.
  Reuse of the same id must fail.
- Expected result
  HTTP `200`.
  `ok=true`.
  `action=document_create`.
  `document_id` exists.
- Error cases
  Reusing the same confirmation must not write again.

### DC-03 doc/create missing or invalid confirmation

- Purpose
  Confirm that create requests without a valid confirmation artifact never write.
- Preconditions
  Valid auth context.
  `createDocument(...)` is mocked and observable.
- Request payload
  Case A: `confirm=true` without `confirmation_id`.
  Case B: invalid `confirmation_id`.
  Case C: valid preview id but changed payload.
- Preview behavior
  Preview may exist from a previous call.
- Confirm condition
  Missing or mismatched confirmation must fail.
- Side effects
  No create.
  No update.
- Budget behavior
  No allowed write event should appear.
- Confirmation lifecycle
  Invalid or mismatched confirmation must not be consumed into a successful write.
- Expected result
  HTTP `400`.
  `error=missing_confirmation_id` or `error=invalid_or_expired_confirmation`.
- Error cases
  Missing confirmation.
  Invalid confirmation.
  Preview payload drift.

### DU-01 doc/update preview-first

- Purpose
  Confirm that append, replace, and heading-targeted update all return preview first.
- Preconditions
  `getDocument(...)` is mocked.
  `updateDocument(...)` is mocked and observable.
- Request payload
  Append: `{ "document_id": "doc-1", "content": "Append once" }`
  Replace: `{ "document_id": "doc-1", "content": "# Replaced", "mode": "replace" }`
  Targeted: `{ "document_id": "doc-1", "content": "New line", "target_heading": "第二部分" }`
- Preview behavior
  All three requests return preview only.
- Confirm condition
  No `confirm=true`; no write is allowed.
- Side effects
  No `updateDocument(...)` call.
- Budget behavior
  No budget event should be recorded on preview.
- Confirmation lifecycle
  Each preview writes a pending `document_replace` confirmation.
- Expected result
  HTTP `200`.
  `preview_required=true`.
  Action is one of:
  `document_update_append_preview`
  `document_update_replace_preview`
  `document_update_targeted_preview`
- Error cases
  Unsupported target mode should return `400`.

### DU-02 doc/update confirmed apply

- Purpose
  Confirm that append, replace, and targeted update only write after valid confirmation.
- Preconditions
  Matching preview confirmation exists.
  `getDocument(...)` and `updateDocument(...)` are mocked.
- Request payload
  Preview payload followed by apply payload with:
  `confirm=true`
  `confirmation_id`
  explicit `document_id`
  explicit `section_heading`
- Preview behavior
  Preview computes the proposed final content.
- Confirm condition
  Valid confirmation plus explicit final-write target.
- Side effects
  Exactly one `updateDocument(...)` call per confirmed apply.
- Budget behavior
  Allowed `document_update` budget event must be recorded.
- Confirmation lifecycle
  Confirmation exists after preview and is removed after apply.
- Expected result
  HTTP `200`.
  Append returns `document_update`.
  Replace returns `document_update_replace_apply`.
  Targeted returns `document_update_targeted_apply`.
- Error cases
  Missing explicit write target returns `400`.

### DU-03 doc/update stale confirmation

- Purpose
  Confirm that a revision change between preview and apply returns `409`.
- Preconditions
  First `getDocument(...)` returns revision `rev-1`.
  Apply-time `getDocument(...)` returns revision `rev-2`.
- Request payload
  Preview request then confirmed apply request.
- Preview behavior
  Preview succeeds and creates confirmation.
- Confirm condition
  Confirmation is valid, but document revision changed.
- Side effects
  No `updateDocument(...)` call.
- Budget behavior
  Budget may be checked before stale rejection, but no write success may be recorded.
- Confirmation lifecycle
  Current implementation consumes the confirmation before stale rejection is returned.
  Tests must assert current code truth rather than idealized behavior.
- Expected result
  HTTP `409`.
  `error=stale_confirmation`.
- Error cases
  Revision drift.

### BG-01 soft limit fallback

- Purpose
  Confirm that soft limit downgrades non-essential writes before any external mutation.
- Preconditions
  Budget store is prefilled to the soft limit.
- Request payload
  Any non-essential confirmed write metadata.
- Preview behavior
  The caller must be forced back into preview-only handling.
- Confirm condition
  Confirm may be present, but write still must not proceed.
- Side effects
  No real write should run.
- Budget behavior
  `allow=false`
  `reason=write_budget_soft_limit_reached`
  `fallback_to_preview=true`
- Confirmation lifecycle
  Existing preview confirmation should remain a preview path, not become a write success.
- Expected result
  Blocked decision and persisted blocked event.
- Error cases
  Soft limit not triggered when store is already full.

### BG-02 hard limit block

- Purpose
  Confirm that hard limit blocks non-whitelist writes.
- Preconditions
  Budget store is prefilled to the hard limit.
- Request payload
  Any non-whitelist confirmed write metadata.
- Preview behavior
  No real write.
- Confirm condition
  Confirm may be present, but policy still blocks.
- Side effects
  No real write should run.
- Budget behavior
  `allow=false`
  `reason=write_budget_hard_limit_reached`
- Confirmation lifecycle
  Write must not complete.
- Expected result
  Blocked decision and persisted blocked event.
- Error cases
  Whitelist misclassification.

### BG-03 duplicate suppression correctness

- Purpose
  Confirm that only true duplicates are blocked and legal confirms are not misblocked.
- Preconditions
  One successful write event already exists in the budget store.
- Request payload
  Case A: identical repeat request.
  Case B: same target but different content.
  Case C: legal confirm with distinct payload boundary.
- Preview behavior
  Preview paths must not be conflated with confirmed writes.
- Confirm condition
  Legal confirm should still be allowed when content differs.
- Side effects
  Only true duplicates are blocked.
- Budget behavior
  Duplicate reasons may be:
  `duplicate_write_idempotency_key`
  `duplicate_write_same_session`
  `duplicate_write_same_doc_content`
- Confirmation lifecycle
  Valid confirmation must not be rejected solely because another preview or distinct confirmed write exists.
- Expected result
  Exact duplicate blocked.
  Distinct valid confirm allowed.
- Error cases
  Over-aggressive fingerprinting.

### BG-04 blocked write budget log

- Purpose
  Confirm that blocked writes always leave durable budget evidence.
- Preconditions
  A blocked scenario can be deterministically triggered.
- Request payload
  Any blocked confirmed write metadata.
- Preview behavior
  Caller stays in preview / blocked state.
- Confirm condition
  Confirm may be present but blocked.
- Side effects
  No real write.
- Budget behavior
  Log entry must contain:
  `blocked=true`
  `allowed=false`
  `reason`
  `scope_key`
  relevant metadata such as `confirmation_id`
- Confirmation lifecycle
  No successful completion.
- Expected result
  Budget store includes the blocked event.
- Error cases
  Blocked path forgets to call `recordCall(...)`.

### CL-01 confirmation lifecycle

- Purpose
  Confirm the shared confirmation store works for:
  `document_create`
  `document_replace`
  `comment_rewrite`
  `meeting_write`
- Preconditions
  Confirmation store starts empty.
- Request payload
  Direct helper inputs for create, peek, and consume.
- Preview behavior
  Each helper creates one pending confirmation.
- Confirm condition
  Consume requires the correct account and payload boundary.
- Side effects
  Store item is removed after successful consume.
- Budget behavior
  Not applicable at helper level.
- Confirmation lifecycle
  Must cover:
  create
  peek
  valid consume
  mismatched consume
  wrong account
  second consume
  expired cleanup
- Expected result
  Only valid consume succeeds.
  Expired entries are removed on load.
- Error cases
  Missing item.
  Wrong account.
  Payload mismatch.
  Expired artifact.

### RW-01 rewrite full path

- Purpose
  Confirm that rewrite preview and confirmed apply cover the full high-risk route.
- Preconditions
  Rewrite preview can be created.
  Apply path must be observable.
- Request payload
  Preview:
  `{ "document_id": "doc-1", "apply": false }`
  Apply:
  `{ "document_id": "doc-1", "apply": true, "confirm": true, "confirmation_id": "..." }`
- Preview behavior
  Preview returns rewrite summary, patch plan, and confirmation artifact.
- Confirm condition
  Apply requires `confirm=true` and valid `confirmation_id`.
- Side effects
  Only apply should replace document content and optionally resolve comments.
- Budget behavior
  Apply should pass through budget guard before write.
- Confirmation lifecycle
  Preview creates `comment_rewrite` confirmation.
  Apply consumes it.
- Expected result
  Apply succeeds once with valid confirmation.
- Error cases
  Missing confirmation.
  Invalid confirmation.
  Stale confirmation.
- Current testability note
  Current route path directly calls `applyRewrittenDocument(...)`, so route-level full mocking is limited without an extra seam.

### ME-01 meeting preview no write before confirm

- Purpose
  Confirm that meeting preview stops at awaiting confirmation.
- Preconditions
  Meeting coordinator harness is available.
- Request payload
  `processMeetingPreview(...)` input with transcript text.
- Preview behavior
  Summary is generated and confirmation card is sent.
- Confirm condition
  No confirm yet.
- Side effects
  No target doc create.
  No target doc update.
- Budget behavior
  No write budget event should exist on preview alone.
- Confirmation lifecycle
  `meeting_write` confirmation exists after preview.
- Expected result
  `workflow_state=awaiting_confirmation`.
- Error cases
  Missing group chat id or missing transcript content.

### ME-02 meeting confirmed write

- Purpose
  Confirm that meeting confirm writes only after the confirmation step.
- Preconditions
  Preview already created the confirmation.
- Request payload
  `confirmMeetingWrite({ confirmationId })`
- Preview behavior
  Preview does not write.
- Confirm condition
  Valid meeting confirmation exists.
- Side effects
  Existing doc is prepended or new doc is created.
  Meeting mapping is stored.
  Weekly tracker may update.
- Budget behavior
  Current repo intent says this path should be budget-guarded.
- Confirmation lifecycle
  Confirmation exists before confirm and is consumed after confirm.
- Expected result
  `workflow_state=writing_back`.
  Target doc updated once.
- Error cases
  Invalid confirmation.
  Write guard denial.

### ME-03 meeting budget block

- Purpose
  Confirm that budget-blocked meeting confirm stays preview-only.
- Preconditions
  Valid meeting confirmation exists.
  Budget block is active.
- Request payload
  `confirmMeetingWrite({ confirmationId })`
- Preview behavior
  Preview remains valid but no write happens.
- Confirm condition
  Confirm is present but budget block wins.
- Side effects
  No doc write.
- Budget behavior
  Blocked event with budget reason should exist.
- Confirmation lifecycle
  Write must not be treated as completed.
- Expected result
  Blocked response or blocked decision.
- Error cases
  Current code does not yet expose a grounded meeting budget-guard path in `confirmMeetingWrite(...)`.

### CD-01 drive apply preview prerequisite

- Purpose
  Confirm that drive apply cannot bypass preview / review state.
- Preconditions
  Either no preview task exists, or a same-scope preview task exists.
- Request payload
  `POST /api/drive/organize/apply`
- Preview behavior
  Preview must be completed first for the same scope.
- Confirm condition
  Route uses preview/review continuity rather than explicit confirmation ids.
- Side effects
  No move task submission without prior preview.
- Budget behavior
  Apply path also passes through budget guard.
- Confirmation lifecycle
  Not confirmation-store based; lifecycle is executive task state continuity.
- Expected result
  Without preview: HTTP `409`, `error=preview_required`.
  With preview: apply may proceed.
- Error cases
  Scope mismatch.
  Missing preview plan.

### CD-02 wiki apply preview prerequisite

- Purpose
  Confirm that wiki apply cannot bypass preview / review state.
- Preconditions
  Either no preview task exists, or a same-scope preview task exists.
- Request payload
  `POST /api/wiki/organize/apply`
- Preview behavior
  Preview must be completed first for the same scope.
- Confirm condition
  Route uses preview/review continuity rather than explicit confirmation ids.
- Side effects
  No move/create task submission without prior preview.
- Budget behavior
  Apply path also passes through budget guard.
- Confirmation lifecycle
  Not confirmation-store based; lifecycle is executive task state continuity.
- Expected result
  Without preview: HTTP `409`, `error=preview_required`.
  With preview: apply may proceed.
- Error cases
  Scope mismatch.
  Missing preview plan.

## Acceptance Rules

Rollout is not ready unless:

- every P0 case is implemented and passing
- no checked-in test still treats preview as write success
- no checked-in caller test still assumes single-call create
- blocked writes leave budget evidence
- confirmation lifecycle tests cover create / replace / rewrite / meeting
- stale confirmation returns `409` on doc update
- drive and wiki apply cannot bypass preview / review

## Known Testability Constraints

- If meeting confirm is not budget-guarded in current code, mark as P0 and do not fake coverage.
- If rewrite apply route cannot be cleanly mocked through the HTTP test harness, mark as P0 and do not overclaim route coverage.

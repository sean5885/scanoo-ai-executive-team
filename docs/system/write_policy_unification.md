# Write Policy Unification

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document defines the next checked-in design step for unifying write governance across external mutation paths.

It is intentionally design-first:

- it inventories the write actions that already exist in code
- it proposes one shared write-policy contract
- it marks which paths are already partially aligned
- it proposes a minimum Phase 1 rollout that does not rewrite the runtime

It does **not** claim that the repo already has one unified write-governance runtime today.

The repo now also carries a still-limited skeleton module at `/Users/seanhan/Documents/Playground/src/mutation-runtime.mjs`. The current checked-in usage is intentionally narrow: the `create_doc` HTTP execute path now passes through `runMutation(...)`, but that wrapper still does not yet own policy, guard, verifier, admission, or route-specific business decisions. The current checked-in contract returns `{ ok: false, error: "missing_execute" }` when no executor is supplied, derives `meta.execution_mode` from `context.execution_mode` with a default of `passthrough`, records `meta.duration_ms` around the downstream executor call, and now attaches a small `meta.journal` with `action / status / started_at` plus `error` on failure. In the `controlled` branch it still forwards the same write request with an added `controlled: true` marker into the downstream executor. It still fail-soft returns `{ ok: false, action, error: "execution_failed", meta }` if the executor throws. The current `create_doc` route explicitly unwraps that nested write-execution envelope before building the HTTP response so the external response shape stays stable. Real checked-in enforcement and admission behavior still lives in the existing route-local governance, `executeLarkWrite(...)`, `decideWriteGuard(...)`, and `src/mutation-admission.mjs` paths.

## Current Grounded Files

Current code truth for this design is grounded in:

- `/Users/seanhan/Documents/Playground/src/http-server.mjs`
- `/Users/seanhan/Documents/Playground/src/write-guard.mjs`
- `/Users/seanhan/Documents/Playground/src/lark-write-guard.mjs`
- `/Users/seanhan/Documents/Playground/src/http-route-contracts.mjs`
- `/Users/seanhan/Documents/Playground/src/write-policy-contract.mjs`
- `/Users/seanhan/Documents/Playground/src/http-idempotency-store.mjs`
- `/Users/seanhan/Documents/Playground/src/lark-write-budget-guard.mjs`
- `/Users/seanhan/Documents/Playground/src/execute-lark-write.mjs`
- `/Users/seanhan/Documents/Playground/src/meeting-agent.mjs`
- `/Users/seanhan/Documents/Playground/src/cloud-doc-organization-workflow.mjs`
- `/Users/seanhan/Documents/Playground/src/company-brain-write-intake.mjs`
- `/Users/seanhan/Documents/Playground/src/company-brain-lifecycle-contract.mjs`
- `/Users/seanhan/Documents/Playground/src/mutation-admission.mjs`
- `/Users/seanhan/Documents/Playground/src/mutation-runtime.mjs`
- `/Users/seanhan/Documents/Playground/docs/system/planner_contract.json`

## Boundary

This unification work covers two adjacent families:

1. external writes
   - mutations to Lark Drive / Wiki / Doc / Message / Calendar / Task / Bitable / Sheet surfaces
2. internal governance writes
   - company-brain mirror / review / approval / learning writes that do not leave the local runtime, but still need the same policy language

Preview-only paths are intentionally excluded from the write-action inventory below unless they directly gate an apply path.

## A. Write Action Inventory

### Phase 1 focus set

These are the write actions that should define the first shared policy vocabulary because they already have partial governance or explicit apply/writeback semantics.

| action key | current entry | target | current grounded governance |
| --- | --- | --- | --- |
| `create_doc` | `POST /api/doc/create`, `POST /agent/docs/create` | external Lark doc create, plus optional initial content write | explicit create guard in `lark-write-guard.mjs`; create is now preview-first via `document_create` confirmation artifacts and requires `confirm=true + confirmation_id` on apply; planner/agent governance in `planner_contract.json`; final external write now routes through `executeLarkWrite(...)` plus budget / duplicate guard; `external_write=true`; `review_required=conditional` |
| `update_doc` | `POST /api/doc/update` | external Lark doc update | replace/targeted modes use preview/confirm; append keeps existing direct-apply API shape; all final writes now route through `executeLarkWrite(...)` plus budget / duplicate guard; downstream company-brain intake classifies update as review-gated |
| `document_comment_rewrite_apply` | `POST /api/doc/rewrite-from-comments` with apply path | external Lark doc replace plus optional comment resolution | preview confirmation artifact plus `decideWriteGuard(...)`; verifier precondition is patch-plan plus rewritten content; budget / duplicate guard before apply |
| `meeting_confirm_write` | `POST /api/meeting/confirm`, `GET /meeting/confirm` | external Lark meeting doc prepend/writeback | confirmation artifact plus `decideWriteGuard(...)`; verifier precondition is summary/doc-entry completeness; budget / duplicate guard before writeback |
| `drive_organize_apply` | `POST /api/drive/organize/apply` | external Drive move task submission | same-scope preview/review prerequisite, executive task must already be `awaiting_review`, plus `decideWriteGuard(...)` and budget / duplicate guard |
| `wiki_organize_apply` | `POST /api/wiki/organize/apply` | external Wiki move task submission | same-scope preview/review prerequisite, executive task must already be `awaiting_review`, plus `decideWriteGuard(...)` and budget / duplicate guard |
| `cloud_doc_apply` | cloud-doc workflow task layer above drive/wiki apply | workflow owner over external Drive/Wiki apply | scope-bound executive task, preview-plan evidence, verifier gate on completion |
| `ingest_doc` | `ingestVerifiedDocumentToCompanyBrain(...)` internal path | internal mirror write into `company_brain_docs` | internal write guard allow, intake boundary classification, optional staged review state |
| `review_company_brain_doc` | `POST /agent/company-brain/review` | internal review-state write | lifecycle contract exists in `company-brain-lifecycle-contract.mjs`; review route is explicit |
| `check_company_brain_conflicts` | `POST /agent/company-brain/conflicts` | internal conflict-state/review-state write | explicit bounded route; overlap evidence drives `conflict_state` and may stage `conflict_detected` |
| `approval_transition_company_brain_doc` | `POST /agent/company-brain/approval-transition` | internal approval decision write | explicit bounded route; decision is separate from final apply |
| `apply_company_brain_approved_knowledge` | `POST /agent/company-brain/docs/:doc_id/apply` | internal apply into approved knowledge table | explicit lifecycle contract with `review_required=always`, `apply_gate=true`, allowed states `approved|applied` |

### Other grounded external mutation routes

These are real external write actions in code, but they are not yet part of one shared write-policy model:

- Drive:
  - `create_folder`
  - `move`
  - `delete`
- Wiki:
  - `create_wiki_node`
  - `move_wiki_node`
- Messages:
  - `message_reply`
  - `message_reply_card`
  - `message_reaction_create`
  - `message_reaction_delete`
- Calendar:
  - `calendar_create_event`
- Tasks:
  - `task_create`
  - `task_comment_create`
  - `task_comment_update`
  - `task_comment_delete`
- Bitable:
  - `bitable_app_create`
  - `bitable_app_update`
  - `bitable_table_create`
  - `bitable_record_create`
  - `bitable_record_update`
  - `bitable_record_delete`
  - `bitable_records_bulk_upsert`
- Sheets:
  - `spreadsheet_create`
  - `spreadsheet_update`
  - `spreadsheet_replace`
  - `spreadsheet_replace_batch`

These public HTTP write surfaces now also route their final external mutation through `executeLarkWrite(...)` so they share the same budget / dedupe boundary as the high-risk doc and meeting write family, even though they do not introduce a new preview/confirmation contract.

### Other grounded internal mutation routes

These are internal writes that should eventually speak the same policy language even though they are not external writes:

- `ingest_learning_doc`
- `update_learning_state`
- document lifecycle retry / lifecycle seed writes
- executive-task state transitions for `doc_rewrite` and `cloud_doc`

## B. Unified Policy Contract

### Minimum contract

Every write action should be able to emit the same bounded policy object:

```json
{
  "policy_version": "write_policy_v1",
  "source": "string",
  "owner": "string",
  "intent": "string",
  "action_type": "string",
  "external_write": "boolean",
  "confirm_required": "boolean",
  "review_required": "never|conditional|always",
  "scope_key": "string|null",
  "idempotency_key": "string|null"
}
```

### Field meaning

- `source`
  - stable origin of the write request
  - examples:
    - `agent_create_doc`
    - `doc_comment_rewrite`
    - `meeting_confirm`
    - `cloud_doc_workflow`
    - `document_lifecycle_verified_ingest`
- `owner`
  - subsystem that owns execution plus evidence collection for this write
  - examples:
    - `planner_agent`
    - `doc_rewrite_workflow`
    - `meeting_agent`
    - `cloud_doc_workflow`
    - `company_brain_write_intake`
- `intent`
  - stable reason the write is happening
  - examples:
    - `create_doc`
    - `rewrite_apply`
    - `meeting_writeback`
    - `drive_organize_apply`
    - `formal_company_brain_apply`
- `action_type`
  - normalized mutation category
  - preferred bounded values for current repo:
    - `create`
    - `update`
    - `replace`
    - `move`
    - `delete`
    - `reply`
    - `apply`
    - `writeback`
    - `ingest`
    - `review`
    - `approval_transition`
    - `upsert`
- `external_write`
  - `true` only when the mutation leaves the local runtime and changes an external system
  - `false` for internal company-brain / local-governance writes
- `confirm_required`
  - whether explicit operator/user confirmation is required before the mutation executes
- `review_required`
  - `never`:
    - no preview/review gate is expected before execution
  - `conditional`:
    - gate depends on mode, overlap, or promotion risk
  - `always`:
    - write cannot proceed without review/approval semantics
- `scope_key`
  - stable target scope used for same-target continuation, preview/apply pairing, and drift prevention
  - examples:
    - `drive:<folder_token>`
    - `wiki:<space_id|parent_node_token|space_name>`
    - `doc-rewrite:<document_id>`
    - `company-brain:<doc_id>`
- `idempotency_key`
  - request-level dedupe key when the same write may be retried or replayed
  - only explicit caller-provided keys participate in idempotency replay / duplicate detection; internal request fingerprints stay separate fallback dedupe evidence
  - may be `null` for one-shot confirmation-token paths

### Contract rules

1. This contract is metadata first, not a new public response shape.
2. A path is only considered policy-aligned when the same write action can produce this object deterministically from checked-in code.
3. Existing confirmation IDs and preview artifacts remain valid; they do not need to be replaced by `idempotency_key`.
4. Generic HTTP idempotency already exists for `POST|PUT|PATCH` when `idempotency_key` is provided; Phase 1 should reuse that instead of inventing a second store.

## C. Gap Analysis

### Summary

No current write path emits the full unified contract end-to-end today.

Current runtime is split across three partially overlapping governance shapes:

- planner/route governance
  - strongest on `create_doc`
- write-guard runtime gating
  - strongest on `document_comment_rewrite_apply`, `meeting_confirm_write`, `drive_organize_apply`, `wiki_organize_apply`
- company-brain lifecycle governance
  - strongest on review / conflict / approval / apply

### Per-path status

| path | already aligned | missing or inconsistent |
| --- | --- | --- |
| `create_doc` | `source`, `owner`, `intent` entry metadata already required; `external_write=true`; `confirm_required=true`; `review_required=conditional` | no explicit `action_type`; no stable `scope_key`; `idempotency_key` exists only as generic HTTP capability, not action contract |
| `update_doc` | explicit target + replace confirmation behavior already exists; company-brain intake already treats update as review-sensitive | no checked-in route contract; no explicit `source` or `owner`; `external_write` not declared; `confirm_required` is mode-dependent but not normalized; no `scope_key` |
| `document_comment_rewrite_apply` | explicit owner/workflow in `decideWriteGuard(...)`; confirmation + verifier gate already exists | no checked-in policy object; `source`, `intent`, and `review_required` stay implicit; `scope_key` exists only as workflow session key; no explicit idempotency policy |
| `meeting_confirm_write` | explicit owner/workflow in `decideWriteGuard(...)`; confirmation + verifier gate already exists | no checked-in policy object; `source`, `intent`, and `scope_key` are not normalized; no explicit idempotency policy |
| `drive_organize_apply` | explicit owner/workflow in `decideWriteGuard(...)`; preview/review prerequisite; stable `scope_key` already exists | no checked-in `source` / `intent`; `review_required` is behavioral, not contract-bound; no per-action policy object |
| `wiki_organize_apply` | explicit owner/workflow in `decideWriteGuard(...)`; preview/review prerequisite; stable `scope_key` already exists | same gaps as `drive_organize_apply` |
| `cloud_doc_apply` | workflow owner, scope, preview plan, and verifier gate already exist at executive-task layer | not surfaced as a shared route/action policy object; external write is indirect through drive/wiki apply |
| `ingest_doc` | internal owner/workflow exists; review/conflict requirement is already classified by helper | no checked-in policy contract; no stable `scope_key`; confirm/review fields are helper output, not shared write metadata |
| `review_company_brain_doc` / `check_company_brain_conflicts` / `approval_transition_company_brain_doc` / `apply_company_brain_approved_knowledge` | explicit lifecycle governance already exists | lifecycle contract does not yet carry `source`, `owner`, `intent`, `scope_key`, or idempotency language; it is a separate governance dialect |
| `ingest_learning_doc` / `update_learning_state` | explicit action names and bounded route shapes exist | no unified write-policy metadata; should remain out of Phase 1 |
| other external mutation routes | real external writes are grounded in code | almost all lack explicit preview/confirm/review metadata and should not be swept into Phase 1 until the contract primitive is proven on the higher-risk workflows above |

### Key structural gaps

1. The repo has shared write gating, but not shared write metadata.
2. `scope_key` is strong in cloud-doc, absent in most other writes.
3. `source` / `owner` / `intent` are strongest at planner create-doc entry, but mostly implicit elsewhere.
4. `review_required` exists today in three different forms:
   - planner governance metadata
   - write-guard prerequisite behavior
   - company-brain lifecycle rules
5. `idempotency_key` exists at generic HTTP level, but is not yet classified per action.

## Phase 1 Grounded Status

The current checked-in Phase 1 landing stays metadata-only.

It now adds one shared checked-in write-policy module and mounts that metadata on the requested high-risk write family without changing write behavior:

- shared source of truth:
  - `/Users/seanhan/Documents/Playground/src/write-policy-contract.mjs`
- route-contract mount:
  - `/Users/seanhan/Documents/Playground/src/http-route-contracts.mjs`
- log-surface mount:
  - `/Users/seanhan/Documents/Playground/src/http-server.mjs`
  - `/Users/seanhan/Documents/Playground/src/meeting-agent.mjs`
- diagnostics presence check:
  - `/Users/seanhan/Documents/Playground/src/control-diagnostics.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/control-diagnostics.mjs`

Grounded Phase 1 write-policy route surfaces are:

- `/api/doc/create`
- `/agent/docs/create`
- `/api/drive/organize/apply`
- `/api/wiki/organize/apply`
- `/api/doc/rewrite-from-comments` (apply metadata only; preview/apply runtime behavior stays unchanged)
- `/api/meeting/confirm`
- `/meeting/confirm`

The normalized Phase 1 action set exposed through diagnostics is:

- `create_doc`
- `drive_organize_apply`
- `wiki_organize_apply`
- `document_comment_rewrite_apply`
- `meeting_confirm_write`

## Phase 2 Grounded Status

Phase 2 now upgrades the same Phase 1 metadata family into bounded runtime governance without rewriting adapters, DB schema, or planner/lane flow.

Grounded Phase 2 files are:

- `/Users/seanhan/Documents/Playground/src/write-policy-enforcement.mjs`
- `/Users/seanhan/Documents/Playground/src/write-guard.mjs`
- `/Users/seanhan/Documents/Playground/src/http-route-contracts.mjs`
- `/Users/seanhan/Documents/Playground/src/http-server.mjs`
- `/Users/seanhan/Documents/Playground/src/meeting-agent.mjs`
- `/Users/seanhan/Documents/Playground/src/control-diagnostics.mjs`
- `/Users/seanhan/Documents/Playground/src/system-self-check.mjs`
- `/Users/seanhan/Documents/Playground/src/release-check.mjs`

### Phase 2 enforcement model

Every grounded Phase 1 write route now has one checked-in enforcement record:

```json
{
  "enforcement_version": "write_policy_enforcement_v1",
  "action": "string",
  "pathname": "string",
  "mode": "observe|warn|enforce",
  "checks": {
    "scope_key": "boolean",
    "idempotency_key": "boolean",
    "confirm_required": "boolean",
    "review_required": "boolean"
  }
}
```

This layer stays additive:

- `observe`
  - log only
- `warn`
  - log plus explicit warning event
- `enforce`
  - convert a passing write guard / route path into a bounded block

Current checked-in initial modes are:

- `create_doc`
  - `enforce`
- `meeting_confirm_write`
  - `warn`
- `drive_organize_apply`
  - `observe`
- `wiki_organize_apply`
  - `observe`
- `document_comment_rewrite_apply`
  - `warn`

Current checked-in violation family is bounded to:

- `missing_scope_key`
- `missing_idempotency_key`
- `confirm_required`
- `review_required`

Each violation record now also carries bounded structured detail:

- `reason`
  - `scope_key_unset`
  - `idempotency_key_unset`
  - `missing_confirmation`
  - `missing_review_evidence`
- `check`
  - the specific coverage gate that produced the violation
- `signals`
  - whether `scope_key`, `idempotency_key`, confirmation, and review evidence were present at runtime

### Phase 2 runtime mount

Current code truth is:

- `create_doc`
  - route-level enforcement in `/Users/seanhan/Documents/Playground/src/http-server.mjs`
  - stable fallback `scope_key = drive:root` when no folder token is supplied
- `drive_organize_apply`
  - policy evaluation is mounted through `/Users/seanhan/Documents/Playground/src/write-guard.mjs`
- `wiki_organize_apply`
  - policy evaluation is mounted through `/Users/seanhan/Documents/Playground/src/write-guard.mjs`
- `document_comment_rewrite_apply`
  - policy evaluation is mounted through `/Users/seanhan/Documents/Playground/src/write-guard.mjs`
- `meeting_confirm_write`
  - policy evaluation is mounted through `/Users/seanhan/Documents/Playground/src/write-guard.mjs` and `/Users/seanhan/Documents/Playground/src/meeting-agent.mjs`

This still does **not** introduce:

- a new approval runtime
- a new background worker path
- a DB-backed policy state store
- a planner-owned write-policy lane
- fail-close on every route at once

## D. Phase 1 Patch Plan

Phase 1 should be intentionally small and should not change write behavior.

### Phase 1 objective

Make the existing high-risk write paths speak one checked-in policy language without rewriting route logic, Lark adapters, or lifecycle state machines.

### Phase 1 patch set

1. add one checked-in source of truth for write-policy metadata
   - preferred new file:
     - `/Users/seanhan/Documents/Playground/src/write-policy-contract.mjs`
   - content:
     - policy version constant
     - bounded `review_required` enum
     - bounded `action_type` enum
     - helper to normalize/build a write-policy record

2. attach static policy records to current Phase 1 write routes
   - `create_doc`
   - `update_doc`
   - `document_comment_rewrite_apply`
   - `meeting_confirm_write`
   - `drive_organize_apply`
   - `wiki_organize_apply`
   - `apply_company_brain_approved_knowledge`
   - internal `ingest_doc` helper classification may also emit the same metadata shape

3. expose those policy records through checked-in route/contract mirrors
   - extend `/Users/seanhan/Documents/Playground/src/http-route-contracts.mjs`
   - keep `/Users/seanhan/Documents/Playground/docs/system/planner_contract.json` aligned for planner-owned actions
   - do not invent a second planner contract file

4. log the normalized write-policy record at the existing write decision points
   - reuse existing logger surfaces
   - do not change allow/deny logic in `write-guard.mjs`
   - do not change create guard semantics in `lark-write-guard.mjs`

5. add policy-presence diagnostics only after metadata exists
   - extend `/Users/seanhan/Documents/Playground/src/control-diagnostics.mjs`
   - verify that each Phase 1 write action still exposes a policy record

### Explicit non-goals for Phase 1

- no Lark SDK adapter rewrite
- no DB schema change
- no new approval runtime
- no new company-brain ownership layer
- no attempt to sweep every mutation route in one pass
- no public API response-shape change

## E. Files To Touch / Avoid

### Safe to touch in Phase 1

- `/Users/seanhan/Documents/Playground/docs/system/write_policy_unification.md`
- `/Users/seanhan/Documents/Playground/src/write-policy-contract.mjs`
- `/Users/seanhan/Documents/Playground/src/http-route-contracts.mjs`
- `/Users/seanhan/Documents/Playground/src/write-guard.mjs`
- `/Users/seanhan/Documents/Playground/src/lark-write-guard.mjs`
- localized write-entry sections in `/Users/seanhan/Documents/Playground/src/http-server.mjs`
- `/Users/seanhan/Documents/Playground/src/company-brain-write-intake.mjs`
- `/Users/seanhan/Documents/Playground/src/company-brain-lifecycle-contract.mjs`
- `/Users/seanhan/Documents/Playground/src/control-diagnostics.mjs`
- `/Users/seanhan/Documents/Playground/docs/system/planner_contract.json`
- `/Users/seanhan/Documents/Playground/docs/system/planner_contract_spec.md`

### Avoid in Phase 1

- `/Users/seanhan/Documents/Playground/src/lark-content.mjs`
  - keep low-level API adapters unchanged
- `/Users/seanhan/Documents/Playground/src/rag-repository.mjs`
  - do not change company-brain storage shape yet
- `/Users/seanhan/Documents/Playground/src/db.mjs`
  - no schema work for write-policy unification Phase 1
- `/Users/seanhan/Documents/Playground/src/executive-planner.mjs`
  - only touch later if planner-owned actions need expanded contract emission
- `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`
  - current task/control ownership should stay stable
- route families not in the Phase 1 focus set:
  - message write routes
  - calendar/task direct write routes
  - bitable/sheet mutation routes
  - drive/wiki simple create/move/delete routes
- `/Users/seanhan/Documents/Playground/openclaw-plugin`
  - plugin payload contracts should follow after HTTP/runtime metadata is stable

## Recommended Phase Order After This Design

1. Phase 1
   - metadata unification only
2. Phase 2
   - bounded enforcement for the Phase 1 set
   - diagnostics / self-check / release-check visibility for mode, coverage, and violation stats
3. Phase 3
   - rollout enforcement upgrades on already grounded Phase 1 routes
   - keep route-by-route diagnostics for:
     - enforcement mode
     - runtime violation rate
     - scope / idempotency coverage when trace evidence exists
     - bounded upgrade advice
4. Phase 4
   - add evidence / data layer hardening for rollout trust
   - split trace evidence by:
     - `traffic_source = real|test|replay`
     - `request_backed = true|false`
   - make warn -> enforce advice depend on trusted real request-backed data only
5. Phase 5
   - expand the same contract to remaining external mutation families
6. Phase 6
   - decide whether write-policy metadata should become part of planner/runtime public evidence surfaces

### Phase 3 rollout checkpoint

Current rollout target is intentionally narrow:

- `meeting_confirm_write`
  - target remains `enforce`
  - but the route should stay at `warn` until request-backed runtime evidence shows acceptable violation rate
  - optional emergency rollback path exists as env-controlled fail-open + alert, not as default behavior
- `document_comment_rewrite_apply`
  - upgraded from `observe` to `warn`
  - warning events now expose structured violation reasons and coverage signals
- `drive_organize_apply`
  - stays `observe`
  - diagnostics now surface route-level scope/idempotency coverage rates when trace evidence exists
- `wiki_organize_apply`
  - stays `observe`
  - diagnostics now surface route-level scope/idempotency coverage rates when trace evidence exists

### Phase 4 evidence-layer checkpoint

Current rollout decision now treats mixed trace evidence as unsafe by default.

Trusted rollout basis is narrowed to:

- `traffic_source = real`
- `request_backed = true`

Current warn -> enforce rule is intentionally fixed and additive:

- real request-backed sample size must be at least `20`
- real request-backed violation rate must stay below `1%`
- `confirm_required` / `review_required` coverage must already be wired in checked-in enforcement checks

This checkpoint still does **not**:

- change write behavior
- change enforcement logic
- change Lark adapter behavior
- auto-upgrade route modes

It only changes which evidence is considered credible enough for rollout advice.

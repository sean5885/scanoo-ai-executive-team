# Write Policy Unification

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This file mirrors the current write-governance convergence state.

It covers:

1. external Lark writes
2. internal company-brain governance writes that reuse the same policy language

## Current Write Topology

### External Lark Write Path

Current runtime chain:

1. action metadata from `/Users/seanhan/Documents/Playground/src/external-mutation-registry.mjs`
2. write policy from `/Users/seanhan/Documents/Playground/src/write-policy-contract.mjs`
3. route or lane builds canonical request
4. `/Users/seanhan/Documents/Playground/src/lark-mutation-runtime.mjs`
5. `/Users/seanhan/Documents/Playground/src/mutation-runtime.mjs`
6. `/Users/seanhan/Documents/Playground/src/execute-lark-write.mjs`

Current truth:

- this path is implemented
- `execute-lark-write.mjs` is the centralized external write bridge
- direct route-level `executeLarkWrite(...)` is no longer the primary checked-in pattern

### Internal Governance Write Path

Current runtime chain:

1. company-brain route or ingest/update boundary builds canonical request
2. `mutation-runtime.mjs` performs admission and verification
3. internal action writes review, conflict, approval, apply, or learning state

Current truth:

- implemented
- reuses policy language and mutation journal shape
- does not become an external Lark write

## Canonical Policy Object

Current shape:

```json
{
  "policy_version": "write_policy_v1",
  "source": "string",
  "owner": "string",
  "intent": "string",
  "action_type": "string",
  "external_write": true,
  "confirm_required": false,
  "review_required": "never|conditional|always",
  "scope_key": "string|null",
  "idempotency_key": "string|null"
}
```

Current code:

- `/Users/seanhan/Documents/Playground/src/write-policy-contract.mjs`
- `/Users/seanhan/Documents/Playground/tests/write-policy-contract.test.mjs`

## External Actions Already Unified

### Doc

- `create_doc`
- `update_doc`
- `document_comment_rewrite_apply`

### Drive and Wiki

- `drive_organize_apply`
- `wiki_organize_apply`
- `create_drive_folder`
- `move_drive_item`
- `delete_drive_item`
- `create_wiki_node`
- `move_wiki_node`

### Message, Calendar, Task

- `message_send`
- `message_reply`
- `message_reaction_create`
- `message_reaction_delete`
- `calendar_create_event`
- `task_create`
- `task_comment_create`
- `task_comment_update`
- `task_comment_delete`

### Bitable and Sheet

- `bitable_app_create`
- `bitable_app_update`
- `bitable_table_create`
- `bitable_record_create`
- `bitable_record_update`
- `bitable_record_delete`
- `bitable_records_bulk_upsert`
- `spreadsheet_create`
- `spreadsheet_update`
- `spreadsheet_replace`
- `spreadsheet_replace_batch`

### Meeting Capture

- `meeting_capture_create_document`
- `meeting_capture_document_update`
- `meeting_capture_document_delete`

## Internal Writes Already Speaking The Same Policy Language

- `ingest_doc`
- `review_company_brain_doc`
- `check_company_brain_conflicts`
- `approval_transition_company_brain_doc`
- `apply_company_brain_approved_knowledge`
- `ingest_learning_doc`
- `update_learning_state`

## Mutation Journal

`mutation-runtime.mjs` records a `mutation journal` in `meta.journal`.

Current fields:

- `action`
- `status`
- `started_at`
- optional `error`
- optional `rollback`
- optional `audit`

Current truth:

- this journal exists today
- rollback and nested audit evidence are already used by document create, comment rewrite apply, and meeting confirm write failure handling

## Implemented vs Policy-Only

### Implemented

- registry-backed external action inventory
- stable write policy object
- runtime admission and verification
- mutation journal output
- route-level write policy enforcement fixtures

### Policy-Only or Incomplete

- full repo-wide unification of every local mutation helper
- a single universal idempotency scope shared across HTTP and runtime-local caches
- a broader generic approval runtime outside the checked-in company-brain lifecycle path

## Historical Notes

- the frozen admission baseline in `mutation_admission_contract_v1.md` is historical, not the best summary of current runtime coverage
- [mutation_path_mapping_phase1.md](/Users/seanhan/Documents/Playground/docs/system/mutation_path_mapping_phase1.md) remains a useful baseline, but it is not the full current inventory

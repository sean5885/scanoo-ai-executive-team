# Mutation Path Mapping Phase1

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Status

This file is now a `historical baseline`, not the exhaustive current mutation inventory.

It remains useful because it records the original Phase 1 hook-point mapping for the highest-risk routes, but the current runtime has already moved to a broader registry-backed write family.

For current write truth, read:

- [write_policy_unification.md](/Users/seanhan/Documents/Playground/docs/system/write_policy_unification.md)
- [truth_matrix.md](/Users/seanhan/Documents/Playground/docs/system/truth_matrix.md)

## What Is Still Grounded Here

The following Phase 1 routes are still real and still use the mapped runtime entrypoints:

| Route family | Current action | Current state |
| --- | --- | --- |
| doc create | `create_doc` | implemented |
| doc update | `update_doc` | implemented |
| comment rewrite apply | `document_comment_rewrite_apply` | implemented |
| meeting confirm write | `meeting_confirm_write` | implemented |
| drive organize apply | `drive_organize_apply` | implemented |
| wiki organize apply | `wiki_organize_apply` | implemented |
| company-brain apply | `apply_company_brain_approved_knowledge` | implemented as internal governance write |

## What Changed After Phase 1

- external write action coverage is no longer limited to the original Phase 1 set
- registry-backed actions now also cover:
  - drive direct writes
  - wiki direct writes
  - message reply/send/reaction writes
  - calendar event create
  - task and task-comment writes
  - bitable writes
  - spreadsheet writes
  - meeting capture doc create/update/delete
- the primary current mapping source is `/Users/seanhan/Documents/Playground/src/external-mutation-registry.mjs`

## Phase 1 Hook-Point Summary

| Surface | Current hook point | Journal / evidence owner |
| --- | --- | --- |
| external Lark apply/write | `lark-mutation-runtime.mjs -> mutation-runtime.mjs` | mutation journal plus route/workflow evidence |
| company-brain governance write | `http-server.mjs -> mutation-runtime.mjs` | mutation journal plus company-brain lifecycle evidence |
| route preview/confirmation logic | route/workflow module | route/workflow state, not final execute authority |

## Deprecated Reading

Do not treat this file as:

- the full action inventory
- the full write-policy contract
- proof that only seven write actions are runtime-governed

That reading is outdated.

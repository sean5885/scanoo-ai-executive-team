# System Summary

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Canonical Current-Truth Set

Use these files first when you need the checked-in runtime truth:

- [modules.md](/Users/seanhan/Documents/Playground/docs/system/modules.md)
- [api_map.md](/Users/seanhan/Documents/Playground/docs/system/api_map.md)
- [data_flow.md](/Users/seanhan/Documents/Playground/docs/system/data_flow.md)
- [repo_map.md](/Users/seanhan/Documents/Playground/docs/system/repo_map.md)
- [write_policy_unification.md](/Users/seanhan/Documents/Playground/docs/system/write_policy_unification.md)
- [truth_matrix.md](/Users/seanhan/Documents/Playground/docs/system/truth_matrix.md)
- [open_questions.md](/Users/seanhan/Documents/Playground/docs/system/open_questions.md)

## Current System Shape

- local Node HTTP service with optional Lark long connection
- SQLite-backed auth, sync, retrieval, workflow, and company-brain-adjacent state
- planner-first `/answer` path with canonical `answer -> sources -> limitations` normalization and minimal partial-success decomposition at the answer boundary
- shared mutation runtime for external Lark writes and internal company-brain governance writes
- checked-in closed-loop executive orchestration with verifier, reflection, and improvement proposal paths
- bounded partial company-brain runtime:
  - verified mirror ingest
  - mirror list/search/detail
  - review/conflict/approval-transition/apply
  - approved derived read surface
  - simplified learning-state ingest/update

## Completed Milestones

- OAuth login, token refresh, and local-first encrypted token persistence are implemented.
- Drive, Wiki, Doc, Message, Calendar, Task, Bitable, and Spreadsheet surfaces are implemented behind the current HTTP runtime.
- Sync, FTS retrieval, and local semantic-lite ranking are implemented.
- `/answer` is planner-first; `answer-service.mjs` is secondary, not the public answer owner.
- Closed-loop task lifecycle, verifier gating, reflection, and improvement proposal persistence are checked in.
- Meeting, doc rewrite, and cloud-doc flows now pass through workflow-state and verifier gates instead of treating preview or raw write success as completion.
- Company-brain partial governance is checked in through mirror/read plus review/conflict/approval/apply and learning-state routes.
- Planner-visible skills are checked in with deterministic admission, fail-closed selection, and local-only telemetry adapters.

## Still Incomplete

- no background worker mesh, parallel supporting-agent execution, or autonomous company-brain server
- no tenant-wide memory graph or standalone company-brain-owned approval UI/runtime
- no targeted block-level doc mutation runtime; final doc materialization remains replace/update-adapter bounded
- no shared multi-runtime workflow store; task/workflow state remains local JSON storage
- no single universal idempotency layer across HTTP and mutation runtime scopes
- `http-server.mjs` remains the dominant integration surface

## Reconciliation Notes

Current outdated/conflicting readings that were reconciled in this pass:

- treating `company_brain` as entirely unimplemented
- treating read-runtime unification as still bypassed by the audited company-brain/review/verification/system-knowledge helper set
- treating [binding_session_workspace.md](/Users/seanhan/Documents/Playground/docs/system/binding_session_workspace.md) as proof that planner or company-brain surfaces do not exist

Keep these as reference-only context, not newcomer-first current truth:

- audit reports such as [Lobster AI Executive System Audit Report v1](/Users/seanhan/Documents/Playground/docs/system/Lobster%20AI%20Executive%20System%20Audit%20Report%20v1.md)
- `*_spec.md`, `*_refactor_plan.md`, `*_baseline*.md`, and `system_status_next_phase.md`
- release snapshots and thread inventories, unless you are tracing history rather than current behavior

## Remaining External Unknowns

- hosted deployment topology cannot be proven from this repo alone
- current Lark tenant-console scopes cannot be proven from this repo alone
- OpenClaw availability outside local/runtime assumptions cannot be proven from this repo alone

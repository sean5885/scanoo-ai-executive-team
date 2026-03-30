# Company Brain

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Scope

This repo has a bounded partial company-brain runtime.

It does not have:

- a tenant-wide memory graph
- a standalone autonomous company-brain server
- a human review UI
- a generic approval engine beyond the checked-in mirror/review/apply path

What is implemented today:

- verified mirror ingest into `company_brain_docs`
- mirror list/search/detail reads
- approved derived list/search/detail reads
- review/conflict/approval-transition/apply writes
- simplified learning-doc ingest and learning-state update

## Storage

SQLite tables in `/Users/seanhan/Documents/Playground/src/db.mjs`:

- `company_brain_docs`
- `company_brain_learning_state`
- `company_brain_review_state`
- `company_brain_approved_knowledge`

## Runtime Anchors

- `/Users/seanhan/Documents/Playground/src/http-server.mjs`
- `/Users/seanhan/Documents/Playground/src/read-runtime.mjs`
- `/Users/seanhan/Documents/Playground/src/company-brain-query.mjs`
- `/Users/seanhan/Documents/Playground/src/derived-read-authority.mjs`
- `/Users/seanhan/Documents/Playground/src/company-brain-write-intake.mjs`
- `/Users/seanhan/Documents/Playground/src/company-brain-review.mjs`
- `/Users/seanhan/Documents/Playground/src/company-brain-learning.mjs`
- `/Users/seanhan/Documents/Playground/src/company-brain-lifecycle-contract.mjs`
- `/Users/seanhan/Documents/Playground/src/mutation-runtime.mjs`

## Read Surface

Public minimal mirror routes:

- `GET /api/company-brain/docs`
- `GET /api/company-brain/docs/:doc_id`
- `GET /api/company-brain/search`

Planner/runtime routes:

- `GET /agent/company-brain/docs`
- `GET /agent/company-brain/docs/:doc_id`
- `GET /agent/company-brain/search`
- `GET /agent/company-brain/approved/docs`
- `GET /agent/company-brain/approved/docs/:doc_id`
- `GET /agent/company-brain/approved/search`

Current read truth:

- `read-runtime.mjs` is the single-authority read entry for audited company-brain flows
- `mirror` authority serves verified mirror list/search/detail through `company-brain-query.mjs`
- `derived` authority serves approved knowledge and internal learning-state reads through `derived-read-authority.mjs`
- mirror search joins `company_brain_docs` with mirrored `lark_documents.raw_text` plus optional `company_brain_learning_state`
- planner-facing reads return bounded summaries and learning metadata, not raw full text

## Governance and Learning Writes

Agent-facing governance routes:

- `POST /agent/company-brain/review`
- `POST /agent/company-brain/conflicts`
- `POST /agent/company-brain/approval-transition`
- `POST /agent/company-brain/docs/:doc_id/apply`
- `POST /agent/company-brain/learning/ingest`
- `POST /agent/company-brain/learning/state`

Current write truth:

- these routes use `runMutation(...)`
- these routes are internal governance writes, not external Lark writes
- `mutation-runtime.mjs` runs `knowledge_write_v1` pre/post verification around these writes
- verified doc ingest from `/api/doc/create` and `/api/doc/lifecycle/retry` is awaited inside the request lifecycle
- `/api/doc/update` now treats follow-up company-brain review sync as part of route success; sync failure returns an error instead of `ok=true`

## State Boundaries

Current state boundaries are explicit:

- `mirror` is not `approved`
- `approved` is not `applied`
- `learning_state` is not formal approved knowledge
- mirror ingest does not bypass review/conflict/approval/apply
- approved knowledge is stored separately in `company_brain_approved_knowledge`

`company-brain-memory-authority.mjs` and its guard/detector helpers are process-local only:

- they are not durable storage
- they are not a canonical read authority
- they are not part of the approval-governed company-brain path

## Reconciliation Status

This scan confirmed that the previously flagged helper set now re-enters `read-runtime.mjs` instead of bypassing it for audited company-brain/system-knowledge reads:

- `/Users/seanhan/Documents/Playground/src/company-brain-review.mjs`
- `/Users/seanhan/Documents/Playground/src/company-brain-learning.mjs`
- `/Users/seanhan/Documents/Playground/src/mutation-verifier.mjs`
- `/Users/seanhan/Documents/Playground/src/knowledge/knowledge-service.mjs`
- `/Users/seanhan/Documents/Playground/src/planner/knowledge-bridge.mjs`

No remaining public company-brain list/search/detail route was found bypassing `read-runtime.mjs` in this scan.

## Evidence

- `/Users/seanhan/Documents/Playground/tests/company-brain-query.test.mjs`
- `/Users/seanhan/Documents/Playground/tests/company-brain-write-intake.test.mjs`
- `/Users/seanhan/Documents/Playground/tests/company-brain-review-approval.test.mjs`
- `/Users/seanhan/Documents/Playground/tests/company-brain-lifecycle-contract.test.mjs`
- `/Users/seanhan/Documents/Playground/tests/read-runtime.test.mjs`
- `/Users/seanhan/Documents/Playground/tests/http-server.route-success.test.mjs`

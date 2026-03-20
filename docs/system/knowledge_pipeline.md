# Knowledge Pipeline

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Intake

- entry:
  - `/Users/seanhan/Documents/Playground/src/lark-sync-service.mjs`
- source discovery:
  - Drive tree scanning
  - Wiki spaces and nodes

## Parsing

- doc text extraction:
  - `/Users/seanhan/Documents/Playground/src/lark-connectors.mjs`
- supported content extraction:
  - docx text
- non-extracted or partial:
  - sheet
  - slides
  - bitable
  - generic file content

## Indexing

- schema:
  - `/Users/seanhan/Documents/Playground/src/db.mjs`
- repository:
  - `/Users/seanhan/Documents/Playground/src/rag-repository.mjs`
- document metadata is stored in:
  - `lark_sources`
  - `lark_documents`
- API-created docx files can also be inserted into the same temporary index directly from `/api/doc/create`, using normalized metadata `{ doc_id, source, created_at, creator: { account_id, open_id }, title, folder_token }`
- API-created docx files can also carry a minimal lifecycle in `lark_documents`: `status`, `indexed_at`, `verified_at`, `failure_reason`
- lifecycle rows can be queried from `/api/doc/lifecycle?status=...`, and only `index_failed` / `verify_failed` may be retried through `/api/doc/lifecycle/retry`
- `/api/doc/lifecycle/summary` returns the current count of each tracked lifecycle status for one account
- when an API-created doc reaches `status=verified`, a non-blocking mirror row is also upserted into `company_brain_docs` with `{ doc_id, title, source, created_at, creator }`; this is still only a minimal ingestion surface, not a full company-brain governance layer
- planner/runtime can now additionally create a simplified learned sidecar row in `company_brain_learning_state`, but only through explicit bounded agent actions; verified mirror ingest alone does not auto-promote documents into learned state
- the verified-ingest path now also runs a small internal write-intake policy helper:
  - no overlap signal -> direct mirror intake
  - title overlap -> mark review/conflict required for any later stable promotion
  - formal knowledge admission remains a separate approval-gated step and is not executed by the current ingest path
- `GET /api/company-brain/docs` can list that minimal mirror with `doc_id`, `title`, `source`, `created_at`, and `creator`
- `GET /api/company-brain/docs/:doc_id` can fetch one mirrored row with that same minimal shape
- `GET /api/company-brain/search?q=...` can search that mirror by `title` or `doc_id`, still returning the same minimal item shape
- planner-facing search/detail/list can now also read `learning_state`, and planner-facing search can match learned `key_concepts` / `tags`
- text chunks are stored in:
  - `lark_chunks`
  - `lark_chunks_fts`

## Chunking

- implemented in:
  - `/Users/seanhan/Documents/Playground/src/chunking.mjs`
- current style:
  - character-based chunking with overlap

## Embedding

- local semantic embedding pipeline now exists
- implemented in:
  - `/Users/seanhan/Documents/Playground/src/semantic-embeddings.mjs`
  - `/Users/seanhan/Documents/Playground/src/rag-repository.mjs`
- current search is:
  - SQLite FTS
  - local semantic embedding fallback
  - substring fallback

## Classification

- semantic file classification exists for organization workflows
- implemented in:
  - `/Users/seanhan/Documents/Playground/src/lark-drive-semantic-classifier.mjs`
- this is not used as a general retrieval ranking layer

## Conflict Detection

- no full semantic knowledge conflict detection pipeline found
- company-brain write-intake now has a bounded overlap heuristic based on existing read-side title matches

## Review Pipeline

- organization preview/apply exists
- comment rewrite preview/apply exists
- company-brain write-intake can now mark review-required candidates internally, but no standalone document-ingest approval pipeline exists

## Write-Back

- doc write-back exists through:
  - `/Users/seanhan/Documents/Playground/src/lark-content.mjs`
  - `/Users/seanhan/Documents/Playground/src/doc-comment-rewrite.mjs`
- direct doc creation through `/Users/seanhan/Documents/Playground/src/http-server.mjs` can now append a non-blocking `document_index` step into the same retrieval index; this still does not create a separate company-brain layer
- direct doc creation can additionally mirror verified API-created docs into `company_brain_docs`, but this remains a lightweight verified-doc registry rather than a canonical tenant-wide memory graph

## Current Gaps

- no company-brain canonical layer
- no source-of-truth approval governance for knowledge ingestion
- no full Bitable/Sheet content extraction into retrieval index
- no approval-governed learned-memory promotion path; current learning store is only a simplified sidecar

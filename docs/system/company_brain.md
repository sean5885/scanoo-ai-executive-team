# Company Brain

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Existence

- No full company_brain module or tenant-wide governance layer was found in this repo.
- A minimal mirror table now exists in `/Users/seanhan/Documents/Playground/src/db.mjs`:
  - `company_brain_docs`
- A separate simplified learning sidecar table now also exists:
  - `company_brain_learning_state`
- This table is only populated by verified API-created documents from `/Users/seanhan/Documents/Playground/src/http-server.mjs`.

## Storage Location

- SQLite:
  - `company_brain_docs`
  - `company_brain_learning_state`

## Used By Agents

- Current usage is still bounded, but planner-facing query paths now exist:
  - route-side non-blocking ingestion on verified API-created docs
  - a small internal write-intake policy helper that classifies direct mirror intake vs review/conflict-required promotion paths
  - read-only public HTTP routes:
    - `GET /api/company-brain/docs`
    - `GET /api/company-brain/docs/:doc_id`
    - `GET /api/company-brain/search?q=...`
  - planner-facing agent routes:
    - `GET /agent/company-brain/docs`
    - `GET /agent/company-brain/search`
    - `GET /agent/company-brain/docs/:doc_id`
    - `POST /agent/company-brain/learning/ingest`
    - `POST /agent/company-brain/learning/state`
  - `/Users/seanhan/Documents/Playground/src/company-brain-query.mjs`
    - centralizes planner-facing list/search/detail actions
    - joins `company_brain_docs` with mirrored `lark_documents.raw_text`
    - joins optional `company_brain_learning_state`
    - lets planner-side search rank against learned `key_concepts` / `tags` in addition to title/raw text
    - returns unified `{ success, data, error }` payloads
    - keeps results as structured summaries instead of raw full text
  - `/Users/seanhan/Documents/Playground/src/company-brain-learning.mjs`
    - derives deterministic `structured_summary`, `key_concepts`, and `tags`
    - writes simplified per-doc `learning_state`
    - does not perform approval/governance admission

## Completeness

- Minimal only.
- It stores a verified-doc mirror, not a canonical memory graph or approval-governed knowledge layer.
- the learning sidecar is also minimal; it is not approved long-term memory
- intake classification now exists, but formal approval/governance still does not.
- Public list/detail/search routes only return:
  - `doc_id`
  - `title`
  - `source`
  - `created_at`
  - `creator`
- Planner-facing agent routes additionally return:
  - structured `summary`
  - `learning_state`
  - search-time `match` metadata
  - no raw full-text body

## Knowledge Sources That Do Exist

This repo does have a knowledge pipeline, but it is document sync and retrieval, not company-brain governance.

Observed sources:

- Lark Drive
- Lark Wiki
- Lark docx documents
- local SQLite index and chunk store

## Indexing

- yes, but only for synced document knowledge
- implemented through:
  - `/Users/seanhan/Documents/Playground/src/db.mjs`
  - `/Users/seanhan/Documents/Playground/src/rag-repository.mjs`
  - `/Users/seanhan/Documents/Playground/src/lark-sync-service.mjs`

## Conclusion

At scan time, this repo still does not have a full company_brain governance system. It now has a small `company_brain_docs` mirror for verified API-created docs and a separate simplified `company_brain_learning_state` sidecar for planner-facing learning metadata, but retrieval knowledge and lifecycle/indexing remain the primary implemented layers.

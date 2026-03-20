# Company Brain

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Existence

- No full company_brain module or tenant-wide governance layer was found in this repo.
- A minimal mirror table now exists in `/Users/seanhan/Documents/Playground/src/db.mjs`:
  - `company_brain_docs`
- This table is only populated by verified API-created documents from `/Users/seanhan/Documents/Playground/src/http-server.mjs`.

## Storage Location

- SQLite:
  - `company_brain_docs`

## Used By Agents

- No direct agent-facing query path was found.
- Current usage is still minimal:
  - route-side non-blocking ingestion on verified API-created docs
  - a read-only HTTP list route: `GET /api/company-brain/docs`
  - a read-only HTTP detail route: `GET /api/company-brain/docs/:doc_id`
  - a read-only HTTP search route: `GET /api/company-brain/search?q=...`

## Completeness

- Minimal only.
- It stores a verified-doc mirror, not a canonical memory graph or approval-governed knowledge layer.
- The list route only returns:
- The list/detail routes only return:
- The list/detail/search routes only return:
  - `doc_id`
  - `title`
  - `source`
  - `created_at`
  - `creator`

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

At scan time, this repo still does not have a full company_brain governance system. It now has a small `company_brain_docs` mirror for verified API-created docs, but retrieval knowledge and lifecycle/indexing remain the primary implemented layers.

# Company Brain

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Existence

- No company_brain module or repository was found in this repo.

## Storage Location

- Not applicable.

## Used By Agents

- Not applicable.

## Completeness

- Not applicable.

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

If future work adds a canonical knowledge layer, it should be documented separately from the current sync/RAG system. At scan time, this repo has retrieval knowledge, not company_brain.

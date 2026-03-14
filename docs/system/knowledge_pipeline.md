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

- no explicit knowledge conflict detection pipeline found

## Review Pipeline

- organization preview/apply exists
- comment rewrite preview/apply exists
- no document-ingest approval pipeline found

## Write-Back

- doc write-back exists through:
  - `/Users/seanhan/Documents/Playground/src/lark-content.mjs`
  - `/Users/seanhan/Documents/Playground/src/doc-comment-rewrite.mjs`

## Current Gaps

- no company-brain canonical layer
- no source-of-truth approval governance for knowledge ingestion
- no full Bitable/Sheet content extraction into retrieval index

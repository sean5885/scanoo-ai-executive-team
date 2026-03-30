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
- local helper:
  - `/Users/seanhan/Documents/Playground/src/knowledge/doc-index.mjs`
  - `/Users/seanhan/Documents/Playground/src/knowledge/doc-loader.mjs`
  - `/Users/seanhan/Documents/Playground/src/knowledge/rank-results.mjs`
  - `/Users/seanhan/Documents/Playground/src/knowledge/snippet-cleaner.mjs`
  - `/Users/seanhan/Documents/Playground/src/knowledge/knowledge-service.mjs`
- document metadata is stored in:
  - `lark_sources`
  - `lark_documents`
- `/Users/seanhan/Documents/Playground/src/knowledge/doc-index.mjs` now provides a small in-memory helper with `{ version, docs[] }`, `addDoc`, `findDocById`, case-sensitive `searchDocs`, and case-insensitive `searchDocsByKeyword`
- `/Users/seanhan/Documents/Playground/src/knowledge/doc-loader.mjs` now provides `loadDocsFromDir(dir)`, which scans one local directory, reads `.md` files, and loads them into that in-memory index as `company_brain` doc types
- `/Users/seanhan/Documents/Playground/src/knowledge/rank-results.mjs` now provides a small local ranking helper: `scoreDoc(doc, keyword)` scores one in-memory document by direct keyword presence, earlier first-hit position, repeated exact-hit count, and a small boundary-like boost when the keyword appears adjacent to spaces; for BD-flavored lookups (`bd`, `商機`, `business`, `管理`, `management`, and mixed forms such as `BD 商機管理`) it also adds a deterministic BD-domain boost over docs that carry more BD flow evidence (`BD / 商機 / 客戶 / 跟進 / demo / 提案`, `planner-bd-flow.mjs`, `closed_loop.md`, `planner_agent_alignment.md`) and soft-penalizes broad inventory/pipeline docs (`knowledge_pipeline.md`, `modules.md`, `system_state_snapshot.md`) so generic docs stop crowding out BD-flow snippets; `rankResults(docs, keyword)` sorts an input doc list by that descending score, then uses `doc.id` as a deterministic tie-breaker before returning the reordered documents
- `/Users/seanhan/Documents/Playground/src/knowledge/snippet-cleaner.mjs` now provides a line-aware local snippet-cleanup helper: `cleanSnippet(text, keyword)` unwraps Markdown links/images while keeping visible text, strips heading markers, list shells, stray backticks, absolute local paths, navigation lines such as `Back to README.md`, checkpoint-style metadata lines, and module/title prefixes such as `runtime / monitoring - Purpose:`; it then drops dangling or path-only lines, merges the remaining meaningful lines, prefers the sentence segment containing the active keyword when available, trims broken leading/trailing fragments, and clamps the final preview near a sentence/line boundary at roughly 220 characters. This helper is now reused by canonical read-source shaping in `/Users/seanhan/Documents/Playground/src/read-source-schema.mjs`; `read-runtime.mjs` also reapplies that canonical shaping to successful `search_knowledge_base` results before returning them, including `reader_overrides`, so search-backed planner/skill answers cannot leak raw README/path/link snippet noise through the answer pipeline. This still is not wired into SQLite persistence or company-brain routes
- `/Users/seanhan/Documents/Playground/src/knowledge/system-knowledge-core.mjs` now holds the pure checked-in `docs/system` query helpers: it lazily loads the local markdown index once per process, ranks keyword hits through `rank-results.mjs`, builds block-first then sentence fallback snippets through `snippet-cleaner.mjs`, expands the same checked-in alias/normalization sets for `querySystemKnowledgeWithContext(keyword)`, filters out low-value fragments, deduplicates by `id`, and round-robins the bounded per-query result buckets before returning the final top-3 preview rows
- when that local `docs/system` index is first loaded, the same module now also mirrors the in-process cached index through `/Users/seanhan/Documents/Playground/src/memory-write-guard.mjs` into the process-local company-brain memory authority under `system_knowledge:index`; this is an ephemeral cache mirror only and not part of SQLite or company-brain governance
- `/Users/seanhan/Documents/Playground/src/knowledge/knowledge-service.mjs` now keeps the same synchronous public helper surface (`queryKnowledge`, `queryKnowledgeWithSnippet`, `queryKnowledgeWithContext`, `filterKnowledgeContextResults`) but the query calls no longer read the local helper directly; they now re-enter `/Users/seanhan/Documents/Playground/src/read-runtime.mjs` through bounded internal index-authority actions (`query_system_knowledge`, `query_system_knowledge_with_snippet`, `query_system_knowledge_with_context`) and unwrap the returned `items[]` while preserving the previous sync API for callers and tests
- `/Users/seanhan/Documents/Playground/src/llm/generate-text.mjs` now provides a small shared text-generation helper for local modules: `generateText({ systemPrompt, prompt, sessionIdSuffix, temperature, topP, signal })` uses the repo-wide text-model settings (`MINIMAX_TEXT_MODEL` -> legacy `LLM_MODEL` fallback) and the normal direct-LLM/OpenClaw path, so planner-side helpers can reuse one stable text-generation contract instead of duplicating provider wiring
- `/Users/seanhan/Documents/Playground/src/planner/llm-summary.mjs` now provides a planner-side LLM summary helper: `summarizeWithMinimax({ keyword, results })` turns the filtered local `{ id, snippet }` preview rows into a concise answer that asks the model to append bracketed source indices such as `[1][2]` at sentence end through `/Users/seanhan/Documents/Playground/src/llm/generate-text.mjs`, uses `temperature: 0` for that summary request, and fail-soft falls back to the deterministic local formatter when generation fails or returns empty text
- `/Users/seanhan/Documents/Playground/src/config/tech-terms.mjs` now provides the shared planner-side technical-term registry used by local keyword extraction helpers; the current checked-in list includes system/process/module terms such as `routing`, `planner`, `verification`, `workflow`, `knowledge`, `okr`, `delivery`, plus entry-platform variants such as `entry`, `entry os`, and `scanoo entry os`
- `/Users/seanhan/Documents/Playground/src/utils/pick-tech-term.mjs` now provides a small deterministic registry matcher: `pickTechTerm(question)` lowercases the input, scans the shared `TECH_TERMS` registry longest-term-first so broader substrings like `entry` do not outrank `entry os`, and returns the first matching technical term or `null`
- `/Users/seanhan/Documents/Playground/src/planner/query-rewrite.mjs` now provides a tiny planner-side deterministic query-expansion helper: `rewriteQuery(keyword, question)` first expands checked-in aliases for `routing`, `planner`, `sop`, and `okr`; when no mapped explicit keyword is given, it reuses `pickTechTerm(question)` and returns the mapped alias list for that detected term; otherwise it fail-soft returns `[keyword]` or `[]`
- `/Users/seanhan/Documents/Playground/src/planner/intent-parser.mjs` now provides a planner-side fail-soft keyword extractor: `parseIntent(question)` first checks that shared technical-term registry through `pickTechTerm(question)` so obvious system/process/module terms win before brand-like wording, then falls back to the shared text-generation helper for one document-search keyword, normalizes the reply down to the first keyword, and returns `null` when the input is empty or generation fails
- `/Users/seanhan/Documents/Playground/src/planner/knowledge-bridge.mjs` now provides a tiny planner-side adapter over that same read-runtime-backed helper: async `plannerAnswer({ keyword, question })` prefers an explicit `keyword`, otherwise tries `parseIntent(question)`, expands the final keyword through `rewriteQuery(finalKeyword, question)`, queries `/Users/seanhan/Documents/Playground/src/knowledge/knowledge-service.mjs` once per expanded key through synchronous `queryKnowledgeWithContext(...)`, deduplicates merged rows by `id`, asks `summarizeWithMinimax({ keyword: finalKeyword, results })` for a short summary, and fail-soft falls back to the deterministic local formatter while returning `{ answer, count, sources }`, where `sources` mirrors the deduplicated rows as `{ id, index, snippet }` but now runs each returned snippet through `/Users/seanhan/Documents/Playground/src/knowledge/snippet-cleaner.mjs` with the final keyword before exposure; when neither the input keyword nor parsed question yields a usable search term it returns `{ answer: "請提供查詢關鍵字", count: 0, sources: [] }`
- `/Users/seanhan/Documents/Playground/src/planner/answer-builder.mjs` now provides the deterministic planner-side formatter used as the local fallback: `buildAnswer(keyword, results)` converts the local `{ id, snippet }` preview rows into a fixed Chinese summary string, cleans snippet previews by dropping inline code spans and local absolute-path fragments, normalizing whitespace, trimming non-word leading noise, removing trailing separator noise, tightening stray spaces before punctuation, collapsing repeated commas, and trimming dangling trailing conjunction/placeholder tails such as an empty `supports ... and` fragment, renders a numbered list prefixed by a count-based intro, and returns a fixed no-result message when there are no matches
- this ranking helper is not connected to SQLite, sync ingestion, planner/company-brain routes, or approved-knowledge governance; it is only a local utility module at this time
- this snippet-cleaner helper is likewise not connected to SQLite, sync ingestion, planner/company-brain persistence/governance, or approved-knowledge governance; it is only a local utility module at this time
- these local doc-index / doc-loader / system-knowledge-core helpers are not connected to SQLite, sync ingestion, planner/company-brain routes, or approved-knowledge governance; they are only local utility modules at this time, even though `knowledge-service.mjs` now reaches them through the shared read-runtime boundary
- the planner bridge is likewise only a local utility module at this time; it is not wired into `executive-planner.mjs`, planner contract routing, or company-brain read/write governance paths
- the planner query rewrite helper is likewise only a local utility module at this time; it is not wired into `executive-planner.mjs`, planner contract routing, or company-brain read/write governance paths
- the planner answer builder is likewise only a local utility module at this time; it is not wired into `executive-planner.mjs`, planner contract routing, or company-brain read/write governance paths
- API-created docx files can also be inserted into the same temporary index directly from `/api/doc/create`, using normalized metadata `{ doc_id, source, created_at, creator: { account_id, open_id }, title, folder_token }`
- API-created docx files can also carry a minimal lifecycle in `lark_documents`: `status`, `indexed_at`, `verified_at`, `failure_reason`
- lifecycle rows can be queried from `/api/doc/lifecycle?status=...`, and only `index_failed` / `verify_failed` may be retried through `/api/doc/lifecycle/retry`
- `/api/doc/lifecycle/summary` returns the current count of each tracked lifecycle status for one account
- when an API-created doc reaches `status=verified`, `/api/doc/create` and `/api/doc/lifecycle/retry` now await the mirror ingest plus the follow-up review sync before returning full success; the mirrored row still uses `{ doc_id, title, source, created_at, creator }` and remains only a minimal ingestion surface, not a full company-brain governance layer
- planner/runtime can now additionally create a simplified learned sidecar row in `company_brain_learning_state`, but only through explicit bounded agent actions; verified mirror ingest alone does not auto-promote documents into learned state
- `/Users/seanhan/Documents/Playground/src/company-brain-learning.mjs` now also mirrors the latest persisted per-doc learning state into the same process-local memory authority under `company_brain_learning:${account_id}:${doc_id}` after SQLite upsert; this helper does not replace the durable learning-state store
- review/approval persistence is now stored separately from both mirror and learning:
  - `company_brain_review_state`
  - `company_brain_approved_knowledge`
- only documents with `review_status=approved` may be promoted into `company_brain_approved_knowledge`; mirror or learning state alone does not count as formal knowledge
- the verified-ingest path now also runs a small internal write-intake policy helper:
  - no overlap signal -> direct mirror intake
  - title overlap -> mark review/conflict required for any later stable promotion and persist `review_status=conflict_detected`
  - update/promotion-like paths -> persist `review_status=pending_review`
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
- overlap candidates now persist into `company_brain_review_state` as `conflict_detected`, so they cannot be promoted directly into formal knowledge

## Review Pipeline

- organization preview/apply exists
- comment rewrite preview/apply exists
- company-brain write-intake can now persist minimum review states:
  - `pending_review`
  - `conflict_detected`
  - `approved`
  - `rejected`
- no standalone document-ingest approval route or UI exists yet; review/approval remains helper-driven

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
- no standalone approval runtime, approval UI, or verifier-owned promotion flow; current approved layer is a minimal persistence boundary

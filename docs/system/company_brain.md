# Company Brain

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Existence

- No full company_brain module or tenant-wide governance layer was found in this repo.
- A minimal mirror table now exists in `/Users/seanhan/Documents/Playground/src/db.mjs`:
  - `company_brain_docs`
- A separate simplified learning sidecar table now also exists:
  - `company_brain_learning_state`
- A minimal review/approval persistence layer now also exists:
  - `company_brain_review_state`
  - `company_brain_approved_knowledge`
- This table is only populated by verified API-created documents from `/Users/seanhan/Documents/Playground/src/http-server.mjs`.
- Verified mirror ingest now also passes through `/Users/seanhan/Documents/Playground/src/mutation-runtime.mjs` before the `company_brain_docs` upsert is accepted, and any follow-up review-state staging from that ingest now re-enters the same runtime instead of writing directly from the route helper.

## Storage Location

- SQLite:
  - `company_brain_docs`
  - `company_brain_learning_state`
  - `company_brain_review_state`
  - `company_brain_approved_knowledge`

## Used By Agents

- Current usage is still bounded, but planner-facing query paths now exist:
  - route-side non-blocking ingestion on verified API-created docs
  - a small write-intake policy helper that classifies direct mirror intake vs review/conflict-required promotion paths
  - read-only public HTTP routes:
    - `GET /api/company-brain/docs`
    - `GET /api/company-brain/docs/:doc_id`
    - `GET /api/company-brain/search?q=...`
  - planner-facing agent routes:
    - `GET /agent/company-brain/docs`
    - `GET /agent/company-brain/search`
    - `GET /agent/company-brain/docs/:doc_id`
    - `GET /agent/company-brain/approved/docs`
    - `GET /agent/company-brain/approved/search`
    - `GET /agent/company-brain/approved/docs/:doc_id`
    - `POST /agent/company-brain/review`
    - `POST /agent/company-brain/conflicts`
    - `POST /agent/company-brain/approval-transition`
    - `POST /agent/company-brain/docs/:doc_id/apply`
    - `POST /agent/company-brain/learning/ingest`
    - `POST /agent/company-brain/learning/state`
  - `/Users/seanhan/Documents/Playground/src/company-brain-query.mjs`
    - centralizes planner-facing list/search/detail actions
    - joins `company_brain_docs` with mirrored `lark_documents.raw_text`
    - joins optional `company_brain_learning_state`
    - lets planner-side search rank with a composite score over keyword match, semantic-lite similarity, learned `key_concepts` / `tags`, and document recency from mirror timestamps
    - supports `top_k` search limiting with a default of `5` while keeping `limit` as a compatibility alias
    - returns unified `{ success, data, error }` payloads
    - keeps results as structured summaries instead of raw full text
  - `/Users/seanhan/Documents/Playground/src/read-runtime.mjs`
    - is now the unified read-runtime entry for single-authority reads
    - accepts canonical read requests `{ action, account_id, payload, context }`
    - also exposes a separate `primary_authority = "index"` branch for retrieval/search-hit reads backed by `/Users/seanhan/Documents/Playground/src/index-read-authority.mjs`
    - keeps verified-doc mirror list/search/detail on `primary_authority = "mirror"`
    - now exposes a separate `primary_authority = "derived"` branch for approved knowledge and learning-state reads backed by `/Users/seanhan/Documents/Playground/src/derived-read-authority.mjs`
    - also exposes a separate `primary_authority = "live"` branch for direct doc/comment reads backed by `lark-content.mjs`, but only when `freshness = "live_required"`
    - routes `/search` plus answer-service retrieval through the index branch while still keeping one single primary authority per read
    - now also provides bounded sync helpers for internal mirror/derived/index runtime callers that must keep existing synchronous contracts
    - delegates mirror list/search/detail plus internal mirror doc-record reads to `company-brain-query.mjs`
    - delegates approved list/search/detail, internal learning-state detail/list reads, and internal approval-state reads to `derived-read-authority.mjs`
    - delegates local checked-in `docs/system` keyword/snippet/context search actions to the index branch through `index-read-authority.mjs`
    - returns one canonical runtime envelope and does not mix index, mirror, live, or derived fallback in the same read
  - `/Users/seanhan/Documents/Playground/src/derived-read-authority.mjs`
    - owns the current derived readers for:
      - approved company-brain list/search/detail
      - internal learning-state list/detail
    - keeps the derived branch on one fixed `primary_authority = "derived"`
  - `/Users/seanhan/Documents/Playground/src/company-brain-learning.mjs`
    - derives deterministic `structured_summary`, `key_concepts`, and `tags`
    - writes simplified per-doc `learning_state`
    - also mirrors the latest persisted per-doc learning state into the process-local memory authority under `company_brain_learning:${account_id}:${doc_id}`
    - does not perform approval/governance admission
  - `/Users/seanhan/Documents/Playground/src/company-brain-review.mjs`
    - persists bounded per-doc review state with:
      - `pending_review`
      - `conflict_detected`
      - `approved`
      - `rejected`
    - exposes bounded actions for:
      - review staging
      - conflict checking
      - approval decision transition
      - explicit approved-knowledge apply
    - promotes only `approved` review results into `company_brain_approved_knowledge`
    - keeps approval storage separate from both mirror and learning sidecar
  - `/Users/seanhan/Documents/Playground/src/mutation-runtime.mjs`
    - is now the shared write entry for agent-facing company-brain review / conflict / approval-transition / apply / learning-ingest / learning-state-update writes
    - also backs the follow-up review-state sync that can happen after verified mirror ingest and document update
    - runs `knowledge_write_v1` pre/post verification around those internal writes
    - confirms review/apply/learning writes by checking durable SQLite state after execute, and allows `conflict_check` / intake review sync to skip post-verifier only when no review-state mutation is required
  - `/Users/seanhan/Documents/Playground/src/company-brain-memory-authority.mjs`
    - exposes a tiny process-local `{ writeMemory, readMemory }` helper backed by `globalThis.__company_brain_memory__`
    - no checked-in runtime route, planner flow, read-runtime branch, mutation-runtime path, or approval-governed caller currently imports it directly
    - its contents are lost on process restart and it is not part of the current SQLite-backed company-brain persistence boundary
  - `/Users/seanhan/Documents/Playground/src/memory-write-guard.mjs`
    - exposes `guardedMemorySet(...)` as a tiny wrapper over the process-local memory authority
    - currently normalizes key/source and is used only by local process-memory helper paths
  - `/Users/seanhan/Documents/Playground/src/company-brain-query.mjs`
    - now also exposes approved-knowledge list/search/detail actions that only read from `company_brain_approved_knowledge`
    - keeps the existing mirror read-side actions unchanged and separate

## Completeness

- Minimal only.
- It stores a verified-doc mirror, not a canonical memory graph or approval-governed knowledge layer.
- the learning sidecar is also minimal; it is not approved long-term memory
- a minimal agent-facing review/conflict/approval/apply runtime now exists, and its current internal write gating is routed through mutation-runtime rather than route-local allow/deny
- the simplified learning sidecar write routes now also use that same runtime boundary instead of direct route-local persistence
- the process-local `company-brain-memory-authority.mjs` helper is not a canonical memory authority, not durable storage, and not part of the approval-governed company-brain path
- `memory-write-guard.mjs` only wraps process-local cache writes; it does not replace SQLite learning-state persistence, review/apply flows, or approved-knowledge admission
- there is still no standalone company-brain-owned verifier, human review UI, or semantic conflict resolver
- Public list/detail/search routes only return:
  - `doc_id`
  - `title`
  - `source`
  - `created_at`
  - `creator`
- Planner-facing agent routes additionally return:
  - structured `summary`
  - `learning_state`
  - search-time `match` metadata including composite `score` plus simplified `ranking_basis`
  - no raw full-text body
- approved company-brain routes now return through the same canonical envelope, but their read authority is `derived` rather than `mirror`
- planner doc formatting now also stays mirror-only for the same read and no longer supplements company-brain detail reads with `/api/doc/read`
- approved knowledge is now stored separately and can only be queried through approved-only agent/query routes after explicit review approval plus apply

## Final Audit Prep

The previously flagged bypass callers now re-enter `read-runtime.mjs` through bounded internal actions:

- mutation-side company-brain lifecycle helpers:
  - `/Users/seanhan/Documents/Playground/src/company-brain-review.mjs`
  - `/Users/seanhan/Documents/Playground/src/company-brain-learning.mjs`
  - `/Users/seanhan/Documents/Playground/src/mutation-verifier.mjs`
- local checked-in docs/system knowledge helpers:
  - `/Users/seanhan/Documents/Playground/src/knowledge/knowledge-service.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner/knowledge-bridge.mjs`

Current status in this scan:

- no remaining caller from those five modules was found reading mirror/derived/index state without first entering `read-runtime.mjs`
- write-side persistence still happens in the owning write modules or repository helpers after the runtime-gated read step; `read-runtime.mjs` remains a read boundary, not a write runtime

No remaining public company-brain list/search/detail route was found bypassing `read-runtime.mjs` in this scan.

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

At scan time, this repo still does not have a full company_brain governance system. It now has a small `company_brain_docs` mirror for verified API-created docs, a separate simplified `company_brain_learning_state` sidecar for planner-facing learning metadata, and a minimal agent-facing `review -> conflict -> approval-transition -> apply` runtime backed by `company_brain_review_state` plus `company_brain_approved_knowledge`. Retrieval knowledge and lifecycle/indexing remain the primary implemented layers, and company-brain governance is still bounded rather than full-fidelity.

The current primary system is Playground's request-triggered flow, not ai-server background automation.

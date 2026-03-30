# Data Flow

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Scope

This file mirrors the current data paths that are actually implemented.

The three main paths are:

1. `read`
2. `write`
3. `answer`

Sync, meeting, comment-rewrite, and the minimal skill layer are adjacent workflows built on top of those paths.

## 1. Read Path

### 1A. Retrieval Index Read

Current path:

1. request enters `/search`, planner-side retrieval, or a system-knowledge helper
2. runtime builds a canonical read request
3. `/Users/seanhan/Documents/Playground/src/read-runtime.mjs` resolves `primary_authority=index`
4. `index-read-authority.mjs` reads the local index or system-knowledge helper
5. result is normalized into the canonical read result shape

Current truth:

- this path is implemented
- it does not silently fall back to mirror/live on the same request
- public retrieval snippets are normalized through the read-source schema before leaving the runtime

### 1B. Company-Brain Mirror Read

Current path:

1. request enters `/api/company-brain/*` or `/agent/company-brain/*`
2. runtime builds a canonical read request
3. `read-runtime.mjs` resolves `primary_authority=mirror`
4. `company-brain-query.mjs` reads `company_brain_docs`
5. result is returned as mirror data plus derived summary/learning metadata where available

Current truth:

- this is a read-side mirror path
- it is not the same thing as approved knowledge
- it is not a generic approval runtime

### 1C. Approved Knowledge Read

Current path:

1. request enters `/agent/company-brain/approved/*`
2. runtime builds a canonical read request
3. `read-runtime.mjs` resolves `primary_authority=derived`
4. `derived-read-authority.mjs` reads the approved/applied view
5. result is returned in the same bounded read envelope

Current truth:

- approved knowledge is a separate derived surface
- it only becomes visible after the checked-in review/approval/apply path has completed

### 1D. Live Lark Read

Current path:

1. request enters `/api/doc/read` or comment-read helpers
2. runtime builds a canonical read request
3. `read-runtime.mjs` resolves `primary_authority=live`
4. `lark-content.mjs` fetches the live document or comment list

Current truth:

- this path is explicit and live-only
- it is not automatically supplemented by mirror data in the same route

## 2. Write Path

### 2A. External Lark Write Path

Current path:

1. route or lane code determines the write action
2. code builds:
   - a canonical mutation request
   - a write policy record
3. external action metadata comes from `/Users/seanhan/Documents/Playground/src/external-mutation-registry.mjs`
4. `lark-mutation-runtime.mjs` invokes `runMutation(...)`
5. `mutation-runtime.mjs` performs:
   - admission
   - pre-verification
   - execute
   - post-verification
   - mutation journal generation
6. `execute-lark-write.mjs` performs the actual Lark mutation under runtime guard context
7. result returns to the route or lane

Current truth:

- this path is implemented
- `create_doc` and `/agent/docs/create` stay in this document/runtime write family
- direct `executeLarkWrite(...)` from route or lane modules is no longer the checked-in primary pattern
- runtime-local idempotency exists in `mutation-runtime.mjs`
- persisted HTTP idempotency also exists at the HTTP layer

### 2B. Verified Mirror Ingest Path

Current path:

1. controlled document create/update path advances lifecycle state
2. when lifecycle reaches `verified`, mirror ingest builds a canonical internal request
3. `runMutation(...)` is used for admission and verification
4. internal action upserts the verified mirror row into `company_brain_docs`
5. intake helper classifies whether follow-up review/conflict staging is required

Current truth:

- this is implemented
- this is the bridge from document flow into company-brain mirror state
- verified mirror ingest and approved/apply are distinct states
- mirror ingest is not formal approval

### 2C. Internal Company-Brain Governance Write Path

Current path:

1. explicit company-brain governance route builds a canonical request
2. `runMutation(...)` is used for admission and verification
3. internal action writes review state, conflict state, approval state, learning state, or applied knowledge state

Current truth:

- this is implemented
- this is an internal governance write path, not an external Lark write path
- it is downstream of document flow plus mirror ingest, not a replacement for them
- approved/apply remains separate from both mirror and learning-state writes

## 3. Answer Path

Current public `/answer` path:

1. request enters `GET /answer`
2. `http-server.mjs` calls `executePlannedUserInput(...)`
3. `executive-planner.mjs` resolves planner action or controlled failure
4. planner reads and tool results remain internal runtime state
5. `user-response-normalizer.mjs` converts the planner envelope into the public response shape:
   - `answer`
   - `sources`
   - `limitations`
6. `answer-source-mapper.mjs` converts canonical source objects into bounded public `sources[]` lines

Current truth:

- this path is implemented
- `/answer` is planner-first, not answer-service-first
- answer evidence is surfaced through canonical source mapping before public rendering

### Secondary Retrieval-Answer Helper

Current secondary path:

1. `answer-service.mjs` performs `searchKnowledgeBase(...)`
2. it calls `read-runtime` through the index authority
3. it either calls the text model or falls back to extractive answer construction

Current truth:

- this helper is implemented and tested
- it is not the main public `/answer` route
- even when planner uses a skill-backed action, the final user-facing reply still goes through the existing answer normalization path rather than exposing raw skill payload fields

## 4. Adjacent Workflows

### 4A. Skill Runtime

Current path:

1. planner-adjacent caller or internal module selects a checked-in skill
2. `skill-runtime.mjs` validates input schema
3. skill executes only through declared bounded runtimes/tools
4. `skill-runtime.mjs` validates side effects and output schema
5. optional planner adaptation happens through `planner/skill-bridge.mjs`

Current truth:

- implemented as a minimal baseline
- current checked-in sample skills are `search_and_summarize` and `document_summarize`
- both checked-in sample skills are read-only and use `read-runtime`
- `search_and_summarize` uses `search_knowledge_base`
- `document_summarize` uses `get_company_brain_doc_detail`
- this does not register a new public route or planner routing target
- both checked-in skill-backed actions stay behind `planner/skill-bridge.mjs` and the answer pipeline
- `document_summarize` is planner-visible on its single-document summary boundary
- `search_and_summarize` is planner-visible only on its query-bound search-plus-summarize admission boundary and otherwise fails closed back to the original routing family
- this does not bypass mutation-runtime for writes

### 4B. Comment Rewrite

Current path:

1. preview route reads doc and comments
2. rewrite proposal is generated
3. apply route requires confirmation
4. final apply enters the shared mutation runtime

Current truth:

- implemented
- still ends in replace-based doc materialization

### 4C. Meeting Workflow

Current path:

1. meeting starts from slash command, wake phrase, or capture flow
2. capture state may create/update/delete a meeting doc through the external mutation runtime
3. summary generation produces structured meeting output
4. confirm route writes the final meeting entry back through the shared mutation runtime

Current truth:

- implemented
- structured meeting output exists
- `/meeting` is still a specialized workflow, not proof of a generic delegated subagent framework

### 4D. Sync

Current path:

1. `/sync/full` or `/sync/incremental`
2. connectors scan Drive and Wiki
3. doc text is extracted and chunked
4. repository writes documents, chunks, FTS rows, and sync summaries

Current truth:

- implemented
- sync feeds the retrieval index and mirror-adjacent data, but it is not the same thing as approved company-brain knowledge

## 5. Policy-Only or Incomplete Areas

- no full repo-wide read unification; some verification/review helpers still perform direct reads
- no full targeted doc block mutation runtime
- no background worker mesh or autonomous company-brain server

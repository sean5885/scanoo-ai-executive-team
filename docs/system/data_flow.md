# Data Flow

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Scope

This file mirrors the current data paths that are actually implemented.

The three main paths are:

1. `read`
2. `write`
3. `answer`

Sync, meeting, comment-rewrite, and the minimal skill layer are adjacent workflows built on top of those paths.

For the checked-in executive/workflow surfaces, same-account same-session entrypoints are now serialized in-process by `/Users/seanhan/Documents/Playground/src/single-machine-runtime-coordination.mjs` before task start/continue/apply/finalize logic runs.

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
- direct `executeLarkWrite(...)` from route or lane modules is no longer the checked-in primary pattern
- runtime-local idempotency exists in `mutation-runtime.mjs`
- persisted HTTP idempotency also exists at the HTTP layer

### 2B. Internal Company-Brain Governance Write Path

Current path:

1. mirror ingest or explicit company-brain governance route builds a canonical request
2. `runMutation(...)` is used for admission and verification
3. internal action writes review state, conflict state, approval state, learning state, or applied knowledge state

Current truth:

- this is implemented
- this is an internal governance write path, not an external Lark write path
- verified mirror ingest and approved/apply are distinct states

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
- the checked-in normalizer now reads only canonical `execution_result.data.answer / sources / limitations`

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

1. preview ingress enters the shared preview helper from either `/api/doc/rewrite-from-comments` or comment-suggestion card/poller
2. helper reads the doc, generates the rewrite proposal, creates one confirmation artifact, and moves the same workflow task to `awaiting_review`
3. only `/api/doc/rewrite-from-comments` may apply, and it requires the matching confirmation plus the matching `awaiting_review` task
4. final apply enters the shared mutation runtime and verifier gate before completion

Current truth:

- implemented
- comment suggestion ingress no longer owns a parallel preview/apply path
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

- no full generic repo-wide read abstraction; the audited company-brain/review/verification/system-knowledge helpers now re-enter `read-runtime.mjs`, but other repository-local reads still exist outside one universal surface
- no full targeted doc block mutation runtime
- no background worker mesh or autonomous company-brain server

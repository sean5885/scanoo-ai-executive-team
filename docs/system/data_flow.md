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

The Lark long-connection reply path is a bounded adjacent flow: inbound `im.message.receive_v1` events enter `/Users/seanhan/Documents/Playground/src/index.mjs`, lane selection happens before reply materialization, and `/Users/seanhan/Documents/Playground/src/runtime-message-reply.mjs` now treats the downstream Lark send as complete only when the message mutation response includes a concrete `message_id`.
That same ingress surface now also tracks websocket lifecycle activity through `/Users/seanhan/Documents/Playground/src/long-connection-lifecycle-monitor.mjs`; the checked-in monitor now classifies decoded websocket control/data frames before `eventDispatcher.invoke(...)`, records the parsed callback/event type plus handler presence, and if the socket stays `ready` but has no inbound message or heartbeat activity past the watchdog window, the process exits so the local LaunchAgent can rebuild the persistent connection.

The OpenClaw plugin ingress is now a second bounded adjacent flow: tool calls first post to `POST /agent/lark-plugin/dispatch`, `/Users/seanhan/Documents/Playground/src/lark-plugin-dispatch-adapter.mjs` normalizes `request_text / session_id / thread_id / chat_id / user_id / source / requested_capability / capability_source`, derives the checked-in session key (`thread -> chat -> session`), uses `requested_capability` first when present, records dispatch observability, and then either:

1. executes the existing planner answer edge
2. executes the existing lane path through a synthetic lane event/scope
3. returns a `plugin_native` forward decision so the plugin can continue on the existing direct document/message/calendar/task-style route without entering the internal planner/lane business flow

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
- the checked-in live-read wrappers normalize either a raw access token or a resolved auth envelope before handing the request to the live reader

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
- long-connection chat replies now reuse this same guarded write path and keep request/event/target/message evidence in the reply-send logs; awaiting the send call without a `message_id` is not treated as success
- long-connection chat replies now also reuse the incoming Lark `message_id` as the write idempotency key, so repeated canned reply text on different inbound messages does not trip `duplicate_write_same_session`
- message send/reply budget dedupe now distinguishes target plus reply content/card payload, so different replies in the same chat are not collapsed into one `duplicate_write_same_session` block

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
2. `http-server.mjs` calls `/Users/seanhan/Documents/Playground/src/planner-user-input-edge.mjs`
3. `planner-user-input-edge.mjs` calls `executePlannedUserInput(...)`
4. `executive-planner.mjs` resolves planner action or controlled failure
5. planner reads and tool results remain internal runtime state
6. `user-response-normalizer.mjs` converts the planner envelope into the public response shape:
   - `answer`
   - `sources`
   - `limitations`
7. `answer-source-mapper.mjs` converts canonical source objects into bounded public `sources[]` lines

Current truth:

- this path is implemented
- `/answer` is planner-first, not answer-service-first
- direct `/answer` remains available, but when `LARK_DIRECT_INGRESS_PRIMARY_ENABLED=false` the runtime marks it as a non-primary ingress rather than the formal plugin entry
- `/answer` and the `knowledge-assistant` lane now share the same planner answer-edge helper instead of re-assembling `execute -> envelope -> normalize` separately
- that shared edge helper also absorbs current legacy planner result shapes into canonical `answer / sources / limitations` before the public boundary
- for delivery/onboarding knowledge lookups, a single-hit company-brain search now turns into an answer-first reply that names the matched SOP/checklist document and surfaces bounded location/checklist/start-step hints from the indexed snippet, while preserving the same public `answer / sources / limitations` shape
- before the public boundary returns a generic failure, the checked-in normalizer now does a minimal mixed-request decomposition for copy/image/send-style asks and returns partial success when at least one text-draft subtask is still doable
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

### 3A. Plugin Hybrid Dispatch Path

Current path:

1. OpenClaw tool call enters `/Users/seanhan/Documents/Playground/openclaw-plugin/lark-kb/index.ts`
2. the plugin posts one normalized dispatch request to `POST /agent/lark-plugin/dispatch`, carrying one checked-in `requested_capability`
   - `knowledge_answer`
   - `scanoo_diagnose`
   - `scanoo_compare`
   - `scanoo_optimize`
   - plugin-native tool name passthrough for non-specialized tools
3. `/Users/seanhan/Documents/Playground/src/lark-plugin-dispatch-adapter.mjs` decides:
   - `knowledge_answer` directly from `requested_capability`
   - `lane_backend` directly from `scanoo_*` capability
   - `plugin_native` for plugin-native passthrough or unknown capability
   - only when `requested_capability` is absent does it fall back to the older tool/text heuristics
4. `knowledge_answer` reuses `/Users/seanhan/Documents/Playground/src/planner-user-input-edge.mjs`
5. `lane_backend` reuses `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`
6. `plugin_native` returns a forward decision and the plugin continues on the existing direct HTTP route

Current truth:

- the checked-in official plugin ingress is the hybrid dispatch route, not direct scattered route selection inside the plugin
- plugin-native document/message/calendar/task-style tools stay outside the internal planner/lane business flow
- the checked-in minimal capability map does not add planner or model-side NLP; `lark_kb_answer` uses simple tool+params rules to emit `knowledge_answer` or one of the three `scanoo_*` capabilities
- the dispatch layer records `request_text / source / session_id / thread_id / requested_capability / capability_source / route_target / chosen_lane / chosen_skill / fallback_reason / final_status`

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
- current checked-in skill implementations are `search_and_summarize`, `document_summarize`, and `image_generate`
- `search_and_summarize` and `document_summarize` are read-only and use `read-runtime`
- `image_generate` is read-only and currently returns a deterministic placeholder URL without external runtime side effects
- `search_and_summarize` uses `search_knowledge_base`
- `document_summarize` uses `get_company_brain_doc_detail`
- this does not register a new public route or planner routing target
- the checked-in skill-backed actions stay behind `planner/skill-bridge.mjs` and the answer pipeline
- failed skill-bridge executions may now emit one process-local `skill_bridge_failure` reflection payload through `/Users/seanhan/Documents/Playground/src/reflection/skill-reflection.mjs` when the host installs `globalThis.appendReflectionLog`
- that hook is additive observability only; it does not create a closed-loop executive task, does not enter the executive reflection archive, and does not change the public `answer / sources / limitations` boundary
- `document_summarize` is planner-visible on its single-document summary boundary
- `search_and_summarize` is planner-visible only on its query-bound search-plus-summarize admission boundary and otherwise fails closed back to the original routing family
- this does not bypass mutation-runtime for writes

### 4A-1. Task Layer Helper

Current path:

1. an internal caller passes raw user text to `/Users/seanhan/Documents/Playground/src/task-layer/task-classifier.mjs`
2. `classifyTask(...)` emits zero or more deterministic task tags from keyword heuristics
3. `/Users/seanhan/Documents/Playground/src/task-layer/task-dependency.mjs` normalizes those tags into the checked-in execution order
4. `/Users/seanhan/Documents/Playground/src/task-layer/task-skill-map.mjs` resolves each tag to a string skill identifier
5. `/Users/seanhan/Documents/Playground/src/task-layer/orchestrator.mjs` invokes the caller-provided `runSkill(skill, { input, task })`
6. `/Users/seanhan/Documents/Playground/src/task-layer/task-to-answer.mjs` now normalizes that task-layer result and derives the canonical user-facing `{ answer, sources, limitations }` fields for multi-task planner replies
7. the helper returns a unified object `{ ok, tasks, results, summary, data, errors }`, preserving per-task success/failure records while also surfacing summarized status and fail-soft errors

Current truth:

- implemented as an adjacent helper with an optional planner pre-pass
- current checked-in tags are `copywriting`, `image`, and `publish`
- current checked-in execution order is `copywriting -> image -> publish`
- current checked-in mapped identifiers are `document_summarize`, `image_generate`, and `message_send`
- execution is sequential and callback-driven; task failures are recorded fail-soft and later tasks still run; there is no checked-in queue or checked-in skill-runtime registration on this path
- if a task tag exists but no mapped identifier is present, the helper records `no_skill_mapped` and still returns the same fail-soft task-layer envelope
- `executePlannedUserInput(...)` may call this helper before normal planning only when the caller explicitly supplies `runSkill`
- when that optional pre-pass detects more than one task, planner execution returns a bounded `multi_task` result through the same canonical `answer / sources / limitations` boundary, and those user-facing fields are now derived by `task-to-answer.mjs` instead of being inlined inside `executive-planner.mjs`
- on the current checked-in path, `task-to-answer.mjs` prefers exposing bounded per-task natural-language payloads for successful `copywriting`, `image`, and `publish` tasks inside `answer`; if no such payload can be rendered, it falls back to the prior execution-summary wording while still preserving fail-soft `limitations`
- if the helper detects zero or one task, or if the optional pre-pass fails, execution falls back to the original planner path
- the checked-in public `/answer` edge does not currently supply `runSkill`, so the default public route behavior is unchanged
- `document_summarize` is backed by the checked-in skill runtime, `message_send` is backed by the checked-in write runtime, and `image_generate` is now backed by a checked-in internal-only skill runtime that still returns a placeholder URL on this helper path

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

### 4D. Personal DM Skill Tasks

Current path:

1. inbound `im.message.receive_v1` event enters `/Users/seanhan/Documents/Playground/src/index.mjs`
2. `/Users/seanhan/Documents/Playground/src/binding-runtime.mjs` resolves the chat as direct-message scope
3. `/Users/seanhan/Documents/Playground/src/lane-executor.mjs` keeps the request in `personal-assistant`
4. only when the personal lane would otherwise fall to `general_assistant_action`, the checked-in helper now runs `/Users/seanhan/Documents/Playground/src/planner/personal-dm-skill-intent.mjs`
5. the MiniMax text path classifies the DM into exactly one of:
   - `skill_find_request`
   - `skill_install_request`
   - `skill_verify_request`
   - `not_skill_task`
6. only the three explicit skill intents may continue into `/Users/seanhan/Documents/Playground/src/local-skill-actions.mjs`
7. the bounded skill action checks controlled local catalogs first, and for find/install may also call the checked-in `skill-installer` helper scripts under `$CODEX_HOME/skills/.system/skill-installer`
8. the bounded action returns canonical `answer / sources / limitations`
9. `/Users/seanhan/Documents/Playground/src/user-response-normalizer.mjs` renders the final text reply
10. `/Users/seanhan/Documents/Playground/src/runtime-message-reply.mjs` sends the reply through the existing guarded Lark mutation path

Current truth:

- implemented only for personal DM / direct-message scope
- this does not widen the existing planner-visible read-only skill bridge in `/Users/seanhan/Documents/Playground/src/planner/skill-bridge.mjs`
- current bounded actions are:
  - `find_local_skill`
  - `install_local_skill`
  - `verify_local_skill`
- skill actions are fail-closed and source-bounded:
  - local discovery reads only from `~/.codex/skills` and `~/.agents/skills`
  - remote find/install is limited to the checked-in curated catalog helper scripts under `$CODEX_HOME/skills/.system/skill-installer`
  - remote install is limited to `openai/skills` `skills/.curated`
  - install writes only to `~/.codex/skills`
  - no arbitrary command surface, no arbitrary path writes, no package-manager install path
- `not_skill_task` keeps the old personal-lane behavior unchanged; it does not bypass the existing fallback / tenant-token / meeting / cloud-doc precedence
- `find-skills` remains an agent skill/spec in the Codex environment; this runtime path does not directly execute that skill as a generic task owner
- this minimal version covers controlled skill find / install / verify and should not be described as a generic write-capable planner execution surface

### 4E. Sync

Current path:

1. `/sync/full` or `/sync/incremental`
2. connectors scan Drive and Wiki
3. doc text is extracted and chunked
4. repository writes documents, chunks, FTS rows, and sync summaries

Current truth:

- implemented
- sync feeds the retrieval index and mirror-adjacent data, but it is not the same thing as approved company-brain knowledge

## 5. Policy-Only or Incomplete Areas

- no single universal planner ingress for every lane/workflow in the repo; the checked-in shared ingress contract only covers current planner doc/knowledge/runtime reads plus the shared `/answer` and `knowledge-assistant` edge surfaces
- no full generic repo-wide read abstraction; the audited company-brain/review/verification/system-knowledge helpers now re-enter `read-runtime.mjs`, but other repository-local reads still exist outside one universal surface
- no full targeted doc block mutation runtime
- no background worker mesh or autonomous company-brain server

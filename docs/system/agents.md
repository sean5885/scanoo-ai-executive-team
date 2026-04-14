# Agents

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Agent Architecture Status

An AI-enabled system exists here, and it now includes a closed-loop executive orchestration layer on top of checked-in slash agents. It is still not a fully autonomous company-brain server.

What exists:

- OpenClaw plugin tools
- binding-based capability lanes
- closed-loop executive planner plus shared task-state orchestration
- core slash-agent registry and dispatcher
- input modality routing for text / image / multimodal requests
- lane-specific execution strategies
- command-style `/meeting` workflow built on top of the lane executor
- OpenClaw-backed semantic classifier
- LLM answer generation
- LLM comment rewrite
- Nano Banana-oriented image understanding adapter for image-first tasks

What does not exist in current code:

- autonomous long-running planner queue
- company_brain
- tenant-wide shared memory service
- memory orchestration layer

What now exists in current code:

- closed-loop executive planner that can start, continue, or hand off between registered agents
- shared executive task state for multi-turn continuation and agent-to-agent handoff
- lifecycle state transitions that require evidence plus verifier pass before completion
- checked-in slash-agent registry now includes core + persona surfaces: `/generalist`, `/planner`, `/company-brain`, `/ceo`, `/product`, `/prd`, `/cmo`, `/consult`, `/cdo`, `/delivery`, `/ops`, `/tech`
- checked-in knowledge subcommand inventory exists for `/knowledge audit|conflicts|distill`; parser default remains fail-closed (`ROUTING_NO_MATCH`) unless caller explicitly enables knowledge-subcommand parsing
- core-configured shared dispatcher that reuses retrieval grounding plus compact role prompts
- image-bearing slash requests that first use the Nano Banana-oriented adapter, then pass compact structured image context into the text model only when needed
- explicit capability contracts for registered agents
- self-check script plus maintainable capability/checklist documents for chain governance
- evidence-based verifier, reflection records, and improvement proposal generation
- monitoring-backed learning summaries that can draft routing/tool improvement proposals for human review
- proposal-first knowledge writeback path for uncertain meeting/executive conclusions

## Current Agent-Like Components

### OpenClaw Plugin Layer

- Name:
  - `lark-kb` plugin
- Role:
  - exposes repo capabilities as OpenClaw tools
  - Bitable tools now accept either raw `app_token` inputs or pasted `base/...` URLs
- Input:
  - tool parameters
- Output:
  - HTTP-backed result payloads
- Dependencies:
  - `http-server.mjs`
- Called by:
  - OpenClaw runtime
- Calls:
  - local HTTP API

### Agent-Facing HTTP Bridges

- Code:
  - `/Users/seanhan/Documents/Playground/src/http-server.mjs`
- Role:
  - provide thin agent-facing wrappers over selected document/runtime/query routes
  - preserve the underlying route or query logic instead of re-implementing it
  - normalize agent-facing responses to `{ ok, action, data, trace_id }`
- Current bridges:
  - `POST /agent/docs/create`
  - `GET /agent/company-brain/docs`
  - `GET /agent/company-brain/search`
  - `GET /agent/company-brain/docs/:doc_id`
  - `GET /agent/system/runtime-info`
- Logging:
  - `stage=agent_bridge`

### Binding / Session Runtime

- Name:
  - binding/session runtime
- Code:
  - `/Users/seanhan/Documents/Playground/src/binding-runtime.mjs`
  - `/Users/seanhan/Documents/Playground/src/session-scope-store.mjs`
- Role:
  - convert incoming Lark identity into binding/session/workspace/sandbox scopes
- Input:
  - `chat_id`
  - `open_id`
  - `chat_type`
  - message identifiers
- Output:
  - `agent_binding_key`
  - `capability_lane`
  - `lane_label`
  - `workspace_key`
  - `session_key`
  - `sandbox_key`
- Dependencies:
  - config
  - local JSON state
- Called by:
  - `src/index.mjs`
  - `POST /api/runtime/resolve-scopes`
- Calls:
  - local session scope store

### Capability Lane Resolver

- Name:
  - capability lane resolver
- Code:
  - `/Users/seanhan/Documents/Playground/src/capability-lane.mjs`
- Role:
  - map peer scope plus message intent into one practical assistant lane
  - only promote high-confidence document / company-brain / runtime reads into `knowledge-assistant`; generic wording such as standalone "整理" or "風險" no longer hard-routes by itself
- Input:
  - chat type
  - session scope
  - message text heuristics
  - structured Lark message payload fields such as `document_id` and `doc_token`
  - pasted Bitable `base/...` URLs in message text or structured link fields
  - reply-chain follow-up hints when the current message is replying to a shared doc
- Output:
  - `group-shared-assistant`
  - `personal-assistant`
  - `doc-editor`
  - `knowledge-assistant`
- Dependencies:
  - binding runtime
- Called by:
  - `src/binding-runtime.mjs`
  - `src/index.mjs`
- Calls:
  - none

### Capability Lane Executor

- Name:
  - capability lane executor
- Code:
  - `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`
- Role:
  - run one concrete reply strategy after a lane is resolved
  - intercept checked-in slash agents before generic lane fallback
  - route image-only and image+text requests through the image-understanding adapter before normal text-lane handling
  - also intercept `/meeting` as a command workflow before default lane replies
  - preflight shared Bitable links so the bot can inspect base/table structure without asking the user to copy tokens manually
  - keep `personal-assistant` fail-soft with a deterministic general-assistant catch-all instead of dropping benign direct messages into no-match
  - treat "整理會議" style wording as summary work before calendar lookup when the request is clearly asking for整理/摘要
  - keep fallback copy user-facing and avoid exposing routing/runtime/log wording in chat replies
- Input:
  - long-connection event
  - resolved lane scope
- Output:
  - human-readable text reply or card reply payload
- Dependencies:
  - answer service
  - doc suggestion workflow
  - Lark content adapter
  - OAuth account context
  - message intent utilities for document and Bitable reference extraction
- Called by:
  - `src/index.mjs`
- Calls:
  - lane-specific service functions
  - referenced-message lookups for doc share recovery

### Registered Slash Agents

- Name:
  - slash-agent registry and dispatcher
- Code:
  - `/Users/seanhan/Documents/Playground/src/agent-registry.mjs`
  - `/Users/seanhan/Documents/Playground/src/agent-dispatcher.mjs`
- Role:
- define checked-in core/persona/knowledge agent IDs, slash commands, role prompts, and output contracts
- keep one checked-in registered-agent family resolver for slash command and embedded slash mentions (for example `把這輪改交給 /planner`) so caller modules do not maintain local maps
- resolver keeps slash-first matching as default (direct slash + embedded slash), and only enables persona-style mention parsing when caller explicitly opts in
- expose minimum capability contracts for governance and self-check
- dispatch registered core/persona slash commands before generic lane fallback
- keep `/knowledge *` fail-closed by default at generic slash parsing boundaries, while allowing opt-in subcommand parsing in selected eval/recovery helpers
  - reuse retrieval grounding and compact workflow checkpoints for core-agent answers
  - when direct text-model credentials are absent, call the dedicated `lobster-backend` OpenClaw MiniMax text path before dropping to extractive retrieval-only output
  - keep chat-facing slash-agent fallback/no-match replies on the shared natural-language reply boundary instead of exposing raw error envelopes
  - reject JSON-like success payloads at the registered-agent output boundary and summarize them into visible natural language while keeping machine-readable fields in runtime data
- when eval/runtime is already on the executive surface but the request carries one explicit owner signal (slash command or opted-in persona-style mention), checked-in recovery/eval helpers stay owner-aware and reuse the same registered-agent answer surface rather than falling back to a generic executive brief
- Input:
  - slash command text
  - retrieved snippets
  - optional compact structured image context
- Output:
  - core-agent answer with concise sources footer
- Dependencies:
  - `answer-service.mjs`
  - `agent-token-governance.mjs`
  - `agent-workflow-state.mjs`
  - `image-understanding-service.mjs`

### Executive Orchestration Layer

- Name:
  - executive planner and task-state orchestrator
- Code:
  - `/Users/seanhan/Documents/Playground/src/executive-planner.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-task-state.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-orchestrator.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-closed-loop.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-lifecycle.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-verifier.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-reflection.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-improvement.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-memory.mjs`
- Role:
  - maintain one active executive task per session
  - let registered slash agents continue across multiple turns
  - allow planner-selected handoff between registered agents
  - let the planner attach a bounded work plan with at most three roles total (`1 primary + up to 2 supporting`)
  - default simple single-intent requests to `/generalist`
  - unknown or unregistered specialist IDs are collapsed to `/generalist` by role-count trimming before execution
  - when supporting roles are absent after trimming, planner stays on single-owner synthesis
  - support explicit exit from executive mode
  - derive task rules, success criteria, and lifecycle state on task initialization
  - collect evidence from execution, run verifier checks, and append reflection/improvement records
  - keep the improvement inference layer lightweight: `executive-improvement.mjs` first produces one pure `improvement_proposal` (`type / summary / action_suggestion`) from `reflection_result`, then downstream workflow code adds IDs, status, approval/apply metadata, and persistence
  - persist that lightweight `improvement_proposal` back into `task.execution_journal` after reflection so the closed-loop trace retains the local improvement signal without altering answer text
  - use the same dedicated `lobster-backend` OpenClaw MiniMax text path for planner decisions when direct `LLM_API_KEY` is unavailable
  - render user-facing executive replies as a fixed brief with:
    - direct answer first
    - normalized `結論 / 重點 / 下一步` structure
    - supporting-agent context absorbed into one single-voice final reply instead of separate visible agent blocks
  - reject JSON-like specialist or merge replies before they are parsed as executive brief text, keeping structured blobs out of the visible single-voice answer
  - expose a minimal planner-callable tool registry for five agent-bridge actions:
    - `create_doc`
    - `list_company_brain_docs`
    - `search_company_brain_docs`
    - `get_company_brain_doc_detail`
    - `get_runtime_info`
  - route those tool calls through the existing `/agent/*` HTTP bridges instead of duplicating document/runtime logic
- Boundaries:
  - does not run an async worker queue
  - does not run parallel supporting-agent execution; Thread103 baseline is sequential only
  - does not maintain a tenant-wide memory graph
  - does not yet auto-apply high-risk prompt/governance proposals without review

### Image Understanding Adapter

- Name:
  - image understanding adapter
- Code:
  - `/Users/seanhan/Documents/Playground/src/modality-router.mjs`
  - `/Users/seanhan/Documents/Playground/src/image-understanding-service.mjs`
- Role:
  - classify incoming input as `text`, `image`, or `multimodal`
  - send image understanding tasks to Nano Banana instead of the text model
  - convert image outputs into compact structured fields before any downstream text synthesis
- Input:
  - image URLs from structured Lark payloads
  - image-related task text
- Output:
  - `detected_objects`
  - `scene_summary`
  - `visible_text`
  - `key_entities`
  - `confidence`
  - `extracted_notes`
- Dependencies:
  - configurable Nano Banana-compatible HTTP endpoint
- Called by:
  - `src/lane-executor.mjs`

## Governance Artifacts

- Capability matrix:
  - `/Users/seanhan/Documents/Playground/docs/system/agent_capability_matrix.md`
- Chain checklist:
  - `/Users/seanhan/Documents/Playground/docs/system/chain_health_checklist.md`
- Self-check:
  - `/Users/seanhan/Documents/Playground/src/system-self-check.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/self-check.mjs`

### Meeting Command Workflow

- Name:
  - `/meeting`
- Code:
  - `/Users/seanhan/Documents/Playground/src/meeting-agent.mjs`
  - `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`
  - `/Users/seanhan/Documents/Playground/src/http-server.mjs`
- Role:
  - classify meeting content into `weekly` or `general`
  - start a chat-scoped meeting capture mode from menu or natural-language start phrases
  - auto-bind `我要開會了` style starts to the current or nearest calendar meeting when a `meeting_url` is available
  - bind capture mode to the current or nearest calendar event when the user explicitly asks to listen to "this meeting"
  - silently accumulate in-chat meeting notes until the user ends the meeting
  - answer explicit status checks such as `請問在持續記錄中嗎` without writing that question into the transcript
  - attempt local microphone recording on the host machine during active meeting capture
  - transcribe the local recording on meeting end with local `faster-whisper` by default, or an explicitly configured OpenAI-compatible audio endpoint
  - when user OAuth refresh is invalid, `/meeting` style capture can fall back to tenant-token doc creation and local capture instead of failing before recording starts
  - create a dedicated Lark meeting document at capture start and write the final usable minutes into that same document on meeting end
  - grant the initiating user `full_access` on Lobster-created or reused meeting docs when the initiating user's `open_id` is available, so the doc is manageable, not read-only
  - generate a fixed summary format
  - send summary to a target group
  - attach a confirm-write button via interactive card
  - hold a pending confirmation state
  - write to meeting docs only after confirmation
  - update weekly todo tracker for weekly meetings
- Input:
  - `/meeting` command text
  - Lark menu wake text such as `會議`
  - natural-language start / stop phrases such as `我要開會了` and `會議結束了`
  - short offline meeting starts such as `請記錄吧`, `線下會議 請記錄`, `okr 周例會`, or `現在正要開始 請準備記錄吧`
  - calendar-backed start phrases such as `開始旁聽這場會議`
  - natural-language meeting workflow requests that clearly ask Lobster to record first and write only after confirmation
  - referenced doc content
  - HTTP meeting payload
- Output:
  - group-safe summary
  - confirmation id
  - doc write result after confirm
- Dependencies:
  - `lark-content.mjs`
  - `doc-update-confirmations.mjs`
  - SQLite meeting mapping / tracker tables

### Semantic Classifier

- Name:
  - semantic classifier
- Code:
  - `/Users/seanhan/Documents/Playground/src/lark-drive-semantic-classifier.mjs`
- Role:
  - categorize docs for drive organization
- Input:
  - title, path, content summary
- Output:
  - category, confidence, reason
- Dependencies:
  - OpenClaw CLI
- Called by:
  - drive organizer
- Calls:
  - OpenClaw agent session

### Answer Generator

- Name:
  - answer service
- Code:
  - `/Users/seanhan/Documents/Playground/src/answer-service.mjs`
- Role:
  - answer questions from synced knowledge base
- Input:
  - account id, user question
- Output:
  - answer and sources
- Dependencies:
  - SQLite repository
  - optional LLM API
- Called by:
  - `/answer`
- Calls:
  - repository and optional LLM endpoint

### Comment Rewrite Assistant

- Name:
  - doc comment rewrite
- Code:
  - `/Users/seanhan/Documents/Playground/src/doc-comment-rewrite.mjs`
- Role:
  - turn doc comments into revised doc content
- Input:
  - doc id, selected comments, apply flag
- Output:
  - preview or rewritten doc content
- Dependencies:
  - `lark-content.mjs`
  - optional LLM API
- Called by:
  - `/api/doc/rewrite-from-comments`
- Calls:
  - Lark content APIs
  - optional LLM endpoint

### Comment Suggestion Workflow

- Name:
  - comment suggestion workflow
- Code:
  - `/Users/seanhan/Documents/Playground/src/comment-suggestion-workflow.mjs`
  - `/Users/seanhan/Documents/Playground/src/comment-suggestion-poller.mjs`
- Role:
  - detect unseen unresolved comments
  - build rewrite preview cards
  - optionally poll watched documents
- Input:
  - account id
  - document id
  - optional target message id
- Output:
  - rewrite preview card
  - confirmation id
  - optional notification side effect
- Dependencies:
  - Lark content APIs
  - local watch state
  - confirmation store
- Called by:
  - `/api/doc/comments/suggestion-card`
  - `/api/doc/comments/poll-suggestion-cards`
  - `lane-executor.mjs`
- Calls:
  - comment rewrite preview generation
  - Lark reply API

### Security Wrapper

- Name:
  - `lobster_security`
- Role:
  - guard local file/command/network actions
- Input:
  - action envelope
- Output:
  - allow / deny / approval required / rollback diff
- Dependencies:
  - Python subproject
- Called by:
  - secure action HTTP routes
- Calls:
  - internal Python security modules

## Knowledge and Memory

- Knowledge pipeline:
  - yes, SQLite-backed sync and FTS retrieval
- Memory system:
  - no agent memory layer found
- company_brain:
  - not present

## Fallback Behavior

- answer path:
  - use the dedicated OpenClaw MiniMax text path when direct text-model credentials are absent
  - only fall back to retrieval-summary output if text generation itself fails

- semantic classifier:
  - local rules now exist as fallback when OpenClaw is unavailable

- comment rewrite:
  - no rewrite without LLM key

## Maturity

- tool layer: implemented
- semantic classification: implemented, quality-sensitive
- planner/router/specialist collaboration: not implemented in this repo

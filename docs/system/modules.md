# Modules

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Scope

This file is the current code-truth mirror for the checked-in runtime.

It intentionally separates:

- `implemented`: code path exists and is exercised by the current runtime or checked-in tests
- `secondary`: code exists, but it is not the main public surface for the same capability
- `policy-only`: governance language or design intent exists, but there is no full end-to-end runtime path
- `historical`: frozen baseline or migration aid; keep only as reference, not as the primary explanation

The consolidated truth table lives in [truth_matrix.md](/Users/seanhan/Documents/Playground/docs/system/truth_matrix.md).

Current-truth docs for onboarding are:

- [modules.md](/Users/seanhan/Documents/Playground/docs/system/modules.md)
- [api_map.md](/Users/seanhan/Documents/Playground/docs/system/api_map.md)
- [data_flow.md](/Users/seanhan/Documents/Playground/docs/system/data_flow.md)
- [repo_map.md](/Users/seanhan/Documents/Playground/docs/system/repo_map.md)
- [write_policy_unification.md](/Users/seanhan/Documents/Playground/docs/system/write_policy_unification.md)
- [truth_matrix.md](/Users/seanhan/Documents/Playground/docs/system/truth_matrix.md)
- [open_questions.md](/Users/seanhan/Documents/Playground/docs/system/open_questions.md)

## Canonical Terms

- `canonical source object`
  - the normalized evidence item used before public answer rendering
  - current shape is `{ id, snippet, metadata }`
  - code: `/Users/seanhan/Documents/Playground/src/read-source-schema.mjs`, `/Users/seanhan/Documents/Playground/src/answer-source-mapper.mjs`
- `mapping`
  - a checked-in route, authority, or action mapping that drives runtime behavior
  - examples:
    - read authority mapping in `/Users/seanhan/Documents/Playground/src/read-runtime.mjs`
    - external write action mapping in `/Users/seanhan/Documents/Playground/src/external-mutation-registry.mjs`
    - planner flow mapping in `/Users/seanhan/Documents/Playground/src/planner-flow-runtime.mjs`
- `mutation journal`
  - the runtime metadata recorded under `mutation_execution.meta.journal`
  - currently includes `action`, `status`, `started_at`, optional `error`, optional `rollback`, and optional `audit`
  - code: `/Users/seanhan/Documents/Playground/src/mutation-runtime.mjs`

## Runtime Module Groups

### 1. HTTP and Event Entrypoints

- Implemented:
  - `/Users/seanhan/Documents/Playground/src/http-server.mjs`
  - `/Users/seanhan/Documents/Playground/src/index.mjs`
  - `/Users/seanhan/Documents/Playground/src/lark-plugin-dispatch-adapter.mjs`
  - `/Users/seanhan/Documents/Playground/src/runtime-conflict-guard.mjs`
  - `/Users/seanhan/Documents/Playground/src/runtime-message-deduper.mjs`
  - `/Users/seanhan/Documents/Playground/src/runtime-message-reply.mjs`
  - `/Users/seanhan/Documents/Playground/src/single-machine-runtime-coordination.mjs`
  - `/Users/seanhan/Documents/Playground/src/runtime-observability.mjs`
- What they do now:
  - start the HTTP service and the Lark long-connection listener
  - accept the checked-in official plugin ingress on `POST /agent/lark-plugin/dispatch`
  - create per-request and per-event trace records
  - enforce duplicate-message suppression
  - guard against competing local responders
  - serialize same-account same-session workflow/executive entrypoints inside one process so one session keeps one active coordination owner at a time
  - normalize plugin `thread -> chat -> session` dispatch keys, record route-target observability, and keep direct ingress marked separately from the formal plugin entry when `LARK_DIRECT_INGRESS_PRIMARY_ENABLED=false`
  - send long-connection bot replies only through the mutation runtime, and only treat the send as successful when the Lark message response returns a concrete `message_id`; the runtime reply helper now emits `reply_send_attempted`, `reply_send_succeeded`, and `reply_send_failed` instead of a generic post-await success log
- Evidence:
  - `/Users/seanhan/Documents/Playground/tests/http-server.route-success.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/http-server.trace.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/http-monitoring.test.mjs`

### 2. Read Path

- Implemented:
  - `/Users/seanhan/Documents/Playground/src/read-runtime.mjs`
  - `/Users/seanhan/Documents/Playground/src/index-read-authority.mjs`
  - `/Users/seanhan/Documents/Playground/src/company-brain-query.mjs`
  - `/Users/seanhan/Documents/Playground/src/derived-read-authority.mjs`
- Current truth:
  - read authority is explicit, not implicit fallback
  - `index` handles retrieval search and system-knowledge reads
  - `mirror` handles `company_brain_docs`
  - `derived` handles approved knowledge and approval/learning-state views
  - `live` handles direct Lark doc/comment reads
  - live read helpers accept either a raw access-token string or the checked-in resolved auth envelope shape and normalize that into the canonical live-read request before reader execution
- Evidence:
  - `/Users/seanhan/Documents/Playground/tests/read-runtime.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/company-brain-query.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/http-server.route-success.test.mjs`

### 3. Answer Path

- Main implemented public path:
  - `/Users/seanhan/Documents/Playground/src/lark-plugin-dispatch-adapter.mjs`
  - `/Users/seanhan/Documents/Playground/src/http-server.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner-user-input-edge.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-planner.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner-ingress-contract.mjs`
  - `/Users/seanhan/Documents/Playground/src/user-response-normalizer.mjs`
  - `/Users/seanhan/Documents/Playground/src/answer-source-mapper.mjs`
- Current truth:
  - `GET /answer` no longer uses `answer-service.mjs` as its primary route
  - the checked-in official plugin entry now lands on `/Users/seanhan/Documents/Playground/src/lark-plugin-dispatch-adapter.mjs` first, not on scattered route decisions inside the plugin
  - public answer generation goes through planner execution first
  - plugin-native document/message/calendar/task-style tools are explicitly classified as `plugin_native` and do not enter the internal planner/lane business path
  - `/answer` and the `knowledge-assistant` lane now share one checked-in answer-edge helper instead of rebuilding `execute -> envelope -> normalize` separately
  - that shared answer-edge helper also lifts current legacy planner result shapes into canonical `answer / sources / limitations` before public rendering
  - `planner-ingress-contract.mjs` is the checked-in ingress rule for doc/knowledge/runtime planner admission and the personal-lane planner edge guard
  - planner ingress now only escalates high-confidence doc/runtime phrasings; generic wording such as standalone "整理" or "風險" no longer forces document/runtime routing by itself
  - planner flow ownership between `runtime_info`, `doc_query`, `okr`, `bd`, and `delivery` is now explicit in code rather than inferred from flow priority or registration order
  - final HTTP/chat response is normalized into `answer -> sources -> limitations`
  - `user-response-normalizer.mjs` now only reads canonical `execution_result.data.answer / sources / limitations`
  - delivery/onboarding single-hit company-brain search replies now answer first with the matched document title plus bounded location/checklist/step hints from indexed snippets, instead of only repeating the generic "已索引文件" search copy
  - canonical user replies now degrade gracefully when only partial `sources / limitations` are present, instead of collapsing straight to a full-failure generic reply
  - when the planner result would otherwise degrade to a generic failure, `user-response-normalizer.mjs` now performs a minimal mixed-request decomposition for copy/image/send-style asks and upgrades the reply to partial success if a text-draft subtask is still doable
  - `renderUserResponseText(...)` renders an already-canonical `{ answer, sources, limitations }` object directly without re-normalizing legacy payload shapes
  - planner/read evidence is converted into public `sources[]` lines through canonical source mapping
- Secondary implemented path:
  - `/Users/seanhan/Documents/Playground/src/answer-service.mjs`
  - still exists for internal retrieval-answer generation and tests
  - not the main `/answer` route entry
- Evidence:
  - `/Users/seanhan/Documents/Playground/tests/executive-planner.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/user-response-normalizer.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/answer-service.test.mjs`

### 4. Skill Runtime

- Implemented:
  - `/Users/seanhan/Documents/Playground/src/skill-governance.mjs`
  - `/Users/seanhan/Documents/Playground/src/skill-contract.mjs`
  - `/Users/seanhan/Documents/Playground/src/skill-runtime.mjs`
  - `/Users/seanhan/Documents/Playground/src/skill-registry.mjs`
  - `/Users/seanhan/Documents/Playground/src/skills/document-fetch.mjs`
  - `/Users/seanhan/Documents/Playground/src/skills/image-generate-skill.mjs`
  - `/Users/seanhan/Documents/Playground/src/skills/search-and-summarize-skill.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner/skill-bridge.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner-visible-skill-observability.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner-visible-live-telemetry-spec.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner-visible-live-telemetry-adapter.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner-visible-live-telemetry-runtime.mjs`
- Current truth:
  - a checked-in minimal skill contract now exists
  - the checked-in skill/helper modules under `src/skills/` now also export a lightweight descriptive `SKILL_CONTRACT` object with `intent`, `success_criteria`, and `failure_criteria`
  - skill definitions must now declare `skill_class` and `runtime_access`
  - the runtime validates input, output, and side effects
  - the runtime rejects non-serializable input/output and nested skill execution
  - the checked-in skill set is currently `search_and_summarize`, `document_summarize`, and `image_generate`
  - `search_and_summarize` and `document_summarize` are read-only and go through `read-runtime`
  - `image_generate` is a checked-in internal-only read-only skill that returns a deterministic placeholder image URL without external side effects
  - `src/skills/document-fetch.mjs` is a secondary read-only helper under the same module group; it resolves `document_id` from direct input or raw Lark-style card payload and returns bounded `missing_access_token | not_found | permission_denied` failures without registering a new planner-visible skill
  - planner can consume a skill result through a bridge envelope
  - planner-visible skill selection is deterministic-only and conflict-fail-closed
  - planner-visible skill rollout now has a checked-in observability/rollback watch over selector, tool execution, and answer-boundary evidence
  - planner-visible live telemetry now emits minimal spec-constrained runtime events through an injected telemetry adapter at planner decision/selection, fail-closed admission, fallback, and answer boundary
  - the default adapter is a bounded in-memory buffer and the checked-in mock structured-log adapter can write JSON lines to console or a local file stub
  - no external telemetry pipeline is wired from this module set yet
  - skill existence does not add a new public route or planner routing target by itself
- Evidence:
  - `/Users/seanhan/Documents/Playground/tests/skill-runtime.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/document-fetch.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/planner-visible-skill-observability.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/planner-visible-live-telemetry-adapter.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/planner-visible-live-telemetry-spec.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/planner-visible-live-telemetry-runtime.test.mjs`

### 4A. Task Layer Helper

- Implemented:
  - `/Users/seanhan/Documents/Playground/src/task-layer/task-classifier.mjs`
  - `/Users/seanhan/Documents/Playground/src/task-layer/task-dependency.mjs`
  - `/Users/seanhan/Documents/Playground/src/task-layer/task-skill-map.mjs`
  - `/Users/seanhan/Documents/Playground/src/task-layer/task-to-answer.mjs`
  - `/Users/seanhan/Documents/Playground/src/task-layer/orchestrator.mjs`
- Current truth:
  - a checked-in task-layer helper now exists under `src/task-layer/`
  - it performs deterministic keyword classification into `copywriting`, `image`, and `publish`
  - `task-dependency.mjs` defines the current checked-in execution order as `copywriting -> image -> publish`
  - it maps those task tags to routed capability identifiers `document_summarize`, `image_generate`, and `message_send`
  - `/Users/seanhan/Documents/Playground/src/task-layer/task-aggregator.mjs` folds per-task records into a unified `{ ok, tasks, results, summary, data, errors }` envelope
  - `/Users/seanhan/Documents/Playground/src/task-layer/task-to-answer.mjs` converts that bounded task-layer envelope into canonical `answer / sources / limitations` fields for planner-facing multi-task replies, and now prefers surfacing bounded per-task natural-language content (for example copy text or generated-image location) before falling back to generic execution summary text
  - `runTaskLayer(...)` sorts detected tasks through that dependency helper, executes the provided `runSkill` callback sequentially, and returns that aggregated envelope with both raw per-task records and summarized status
  - if a task is classified but no routed capability identifier is mapped, the helper records `no_skill_mapped` fail-soft and still keeps the same bounded result shape
  - a task failure is recorded fail-soft and does not stop later tasks from running in the same bounded pass
  - `executePlannedUserInput(...)` can now consult this helper as a planner pre-pass, but only when the caller explicitly provides a `runSkill` callback
  - if that optional pre-pass detects more than one task, planner execution short-circuits into a bounded `multi_task` result that still stays inside the canonical `answer / sources / limitations` boundary
  - if no `runSkill` callback is provided, the pre-pass errors, or at most one task is detected, the original planner flow continues unchanged
  - the checked-in public `/answer` edge does not currently provide `runSkill`, so this does not change the default public route behavior
  - `document_summarize` is a checked-in skill-backed action, `message_send` is a checked-in write action, and `image_generate` is now a checked-in internal-only skill-backed action that still returns a placeholder URL rather than calling a real image backend
- Evidence:
  - `/Users/seanhan/Documents/Playground/tests/task-dependency.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/task-layer.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/task-layer-integration.test.mjs`

### 5. External Write Path

- Implemented:
  - `/Users/seanhan/Documents/Playground/src/external-mutation-registry.mjs`
  - `/Users/seanhan/Documents/Playground/src/write-policy-contract.mjs`
  - `/Users/seanhan/Documents/Playground/src/lark-mutation-runtime.mjs`
  - `/Users/seanhan/Documents/Playground/src/mutation-runtime.mjs`
  - `/Users/seanhan/Documents/Playground/src/execute-lark-write.mjs`
- Current truth:
  - external writes are described by registry-backed action specs
  - public route or lane code builds a canonical request and write policy
  - `mutation-runtime.mjs` owns admission, verification, and mutation journal generation
  - `execute-lark-write.mjs` is the only checked-in `executeLarkWrite(...)` callsite authority
- Evidence:
  - `/Users/seanhan/Documents/Playground/tests/mutation-admission.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/write-policy-contract.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/mutation-runtime.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/lark-mutation-runtime.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/execute-lark-write.test.mjs`

### 6. Company-Brain Mirror and Governance

- Implemented mirror/read side:
  - `/Users/seanhan/Documents/Playground/src/company-brain-write-intake.mjs`
  - `/Users/seanhan/Documents/Playground/src/company-brain-query.mjs`
  - `/Users/seanhan/Documents/Playground/src/company-brain-learning.mjs`
  - `/Users/seanhan/Documents/Playground/src/company-brain-review.mjs`
  - `/Users/seanhan/Documents/Playground/src/company-brain-lifecycle-contract.mjs`
- Current truth:
  - verified mirror ingest exists
  - read-side list/detail/search exists
  - review, conflict check, approval transition, apply, and learning-state routes exist
  - approved knowledge is a separate derived/applied surface
  - the audited company-brain review/learning/verifier helpers now re-enter `read-runtime.mjs` for mirror/derived reads
- Important boundary:
  - this is not a full generic company-brain runtime
  - mirror ingest is not equivalent to formal approval
  - apply is gated by the checked-in lifecycle contract, not by a broader autonomous workflow engine
- Evidence:
  - `/Users/seanhan/Documents/Playground/tests/company-brain-write-intake.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/company-brain-review-approval.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/company-brain-lifecycle-contract.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/http-server.route-success.test.mjs`

### 7. Workflow-Specific Mutation Surfaces

- Implemented:
  - comment rewrite: `/Users/seanhan/Documents/Playground/src/doc-comment-rewrite.mjs`
  - comment/doc workflow closure helper: `/Users/seanhan/Documents/Playground/src/comment-doc-workflow.mjs`
  - comment suggestion ingress: `/Users/seanhan/Documents/Playground/src/comment-suggestion-workflow.mjs`
  - meeting workflow: `/Users/seanhan/Documents/Playground/src/meeting-agent.mjs`
  - capture/update/delete during meeting capture: `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`
- Current truth:
  - comment/doc preview now has one checked-in owner path: preview is prepared by `comment-doc-workflow.mjs`, review is represented by one `awaiting_review` task plus one confirmation artifact, and apply is only allowed from `/api/doc/rewrite-from-comments`
  - comment suggestion card and poller are ingress-only surfaces into that same preview/review path; they do not own a separate apply or completion path
  - comment rewrite final materialization still uses doc replace-based apply inside the shared runtime gate
  - meeting confirmation writes are runtime-governed external writes
  - meeting capture document create/update/delete actions are already registry-backed external writes
  - the checked-in workflow/executive entrypoints now also pass through one single-machine coordination helper keyed by `account_id + session_key`, so overlapping local turns do not each create or finish their own competing same-session owner path
  - active-task cleanup is now owner-aware: terminal workflow completion clears the session pointer only when the finishing task still owns that session slot
- Evidence:
  - `/Users/seanhan/Documents/Playground/tests/doc-comment-rewrite.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/control-unification-phase2-doc-rewrite.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/comment-suggestion-workflow.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/http-server.route-success.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/meeting-agent.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/control-unification-phase2-meeting.test.mjs`

### 7A. Executive Closed-Loop Learning and Metrics

- Implemented:
  - `/Users/seanhan/Documents/Playground/src/executive-closed-loop.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-reflection.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-improvement.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-improvement-workflow.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-evolution-metrics.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-evolution-replay.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/executive-evolution-replay.mjs`
  - `/Users/seanhan/Documents/Playground/scripts/executive-evolution-replay-pack.mjs`
- Current truth:
  - execution reflection remains the checked-in source for per-step `success / deviation / reason`
  - top-level reflection records now also classify `missing_access_token`, `permission_denied`, and `document_not_found` as `reason = missing_info` with `deviation = true`
  - finalized executive turns now archive a local evolution snapshot alongside the reflection record
  - the runtime logger now emits one structured `executive_evolution_metrics` event with rolling local rates for `reflection_deviation_rate`, `improvement_trigger_rate`, and `retry_success_rate`
  - bounded executive replay can now compare the same task across `first_run` and `second_run` run specs and output `improvement_delta` for success, steps, and deviation
  - the checked-in replay pack runner executes every JSON spec under `evals/executive-replay/fixtures`, reports one bounded result line per case, and can also emit a single JSON summary document
  - this replay surface is offline/local reconstruction only; it does not promise raw live request replay or automatic improvement application
- this path is process-local and file-backed through the existing reflection archive; it does not use any external telemetry service
- adjacent planner-visible skill failures may also emit a separate process-local `skill_bridge_failure` hook through `/Users/seanhan/Documents/Playground/src/reflection/skill-reflection.mjs` when `globalThis.appendReflectionLog` is present; this is additive observability and not the same persistence path as the executive reflection archive
- Evidence:
  - `/Users/seanhan/Documents/Playground/tests/executive-closed-loop.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/executive-evolution-metrics.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/executive-evolution-replay.test.mjs`

### 8. Classification and Plugin Adapters

- Implemented:
  - semantic classifier: `/Users/seanhan/Documents/Playground/src/lark-drive-semantic-classifier.mjs`
  - OpenClaw plugin: `/Users/seanhan/Documents/Playground/openclaw-plugin/lark-kb/index.ts`
- Current truth:
  - semantic organization no longer depends only on OpenClaw; local fallback exists
  - OpenClaw plugin is an adapter over checked-in HTTP surfaces
- Evidence:
  - `/Users/seanhan/Documents/Playground/tests/lark-drive-semantic-classifier.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/openclaw-plugin-regression.test.mjs`

## Secondary and Non-Canonical Modules

- `secondary but real`
  - `/Users/seanhan/Documents/Playground/src/answer-service.mjs`
  - `/Users/seanhan/Documents/Playground/src/knowledge/knowledge-service.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner/knowledge-bridge.mjs`
- `experimental / process-local`
  - `/Users/seanhan/Documents/Playground/src/company-brain-memory-authority.mjs`
  - `/Users/seanhan/Documents/Playground/src/memory-write-guard.mjs`
  - `/Users/seanhan/Documents/Playground/src/memory-write-detector.mjs`
- Current truth:
  - these files exist and are tested
  - they are not the canonical public read/write surfaces for the current system

## Policy-Only or Not Fully Landed

- no checked-in background worker mesh
- no full autonomous company-brain server
- no full generic repo-wide read abstraction; the audited company-brain/review/verification/system-knowledge helper set now re-enters `read-runtime.mjs`, but other repository-local reads still exist outside one universal surface
- no targeted block-level doc mutation runtime; targeted preview exists, final apply is still replace-based in the doc write adapter
- no production telemetry sink or runtime rollback flag carrier for planner-visible live telemetry; the checked-in emitter/adapters stay local-only (`in-memory` or mock structured-log) and the broader rollout design remains in `/Users/seanhan/Documents/Playground/docs/system/planner_visible_live_telemetry_design.md`

## Historical or Frozen References

- [mutation_path_mapping_phase1.md](/Users/seanhan/Documents/Playground/docs/system/mutation_path_mapping_phase1.md)
  - keep as historical Phase 1 mapping baseline
  - do not read it as the exhaustive current mutation inventory
- `/Users/seanhan/Documents/Playground/docs/system/mutation_admission_contract_v1.md`
  - frozen baseline for admission-contract history
  - current route/action truth is in code and mirrored through [write_policy_unification.md](/Users/seanhan/Documents/Playground/docs/system/write_policy_unification.md)

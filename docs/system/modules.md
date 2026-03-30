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
  - `/Users/seanhan/Documents/Playground/src/runtime-conflict-guard.mjs`
  - `/Users/seanhan/Documents/Playground/src/runtime-message-deduper.mjs`
  - `/Users/seanhan/Documents/Playground/src/runtime-observability.mjs`
- What they do now:
  - start the HTTP service and the Lark long-connection listener
  - create per-request and per-event trace records
  - enforce duplicate-message suppression
  - guard against competing local responders
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
- Evidence:
  - `/Users/seanhan/Documents/Playground/tests/read-runtime.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/company-brain-query.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/http-server.route-success.test.mjs`

### 3. Answer Path

- Main implemented public path:
  - `/Users/seanhan/Documents/Playground/src/http-server.mjs`
  - `/Users/seanhan/Documents/Playground/src/executive-planner.mjs`
  - `/Users/seanhan/Documents/Playground/src/user-response-normalizer.mjs`
  - `/Users/seanhan/Documents/Playground/src/answer-source-mapper.mjs`
- Current truth:
  - `GET /answer` no longer uses `answer-service.mjs` as its primary route
  - public answer generation goes through planner execution first
  - final HTTP/chat response is normalized into one canonical envelope: `ok`, `answer`, `sources`, `limitations`
  - runtime-info replies no longer expose a top-level `kind`; that machine label stays internal on `execution_result.kind`
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
  - `/Users/seanhan/Documents/Playground/src/skills/search-and-summarize-skill.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner/skill-bridge.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner-visible-skill-observability.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner-visible-live-telemetry-spec.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner-visible-live-telemetry-adapter.mjs`
  - `/Users/seanhan/Documents/Playground/src/planner-visible-live-telemetry-runtime.mjs`
- Current truth:
  - a checked-in minimal skill contract now exists
  - skill definitions must now declare `skill_class` and `runtime_access`
  - the runtime validates input, output, and side effects
  - the runtime rejects non-serializable input/output and nested skill execution
  - the checked-in sample skill is read-only and goes through `read-runtime`
  - planner can consume a skill result through a bridge envelope
  - planner-visible skill selection is deterministic-only and conflict-fail-closed
  - planner-visible skill rollout now has a checked-in observability/rollback watch over selector, tool execution, and answer-boundary evidence
  - planner-visible live telemetry now emits minimal spec-constrained runtime events through an injected telemetry adapter at planner decision/selection, fail-closed admission, fallback, and answer boundary
  - the default adapter is a bounded in-memory buffer and the checked-in mock structured-log adapter can write JSON lines to console or a local file stub
  - no external telemetry pipeline is wired from this module set yet
  - skill existence does not add a new public route or planner routing target by itself
- Evidence:
  - `/Users/seanhan/Documents/Playground/tests/skill-runtime.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/planner-visible-skill-observability.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/planner-visible-live-telemetry-adapter.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/planner-visible-live-telemetry-spec.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/planner-visible-live-telemetry-runtime.test.mjs`

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
  - successful doc create/update/rewrite HTTP writes now additionally pass a post-write live read-back consistency check before the route returns success
  - that read-back snapshot is now reused to refresh local document/chunk/FTS state, and create waits for verified mirror ingest instead of leaving it asynchronous
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
  - `/Users/seanhan/Documents/Playground/src/company-brain-review.mjs`
  - `/Users/seanhan/Documents/Playground/src/company-brain-lifecycle-contract.mjs`
- Current truth:
  - verified mirror ingest exists
  - read-side list/detail/search exists
  - review, conflict check, approval transition, and apply routes exist
  - approved knowledge is a separate derived/applied surface
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
  - meeting workflow: `/Users/seanhan/Documents/Playground/src/meeting-agent.mjs`
  - capture/update/delete during meeting capture: `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`
- Current truth:
  - comment rewrite uses preview plus confirmation, but final materialization is still doc replace based
  - meeting confirmation writes are runtime-governed external writes
  - meeting capture document create/update/delete actions are already registry-backed external writes
  - doc rewrite apply now also refreshes local retrieval/mirror state from a read-back snapshot before surfacing success
- Evidence:
  - `/Users/seanhan/Documents/Playground/tests/doc-comment-rewrite.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/control-unification-phase2-doc-rewrite.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/meeting-agent.test.mjs`
  - `/Users/seanhan/Documents/Playground/tests/control-unification-phase2-meeting.test.mjs`

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
- no repo-wide universal read unification; some review/verification helpers still read state directly
- no targeted block-level doc mutation runtime; targeted preview exists, final apply is still replace-based in the doc write adapter
- no checked-in live planner-visible telemetry emitter, production telemetry sink, or runtime rollback flag carrier yet; current live design is spec-only in `/Users/seanhan/Documents/Playground/docs/system/planner_visible_live_telemetry_design.md`

## Historical or Frozen References

- [mutation_path_mapping_phase1.md](/Users/seanhan/Documents/Playground/docs/system/mutation_path_mapping_phase1.md)
  - keep as historical Phase 1 mapping baseline
  - do not read it as the exhaustive current mutation inventory
- `/Users/seanhan/Documents/Playground/docs/system/mutation_admission_contract_v1.md`
  - frozen baseline for admission-contract history
  - current route/action truth is in code and mirrored through [write_policy_unification.md](/Users/seanhan/Documents/Playground/docs/system/write_policy_unification.md)

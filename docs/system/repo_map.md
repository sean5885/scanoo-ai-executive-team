# Repo Map

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This file explains which directories are part of the current runtime, which are support assets, and which are historical or non-canonical.

## Runtime Directories

### `/Users/seanhan/Documents/Playground/src`

- Main Node runtime.
- Current responsibility:
  - HTTP server
  - Lark long-connection listener
  - OAuth and token refresh
  - retrieval index reads
  - company-brain mirror/read/governance helpers
  - planner and user-response normalization
  - external mutation runtime
  - meeting and comment-rewrite workflows

### `/Users/seanhan/Documents/Playground/openclaw-plugin/lark-kb`

- Checked-in OpenClaw plugin adapter.
- Current responsibility:
  - expose repo HTTP capabilities as OpenClaw tools
  - send every tool call through the checked-in hybrid dispatch ingress before any plugin-native forward

### `/Users/seanhan/Documents/Playground/lobster_security`

- Separate Python project.
- Current responsibility:
  - approval, audit, snapshot, rollback, and command-policy support through the bridge
- Boundary:
  - architecture is separate from the Node runtime
  - keep bridge-contract descriptions grounded in checked-in integration points only

## Support Directories

### `/Users/seanhan/Documents/Playground/docs/system`

- the technical mirror for this repo
- should describe current code truth, not desired architecture
- practical current-truth onboarding set:
  - `modules.md`
  - `api_map.md`
  - `data_flow.md`
  - `repo_map.md`
  - `write_policy_unification.md`
  - `truth_matrix.md`
  - `open_questions.md`
- planning, alignment, refactor, release, and audit docs in the same directory are useful context, but they are not the first source to use for current runtime truth
- planner-visible live telemetry design currently lives in:
  - `/Users/seanhan/Documents/Playground/docs/system/planner_visible_live_telemetry_design.md`
  - this is a checked-in design mirror, not a live pipeline declaration

### `/Users/seanhan/Documents/Playground/scripts`

- operational and regression scripts
- current groups:
  - monitoring and trace tools
  - planner and routing diagnostics
  - local autonomous-workflow demo runners
  - retrieval, workflow, and runtime eval runners
  - release/self-check helpers
  - local meeting transcription helper

### `/Users/seanhan/Documents/Playground/evals`

- checked-in fixture sets and review inputs
- current groups:
  - routing
  - retrieval
  - document workflow
  - meeting workflow
  - runtime workflow
  - executive replay fixtures
  - real-user review fixtures

### `/Users/seanhan/Documents/Playground/tests/fixtures`

- checked-in local evaluation fixture directory
- current examples:
  - `/Users/seanhan/Documents/Playground/tests/fixtures/usage-eval-cases.json`
    - multi-turn real-world usage eval pass v1 cases for usage-layer + decision-engine measurement

### `/Users/seanhan/Documents/Playground/config`

- small repo-local config directory
- current checked-in usage is limited
- most runtime configuration is still environment-driven through `/Users/seanhan/Documents/Playground/src/config.mjs`

### `/Users/seanhan/Documents/Playground/.data`

- local runtime state
- current examples:
  - SQLite database
  - JSON state stores
  - write-budget state
  - checkpoints and executive state

## Source Subtrees Inside `src`

### Public Runtime Surfaces

- `/Users/seanhan/Documents/Playground/src/http-server.mjs`
- `/Users/seanhan/Documents/Playground/src/index.mjs`
- `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`
- `/Users/seanhan/Documents/Playground/src/lark-plugin-dispatch-adapter.mjs`

### Read Surface

- `/Users/seanhan/Documents/Playground/src/read-runtime.mjs`
- `/Users/seanhan/Documents/Playground/src/index-read-authority.mjs`
- `/Users/seanhan/Documents/Playground/src/company-brain-query.mjs`
- `/Users/seanhan/Documents/Playground/src/derived-read-authority.mjs`

### Answer Surface

- `/Users/seanhan/Documents/Playground/src/lark-plugin-dispatch-adapter.mjs`
- `/Users/seanhan/Documents/Playground/src/planner-user-input-edge.mjs`
- `/Users/seanhan/Documents/Playground/src/executive-planner.mjs`
- `/Users/seanhan/Documents/Playground/src/retry-context-pack.mjs`
- `/Users/seanhan/Documents/Playground/src/planner-ingress-contract.mjs`
- `/Users/seanhan/Documents/Playground/src/user-response-normalizer.mjs`
- `/Users/seanhan/Documents/Playground/src/answer-source-mapper.mjs`
- `/Users/seanhan/Documents/Playground/src/usage-eval-runner.mjs`
  - evaluation-only runner for multi-turn usage-layer/decision-engine measurement (non-runtime control path)
- `/Users/seanhan/Documents/Playground/src/answer-service.mjs`
  - real file, but secondary helper rather than the main public `/answer` path
- Current truth:
  - the checked-in official plugin ingress first lands on `/Users/seanhan/Documents/Playground/src/lark-plugin-dispatch-adapter.mjs`
  - `/answer` still exists as a direct ingress surface, but `LARK_DIRECT_INGRESS_PRIMARY_ENABLED=false` keeps it marked as non-primary
  - planner working-memory continuation now also uses `retry-context-pack.mjs` as a bounded internal helper for retry/resume context tagging; the helper does not expose a new public route or response contract

### Skill Runtime And Telemetry Spec

- `/Users/seanhan/Documents/Playground/src/skill-runtime.mjs`
- `/Users/seanhan/Documents/Playground/src/planner/tool-loop-with-feedback.mjs`
- `/Users/seanhan/Documents/Playground/src/planner/render-execution-result.mjs`
- `/Users/seanhan/Documents/Playground/src/planner/skill-bridge.mjs`
- `/Users/seanhan/Documents/Playground/src/planner-autonomous-workflow.mjs`
- `/Users/seanhan/Documents/Playground/src/planner-visible-skill-observability.mjs`
- `/Users/seanhan/Documents/Playground/src/planner-visible-live-telemetry-spec.mjs`
- `/Users/seanhan/Documents/Playground/src/planner-visible-live-telemetry-adapter.mjs`
- `/Users/seanhan/Documents/Playground/src/planner-visible-live-telemetry-runtime.mjs`
- Current truth:
  - planner-visible coexistence watch is implemented as a checked-in fixture pack
  - live telemetry schema/metrics/rollback definitions are checked in and enforced by a dedicated runtime helper
  - planner-visible runtime now emits minimal spec-constrained events through an injected telemetry adapter
- `planner-autonomous-workflow.mjs` is a planner-driven loop helper for bounded internal agent e2e validation:
  - exposes `runAgentE2E(userInput, ctx)` and compatibility wrapper `runAutonomousWorkflow(...)`
  - each turn uses planner decision (`selectPlannerTool`) -> skill hint resolution (`skill-registry`) -> tool-layer execution -> continuation decision (`resolveToolResultContinuation`)
  - tool-layer execution keeps one contract shape and requires an injected executor adapter for real dispatch coupling; `runAgentE2E(...)` now preflights this dependency and fail-soft stops early with `terminal_reason=tool_executor_missing` before any partial step execution
  - `runAgentE2E(...)` now enforces a request-level latency budget guard (`AGENT_E2E_BUDGET_MS`, default `5000ms`) and computes `request_deadline_at = Date.now() + request_budget_ms`, then propagates both values into runtime context for each step/tool call
  - each loop now checks deadline before planner execution, dynamically clamps usable step count from remaining budget, and exits as `terminal_reason=agent_e2e_budget_exhausted` / `latency_budget_step_cap` when time pressure is too high
  - tool execution timeout now uses `min(step_timeout, remaining_budget)` (`AGENT_E2E_STEP_TIMEOUT_MS` / `AGENT_E2E_HARD_TIMEOUT_MS` compatible), and when remaining budget drops below fast-fail threshold (`AGENT_E2E_FAST_FAIL_MS`, default `200ms`) tool calls are skipped fail-soft
  - emits debug traces for chosen skills, routing decisions, and continuation state
  - diagnostics logs now include ingress enter, before planner decision, before tool execution, after tool execution, before continuation decision, and terminal exit
  - it is not used as a parallel HTTP `/answer` ingress runtime authority
  - direct `/answer` now stays on a single planner answer-edge runtime (`runPlannerUserInputEdge -> executePlannedUserInput`) and applies one bounded early-abort budget window (default `5000ms`, configurable via `ANSWER_LATENCY_BUDGET_MS` or `AGENT_E2E_BUDGET_MS`)
  - it is still not exposed as a separate public ingress route and not the primary plugin dispatch path
  - the default adapter remains in-memory and the mock structured-log adapter is local-only
  - no production telemetry pipeline is wired from this subtree yet

### Task Layer Helper

- `/Users/seanhan/Documents/Playground/src/task-layer`
- Current truth:
  - contains a keyword task classifier, a static dependency-order helper, a static task-to-skill map, a small result aggregator, and a callback-based orchestrator
  - the checked-in task execution order is currently `copywriting -> image -> publish`
  - can be consulted by `/Users/seanhan/Documents/Playground/src/executive-planner.mjs` as an optional pre-pass when the caller supplies `runSkill`
  - the checked-in public route surfaces do not currently pass that callback, so the default `/answer` path is unchanged
  - not wired into the checked-in skill runtime registry
  - useful as an internal helper subtree for task decomposition experiments

### Write Surface

- `/Users/seanhan/Documents/Playground/src/external-mutation-registry.mjs`
- `/Users/seanhan/Documents/Playground/src/write-policy-contract.mjs`
- `/Users/seanhan/Documents/Playground/src/write-policy-enforcement.mjs`
- `/Users/seanhan/Documents/Playground/src/lark-mutation-runtime.mjs`
- `/Users/seanhan/Documents/Playground/src/mutation-runtime.mjs`
- `/Users/seanhan/Documents/Playground/src/execute-lark-write.mjs`

### Company-Brain Governance

- `/Users/seanhan/Documents/Playground/src/company-brain-write-intake.mjs`
- `/Users/seanhan/Documents/Playground/src/company-brain-review.mjs`
- `/Users/seanhan/Documents/Playground/src/company-brain-lifecycle-contract.mjs`
- `/Users/seanhan/Documents/Playground/src/company-brain-learning.mjs`

### Workflow Modules

- `/Users/seanhan/Documents/Playground/src/doc-comment-rewrite.mjs`
- `/Users/seanhan/Documents/Playground/src/comment-suggestion-workflow.mjs`
- `/Users/seanhan/Documents/Playground/src/meeting-agent.mjs`
- `/Users/seanhan/Documents/Playground/src/meeting-audio-capture.mjs`
- `/Users/seanhan/Documents/Playground/src/cloud-doc-organization-workflow.mjs`

### Knowledge Helpers

- `/Users/seanhan/Documents/Playground/src/knowledge`
- `/Users/seanhan/Documents/Playground/src/planner/knowledge-bridge.mjs`
- Current truth:
  - implemented and tested
  - useful for system-knowledge and planner helper scenarios
  - not the main public read/write surface for Lark data

### Process-Local Experimental Memory

- `/Users/seanhan/Documents/Playground/src/company-brain-memory-authority.mjs`
- `/Users/seanhan/Documents/Playground/src/memory-write-guard.mjs`
- `/Users/seanhan/Documents/Playground/src/memory-write-detector.mjs`
- Current truth:
  - implemented
  - not the canonical company-brain runtime authority

## Non-Canonical or Historical Areas

- extracted or project-adjacent analysis files in repo root are not part of the runtime contract
- frozen migration baselines remain useful as history, but they are not the primary system explanation
- when in doubt, prefer:
  1. this `docs/system` mirror
  2. the truth matrix
  3. the checked-in tests for the specific surface

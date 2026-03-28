# Open Questions

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## High

1. The local machine may still regress into running both Playground long-connection runtime and a separate external Lobster/OpenClaw responder stack if Playground is not the process that starts last.
   - Why it matters:
     - dual long-connection services create path drift, debugging confusion, and uncertainty about which code path actually replied in Lark
   - Confirmed runtime evidence:
      - historical collision involved `com.seanhan.lark-kb-http`
      - historical collision involved `ai.openclaw.gateway`
      - historical collision involved `lobster.gateway`
      - historical collision involved `lobster.core`
      - historical collision involved `lobster.worker`
   - Current mitigation in code:
      - `/Users/seanhan/Documents/Playground/src/runtime-conflict-guard.mjs` disables configured competing LaunchAgents when Playground boots
   - Remaining limitation:
      - the guard only runs when Playground itself starts, so an operator can still manually re-enable another responder later

2. `http-server.mjs` is carrying too much responsibility.
   - Why it matters:
     - route method contracts are now externalized, but domain handlers still live in one file
   - Files:
      - `/Users/seanhan/Documents/Playground/src/http-server.mjs`
      - `/Users/seanhan/Documents/Playground/src/http-route-contracts.mjs`

3. Comment-driven rewrite now has patch-plan preview / confirm, and generic doc update now has minimal heading-targeted insert planning, but rewrite materialization still depends on a full-doc replace write.
   - Why it matters:
     - targeted manual insert is now possible for unique markdown headings, but the underlying Lark doc write path is still replace-based
   - Files:
      - `/Users/seanhan/Documents/Playground/src/doc-comment-rewrite.mjs`
      - `/Users/seanhan/Documents/Playground/src/doc-targeting.mjs`
      - `/Users/seanhan/Documents/Playground/src/lark-content.mjs`
      - `/Users/seanhan/Documents/Playground/src/doc-preview-cards.mjs`

4. OAuth scope groups are now documented, but the exact production permission set still depends on Lark console configuration outside this repo.
   - Why it matters:
     - code and docs now point to the scope families, but the actual granted app scopes remain an external dependency
   - Files:
      - `/Users/seanhan/Documents/Playground/src/config.mjs`
      - `/Users/seanhan/Documents/Playground/.env.example`
      - `/Users/seanhan/Documents/Playground/README.md`

5. Token and account state are still local-first, even though optional encryption and strict file permissions were added.
   - Why it matters:
     - practical for local use, but still not equivalent to a managed secret store
   - Files:
      - `/Users/seanhan/Documents/Playground/src/db.mjs`
      - `/Users/seanhan/Documents/Playground/src/rag-repository.mjs`
      - `/Users/seanhan/Documents/Playground/src/secret-crypto.mjs`

6. Live Lark write hard-stops now support tenant allow-lists, but the repo still does not carry a checked-in canonical sandbox tenant mapping.
   - Why it matters:
     - `ALLOW_LARK_WRITES` is now fail-closed, and `LARK_WRITE_ALLOWED_TENANT_KEYS` / `LARK_WRITE_SANDBOX_TENANT_KEYS` can constrain live vs sandbox tenants
     - but tenant isolation is only as strong as the deployed env configuration; the repo itself cannot prove which tenant is the intended sandbox
   - Files:
     - `/Users/seanhan/Documents/Playground/src/lark-write-guard.mjs`
     - `/Users/seanhan/Documents/Playground/src/http-server.mjs`
     - `/Users/seanhan/Documents/Playground/docs/system/api_map.md`

## Medium

7. Retrieval now has a local semantic embedding sidecar, but not an external vector store.
  - Files:
      - `/Users/seanhan/Documents/Playground/src/answer-service.mjs`
      - `/Users/seanhan/Documents/Playground/src/rag-repository.mjs`
      - `/Users/seanhan/Documents/Playground/src/semantic-embeddings.mjs`

8. `mutation_admission_contract_v1.md` is frozen, but the current Step 2 implementation is intentionally carrying two operator-directed field corrections.
   - Why it matters:
     - the frozen baseline text still says `meeting_confirm` and `create_doc -> drive_folder`
     - the checked-in Step 2 builder layer now uses `meeting_confirm_write` and `create_doc.resource_type = doc_container`
     - later contributors must not assume the frozen markdown and the checked-in builder outputs are identical
   - Current code truth:
     - `/Users/seanhan/Documents/Playground/src/mutation-admission.mjs`
   - Frozen baseline:
     - `/Users/seanhan/Documents/Playground/docs/system/mutation_admission_contract_v1.md`

9. `lobster_security` is a separate Python subproject with its own architecture boundary.
   - Why it matters:
     - runtime contract mismatch is now visible, but still requires humans to keep both sides aligned
   - Files:
      - `/Users/seanhan/Documents/Playground/src/lobster-security-bridge.mjs`
      - `/Users/seanhan/Documents/Playground/src/runtime-contract.mjs`
      - `/Users/seanhan/Documents/Playground/lobster_security`

10. Semantic organization no longer hard-depends on OpenClaw, but local fallback quality is weaker.
   - Files:
      - `/Users/seanhan/Documents/Playground/src/lark-drive-semantic-classifier.mjs`

11. Bitable / Sheet APIs now include batch helpers, but higher-level workflow contracts are still not fully productized.
   - Files:
      - `/Users/seanhan/Documents/Playground/README.md`
      - `/Users/seanhan/Documents/Playground/lark_feishu_capability_gap.md`
      - `/Users/seanhan/Documents/Playground/src/config.mjs`
      - `/Users/seanhan/Documents/Playground/src/http-server.mjs`

12. The repo now has a thin executive planner and downstream registered agents, but it still does not have background workers, parallel subagent execution, or a tenant-wide memory graph.
   - Why it matters:
      - future docs should describe this as a checked-in executive orchestration layer, not as a fully autonomous company-brain system

13. New-comment suggestion cards now support timer/manual polling, but there is still no native Lark comment event trigger entering this repo.
   - Why it matters:
     - true automatic push still depends on polling or an upstream trigger

14. Provider-side prompt caching cannot be confirmed from this repo's current OpenAI-compatible HTTP client.
   - Why it matters:
     - cache-friendly stable prefixes are now implemented in prompt assembly
     - but there is still no repo-visible vendor flag or billing signal proving upstream prompt caching is actually enabled
   - Files:
     - `/Users/seanhan/Documents/Playground/src/answer-service.mjs`
     - `/Users/seanhan/Documents/Playground/src/doc-comment-rewrite.mjs`
     - `/Users/seanhan/Documents/Playground/src/agent-token-governance.mjs`

15. Workflow checkpoints are now externalized, but they are still local JSON state rather than a shared multi-runtime store.
   - Why it matters:
     - this solves token replay in the current local service
     - but it is still local-first state, not a tenant-wide checkpoint service
   - Files:
     - `/Users/seanhan/Documents/Playground/src/agent-workflow-state.mjs`
     - `/Users/seanhan/Documents/Playground/src/config.mjs`

16. `/meeting` is now available, and a real slash-agent registry exists, but `/meeting` still remains a specialized workflow rather than a planner-managed delegated subtask.
   - Why it matters:
     - future contributors should not describe `/meeting` as evidence of a broader planner/specialist agent framework
   - Files:
     - `/Users/seanhan/Documents/Playground/src/meeting-agent.mjs`
     - `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`
     - `/Users/seanhan/Documents/Playground/src/http-server.mjs`

17. MiniMax speech-transcription API contract is not yet confirmed from this repo or the checked-in local config.
   - Why it matters:
     - the repo now defaults meeting transcription to local `faster-whisper` instead of pretending the existing MiniMax M2.5 text path can also transcribe audio
   - Files:
     - `/Users/seanhan/Documents/Playground/src/config.mjs`
     - `/Users/seanhan/Documents/Playground/src/meeting-audio-capture.mjs`
     - `/Users/seanhan/Documents/Playground/docs/system/deployment.md`

17. OpenClaw's checked-in local config shape does not confirm repo-visible `temperature` / `top_p` support for MiniMax M2.5.
   - Why it matters:
     - this repo now hardens the repo-controlled LLM call paths with `temperature=0.1`, clamped `top_p=0.7~0.8`, XML prompt rules, and malformed-JSON retries
     - but the exact provider-native sampling contract for the external OpenClaw runtime still cannot be proven from the local JSON config alone
   - Files:
     - `/Users/seanhan/.openclaw/openclaw.json`
     - `/Users/seanhan/Documents/Playground/src/config.mjs`
     - `/Users/seanhan/Documents/Playground/src/lark-drive-semantic-classifier.mjs`

18. `README.md` still documents `/answer` as direct-LLM-or-extractive, while code now prefers the local OpenClaw MiniMax text path before any retrieval-summary fallback.
   - Why it matters:
     - external reviewers reading only `README.md` will misunderstand the real answer chain and may think the system is simpler and less grounded than the checked-in code
   - Current code truth:
     - `/Users/seanhan/Documents/Playground/src/answer-service.mjs`
     - `/Users/seanhan/Documents/Playground/src/openclaw-text-service.mjs`
   - Conflicting doc:
     - `/Users/seanhan/Documents/Playground/README.md`

19. Planner-side runtime-info support exists, but top-level lane heuristics still do not guarantee that a generic runtime query reaches planner mode.
   - Why it matters:
     - `executive-planner.mjs` and `planner-runtime-info-flow.mjs` both support `get_runtime_info`, but the top-level capability lane still only forwards clearly knowledge-like requests into planner execution
     - plain runtime questions without a knowledge-style cue no longer get a default-reply fallback, but they can still stop as `ROUTING_NO_MATCH` in personal/group lane instead of reaching planner mode
   - Current code truth:
     - `/Users/seanhan/Documents/Playground/src/capability-lane.mjs`
     - `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`
     - `/Users/seanhan/Documents/Playground/src/executive-planner.mjs`
     - `/Users/seanhan/Documents/Playground/src/planner-runtime-info-flow.mjs`
   - Related mirror note:
   - `/Users/seanhan/Documents/Playground/docs/system/routing_eval_system.md` therefore treats runtime-info coverage as a deterministic planner-adapter baseline, not as proof that every live runtime query already reaches planner end-to-end

20. Write-policy runtime rollout stats now read local trace evidence, but the repo still cannot distinguish real user traffic from test-generated trace samples.
   - Why it matters:
     - `meeting_confirm_write` enforcement rollout should ideally rely on request-backed traffic with acceptable violation rate
     - current diagnostics can tell `request_trace` vs detached `action_trace`, but cannot prove whether a request-backed sample came from production-like usage or from tests run on the same machine
   - Current code truth:
     - `/Users/seanhan/Documents/Playground/src/control-diagnostics.mjs`
     - `/Users/seanhan/Documents/Playground/src/monitoring-store.mjs`
     - `/Users/seanhan/Documents/Playground/src/runtime-observability.mjs`

21. Read-runtime final audit still has a small set of intentional bypass callers outside the public read route surface.
   - Why it matters:
     - public company-brain, approved-company-brain, live doc/comment, and index search reads now route through `read-runtime.mjs`
     - but mutation-side review/verification helpers and local checked-in `docs/system` knowledge helpers still read state directly, so final audit needs an explicit keep-vs-unify decision instead of assuming full repo-wide read unification already exists
   - Confirmed remaining bypass callers:
     - `/Users/seanhan/Documents/Playground/src/company-brain-review.mjs`
     - `/Users/seanhan/Documents/Playground/src/company-brain-learning.mjs`
     - `/Users/seanhan/Documents/Playground/src/mutation-verifier.mjs`
     - `/Users/seanhan/Documents/Playground/src/knowledge/knowledge-service.mjs`
     - `/Users/seanhan/Documents/Playground/src/planner/knowledge-bridge.mjs`
   - Current code truth:
     - `/Users/seanhan/Documents/Playground/src/read-runtime.mjs`
     - `/Users/seanhan/Documents/Playground/src/derived-read-authority.mjs`

22. `mutation-runtime.mjs` now has its own in-process idempotency replay cache in addition to the persisted HTTP idempotency layer.
   - Why it matters:
     - runtime writes can now short-circuit on repeated `context.idempotency_key` without re-running admission, verification, or execute
     - overlapping retries now receive fail-soft `idempotency_in_progress` while the first call is still running, and only completed successes are replayed afterwards
     - non-success runtime paths clear the temporary pending marker, so retry safety now depends on both state transitions and the still-separate persisted HTTP layer
     - the cache is process-local and keyed only by the explicit context key, so it does not yet share the wider HTTP scope contract of `method + pathname + account_id + idempotency_key`
     - later contributors need an explicit keep / narrow / replace decision instead of assuming runtime idempotency still only means the persisted HTTP layer
   - Current code truth:
     - `/Users/seanhan/Documents/Playground/src/mutation-runtime.mjs`
   - Related mirror docs:
     - `/Users/seanhan/Documents/Playground/docs/system/api_map.md`
     - `/Users/seanhan/Documents/Playground/docs/system/write_policy_unification.md`

## Cannot Be Confirmed From Code Alone

- whether any hosted deployment exists outside the local machine
- whether OpenClaw is always available in production usage
- the exact Lark app permissions currently granted in the tenant console

# Open Questions

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## High

1. The local machine may run both Playground long-connection runtime and a separate `ai-server` Lobster stack at the same time.
   - Why it matters:
     - dual long-connection services create path drift, debugging confusion, and uncertainty about which code path actually replied in Lark
   - Confirmed runtime evidence:
      - `com.seanhan.lark-kb-http`
      - `lobster.gateway`
      - `lobster.core`
      - `lobster.worker`

2. `http-server.mjs` is carrying too much responsibility.
   - Why it matters:
     - route method contracts are now externalized, but domain handlers still live in one file
   - Files:
      - `/Users/seanhan/Documents/Playground/src/http-server.mjs`
      - `/Users/seanhan/Documents/Playground/src/http-route-contracts.mjs`

3. Comment-driven rewrite now has patch-plan preview / confirm, but final materialization still depends on a doc replace write.
   - Why it matters:
     - patch semantics and suggestion cards are clearer, but the underlying Lark doc write path is still replace-based
   - Files:
      - `/Users/seanhan/Documents/Playground/src/doc-comment-rewrite.mjs`
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
      - `/Users/seanhan/Documents/Playground/src/token-store.mjs`
      - `/Users/seanhan/Documents/Playground/src/secret-crypto.mjs`
      - `/Users/seanhan/Documents/Playground/src/db.mjs`

## Medium

6. Retrieval now has a local semantic embedding sidecar, but not an external vector store.
   - Files:
      - `/Users/seanhan/Documents/Playground/src/answer-service.mjs`
      - `/Users/seanhan/Documents/Playground/src/rag-repository.mjs`
      - `/Users/seanhan/Documents/Playground/src/semantic-embeddings.mjs`

7. `lobster_security` is a separate Python subproject with its own architecture boundary.
   - Why it matters:
     - runtime contract mismatch is now visible, but still requires humans to keep both sides aligned
   - Files:
      - `/Users/seanhan/Documents/Playground/src/lobster-security-bridge.mjs`
      - `/Users/seanhan/Documents/Playground/src/runtime-contract.mjs`
      - `/Users/seanhan/Documents/Playground/lobster_security`

8. Semantic organization no longer hard-depends on OpenClaw, but local fallback quality is weaker.
   - Files:
      - `/Users/seanhan/Documents/Playground/src/lark-drive-semantic-classifier.mjs`

9. Bitable / Sheet APIs now include batch helpers, but higher-level workflow contracts are still not fully productized.
   - Files:
      - `/Users/seanhan/Documents/Playground/README.md`
      - `/Users/seanhan/Documents/Playground/lark_feishu_capability_gap.md`
      - `/Users/seanhan/Documents/Playground/src/config.mjs`
      - `/Users/seanhan/Documents/Playground/src/http-server.mjs`

10. This repo is an AI-enabled tool service, but not a planner/router/specialist architecture.
    - Why it matters:
      - future docs or contributors may over-describe it if they import assumptions from another Lobster repo

11. Binding/session/workspace keys and capability lanes now exist, but there is still no downstream agent registry consuming them.
   - Why it matters:
     - the scoping foundation and first lane split are implemented, but future assistant routing still needs a deeper capability binding layer
   - Files:
      - `/Users/seanhan/Documents/Playground/src/binding-runtime.mjs`
      - `/Users/seanhan/Documents/Playground/src/capability-lane.mjs`
      - `/Users/seanhan/Documents/Playground/src/index.mjs`

12. New-comment suggestion cards now support timer/manual polling, but there is still no native Lark comment event trigger entering this repo.
   - Why it matters:
     - true automatic push still depends on polling or an upstream trigger

13. Provider-side prompt caching cannot be confirmed from this repo's current OpenAI-compatible HTTP client.
   - Why it matters:
     - cache-friendly stable prefixes are now implemented in prompt assembly
     - but there is still no repo-visible vendor flag or billing signal proving upstream prompt caching is actually enabled
   - Files:
     - `/Users/seanhan/Documents/Playground/src/answer-service.mjs`
     - `/Users/seanhan/Documents/Playground/src/doc-comment-rewrite.mjs`
     - `/Users/seanhan/Documents/Playground/src/agent-token-governance.mjs`

14. Workflow checkpoints are now externalized, but they are still local JSON state rather than a shared multi-runtime store.
   - Why it matters:
     - this solves token replay in the current local service
     - but it is still local-first state, not a tenant-wide checkpoint service
   - Files:
     - `/Users/seanhan/Documents/Playground/src/agent-workflow-state.mjs`
     - `/Users/seanhan/Documents/Playground/src/config.mjs`

15. `/meeting` is now available, but it is implemented as a command-style lane/HTTP workflow because this repo still has no real slash-agent registry.
   - Why it matters:
     - future contributors should not describe `/meeting` as evidence of a broader planner/specialist agent framework
   - Files:
     - `/Users/seanhan/Documents/Playground/src/meeting-agent.mjs`
     - `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`
     - `/Users/seanhan/Documents/Playground/src/http-server.mjs`

## Cannot Be Confirmed From Code Alone

- whether any hosted deployment exists outside the local machine
- whether OpenClaw is always available in production usage
- the exact Lark app permissions currently granted in the tenant console

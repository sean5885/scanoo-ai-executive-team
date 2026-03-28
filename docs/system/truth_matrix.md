# Truth Matrix

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This is the newcomer-first truth table for the current system.

Read it together with:

- [modules.md](/Users/seanhan/Documents/Playground/docs/system/modules.md)
- [data_flow.md](/Users/seanhan/Documents/Playground/docs/system/data_flow.md)
- [write_policy_unification.md](/Users/seanhan/Documents/Playground/docs/system/write_policy_unification.md)

## 1. Module Truth Matrix

| Module area | Implemented | Primary files | Test coverage |
| --- | --- | --- | --- |
| HTTP runtime and routing | yes | `/Users/seanhan/Documents/Playground/src/http-server.mjs`, `/Users/seanhan/Documents/Playground/src/http-route-contracts.mjs` | `/Users/seanhan/Documents/Playground/tests/http-server.route-success.test.mjs`, `/Users/seanhan/Documents/Playground/tests/http-server.trace.test.mjs`, `/Users/seanhan/Documents/Playground/tests/http-monitoring.test.mjs` |
| Read runtime | yes | `/Users/seanhan/Documents/Playground/src/read-runtime.mjs`, `/Users/seanhan/Documents/Playground/src/index-read-authority.mjs`, `/Users/seanhan/Documents/Playground/src/company-brain-query.mjs`, `/Users/seanhan/Documents/Playground/src/derived-read-authority.mjs` | `/Users/seanhan/Documents/Playground/tests/read-runtime.test.mjs`, `/Users/seanhan/Documents/Playground/tests/company-brain-query.test.mjs` |
| Public answer surface | yes | `/Users/seanhan/Documents/Playground/src/executive-planner.mjs`, `/Users/seanhan/Documents/Playground/src/user-response-normalizer.mjs`, `/Users/seanhan/Documents/Playground/src/answer-source-mapper.mjs`, `/Users/seanhan/Documents/Playground/src/http-server.mjs` | `/Users/seanhan/Documents/Playground/tests/executive-planner.test.mjs`, `/Users/seanhan/Documents/Playground/tests/user-response-normalizer.test.mjs`, `/Users/seanhan/Documents/Playground/tests/http-server.route-success.test.mjs` |
| `answer-service` helper | yes, secondary | `/Users/seanhan/Documents/Playground/src/answer-service.mjs` | `/Users/seanhan/Documents/Playground/tests/answer-service.test.mjs`, `/Users/seanhan/Documents/Playground/tests/long-task-governance.test.mjs` |
| External mutation runtime | yes | `/Users/seanhan/Documents/Playground/src/external-mutation-registry.mjs`, `/Users/seanhan/Documents/Playground/src/write-policy-contract.mjs`, `/Users/seanhan/Documents/Playground/src/lark-mutation-runtime.mjs`, `/Users/seanhan/Documents/Playground/src/mutation-runtime.mjs`, `/Users/seanhan/Documents/Playground/src/execute-lark-write.mjs` | `/Users/seanhan/Documents/Playground/tests/mutation-admission.test.mjs`, `/Users/seanhan/Documents/Playground/tests/write-policy-contract.test.mjs`, `/Users/seanhan/Documents/Playground/tests/mutation-runtime.test.mjs`, `/Users/seanhan/Documents/Playground/tests/lark-mutation-runtime.test.mjs`, `/Users/seanhan/Documents/Playground/tests/execute-lark-write.test.mjs` |
| Company-brain mirror/read/governance | yes, partial-by-design | `/Users/seanhan/Documents/Playground/src/company-brain-write-intake.mjs`, `/Users/seanhan/Documents/Playground/src/company-brain-query.mjs`, `/Users/seanhan/Documents/Playground/src/company-brain-review.mjs`, `/Users/seanhan/Documents/Playground/src/company-brain-lifecycle-contract.mjs` | `/Users/seanhan/Documents/Playground/tests/company-brain-write-intake.test.mjs`, `/Users/seanhan/Documents/Playground/tests/company-brain-review-approval.test.mjs`, `/Users/seanhan/Documents/Playground/tests/company-brain-lifecycle-contract.test.mjs`, `/Users/seanhan/Documents/Playground/tests/http-server.route-success.test.mjs` |
| Comment rewrite workflow | yes | `/Users/seanhan/Documents/Playground/src/doc-comment-rewrite.mjs`, `/Users/seanhan/Documents/Playground/src/http-server.mjs` | `/Users/seanhan/Documents/Playground/tests/doc-comment-rewrite.test.mjs`, `/Users/seanhan/Documents/Playground/tests/control-unification-phase2-doc-rewrite.test.mjs` |
| Meeting workflow | yes | `/Users/seanhan/Documents/Playground/src/meeting-agent.mjs`, `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`, `/Users/seanhan/Documents/Playground/src/meeting-audio-capture.mjs` | `/Users/seanhan/Documents/Playground/tests/meeting-agent.test.mjs`, `/Users/seanhan/Documents/Playground/tests/control-unification-phase2-meeting.test.mjs`, `/Users/seanhan/Documents/Playground/tests/meeting-audio-capture.test.mjs` |
| Semantic classifier | yes | `/Users/seanhan/Documents/Playground/src/lark-drive-semantic-classifier.mjs` | `/Users/seanhan/Documents/Playground/tests/lark-drive-semantic-classifier.test.mjs` |
| OpenClaw plugin adapter | yes | `/Users/seanhan/Documents/Playground/openclaw-plugin/lark-kb/index.ts` | `/Users/seanhan/Documents/Playground/tests/openclaw-plugin-regression.test.mjs` |
| System-knowledge helper | yes, secondary | `/Users/seanhan/Documents/Playground/src/knowledge/knowledge-service.mjs`, `/Users/seanhan/Documents/Playground/src/planner/knowledge-bridge.mjs` | `/Users/seanhan/Documents/Playground/tests/knowledge-service.test.mjs` |
| Process-local memory helper | yes, non-canonical | `/Users/seanhan/Documents/Playground/src/company-brain-memory-authority.mjs`, `/Users/seanhan/Documents/Playground/src/memory-write-guard.mjs`, `/Users/seanhan/Documents/Playground/src/memory-write-detector.mjs` | `/Users/seanhan/Documents/Playground/tests/memory-write-detector.test.mjs`, `/Users/seanhan/Documents/Playground/tests/memory-authority-write-routing.test.mjs` |

## 2. Main Path Matrix

| Path | Entry surface | Current runtime chain | Current state | Coverage |
| --- | --- | --- | --- | --- |
| `read` | `/search`, `/api/company-brain/*`, `/agent/company-brain/*`, `/api/doc/read` | `http-server -> read-runtime -> authority module` | implemented | `/Users/seanhan/Documents/Playground/tests/read-runtime.test.mjs`, `/Users/seanhan/Documents/Playground/tests/http-server.route-success.test.mjs` |
| `write` | doc/drive/wiki/message/calendar/task/bitable/sheet routes, meeting capture writes, meeting confirm write | `route or lane -> canonical request -> lark-mutation-runtime -> mutation-runtime -> execute-lark-write` | implemented | `/Users/seanhan/Documents/Playground/tests/write-policy-contract.test.mjs`, `/Users/seanhan/Documents/Playground/tests/mutation-runtime.test.mjs`, `/Users/seanhan/Documents/Playground/tests/lark-mutation-runtime.test.mjs`, `/Users/seanhan/Documents/Playground/tests/meeting-agent.test.mjs` |
| `answer` | `/answer`, knowledge-assistant chat lane | `planner -> execution -> normalizeUserResponse -> answer-source-mapper` | implemented | `/Users/seanhan/Documents/Playground/tests/executive-planner.test.mjs`, `/Users/seanhan/Documents/Playground/tests/user-response-normalizer.test.mjs` |

## 3. Policy-Only or Not Fully Landed

| Item | State | Why it is not marked implemented |
| --- | --- | --- |
| background worker mesh | policy-only | no checked-in worker runtime or scheduler mesh |
| full autonomous company-brain server | policy-only | current repo has mirror ingest, read-side views, and partial governance paths only |
| repo-wide complete read unification | incomplete | some review/verification helpers still read state directly |
| targeted block-level doc mutation | incomplete | preview/planning exists, final write path is still bounded by current doc replace/update adapter |
| single universal idempotency model | incomplete | HTTP persisted idempotency and runtime-local mutation idempotency are separate layers |

## 4. Deprecated or Historical Readings

| Reading | Current status | Replacement |
| --- | --- | --- |
| `/answer` is mainly `answer-service.mjs` | outdated | planner-first public answer path |
| Phase 1 mutation mapping is the full write inventory | outdated | registry-backed write inventory |
| verified mirror ingest equals formal approved knowledge | outdated | mirror, review, approved, and applied are separate states |
| meeting workflow proves a generic planner-managed agent team | outdated | specialized workflow with executive adjacency only |

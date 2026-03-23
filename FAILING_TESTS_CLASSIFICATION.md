Failing test classification:

## A. Likely unrelated / pre-existing
- tests/agent-learning-loop.test.mjs
- tests/http-monitoring.test.mjs

## B. Needs verification (possible regression)
- tests/agent-dispatcher.test.mjs
- tests/agent-registry.test.mjs
- tests/executive-orchestrator.test.mjs
- tests/http-server.route-success.test.mjs

## C. Confirmed regression (only if proven)
- (to be filled after investigation)

Rules:
- do NOT change workflow output shape
- do NOT change planner decision contract
- do NOT touch evidence-first response
- fix only agent internal behavior or test expectation mismatch

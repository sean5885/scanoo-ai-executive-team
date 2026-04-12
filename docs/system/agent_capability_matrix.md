# Agent Capability Matrix

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This matrix is the maintainable source for:

- command to agent mapping
- minimum input/output contract
- allowed tools
- downstream consumer
- fallback behavior
- readiness status

## Matrix

| Agent | Command | Input | Output | Allowed Tools | Downstream | Status | Test |
| --- | --- | --- | --- | --- | --- | --- | --- |
| generalist | `/generalist` | text, scope, optional image context | `text`, `agentId` | knowledge_search, image_understanding, text_generation | Lark reply | ready | `tests/chain-smoke.test.mjs` |
| planner_agent | `/planner` | text, scope, optional route context | `text`, `agentId` | planner_tool_dispatch, runtime_info_read | Lark reply | ready | `tests/agent-registry.test.mjs` |
| company_brain_agent | `/company-brain` | text, scope, optional doc query context | `text`, `agentId` | company_brain_list, company_brain_search, company_brain_detail | Lark reply | ready | `tests/agent-registry.test.mjs` |

## Notes

- Meeting flow remains command/workflow-based rather than a slash persona agent.
- `/knowledge *` is no longer a registered agent command surface; it is fail-closed as `ROUTING_NO_MATCH`.
- Image tasks use the Nano Banana-oriented Gemini path first, then only pass compact structured fields into downstream text processing.
- Capability contract truth lives in `/Users/seanhan/Documents/Playground/src/agent-registry.mjs`; this file mirrors it for human review.

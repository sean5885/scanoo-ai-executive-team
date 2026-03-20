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
| ceo | `/ceo` | text, scope, optional image context | `text`, `agentId` | knowledge_search, image_understanding, text_generation | Lark reply | ready | `tests/chain-smoke.test.mjs` |
| product | `/product` | text, scope, optional image context | `text`, `agentId` | knowledge_search, image_understanding, text_generation | Lark reply | ready | `tests/chain-smoke.test.mjs` |
| prd | `/prd` | text, scope, optional image context | `text`, `agentId` | knowledge_search, image_understanding, text_generation | Lark reply | ready | `tests/chain-smoke.test.mjs` |
| cmo | `/cmo` | text, scope, optional image context | `text`, `agentId` | knowledge_search, image_understanding, text_generation | Lark reply | ready | `tests/chain-smoke.test.mjs` |
| consult | `/consult` | text, scope, optional image context | `text`, `agentId` | knowledge_search, image_understanding, text_generation | Lark reply | ready | `tests/chain-smoke.test.mjs` |
| cdo | `/cdo` | text, scope, optional image context | `text`, `agentId` | knowledge_search, image_understanding, text_generation | Lark reply | ready | `tests/chain-smoke.test.mjs` |
| delivery | `/delivery` | text, scope | `text`, `agentId` | knowledge_search, text_generation | Lark reply | ready | `tests/agent-registry.test.mjs` |
| ops | `/ops` | text, scope | `text`, `agentId` | knowledge_search, text_generation | Lark reply | ready | `tests/agent-registry.test.mjs` |
| tech | `/tech` | text, scope | `text`, `agentId` | knowledge_search, text_generation | Lark reply | ready | `tests/agent-registry.test.mjs` |
| knowledge-audit | `/knowledge audit` | text, scope | `text`, `agentId` | knowledge_search, semantic_classifier, image_understanding, text_generation | Lark reply | ready | `tests/chain-smoke.test.mjs` |
| knowledge-consistency | `/knowledge consistency` | text, scope | `text`, `agentId` | knowledge_search, semantic_classifier, text_generation | Lark reply | ready | `tests/system-self-check.test.mjs` |
| knowledge-conflicts | `/knowledge conflicts` | text, scope | `text`, `agentId` | knowledge_search, semantic_classifier, text_generation | Lark reply | ready | `tests/chain-integration.test.mjs` |
| knowledge-distill | `/knowledge distill` | text, scope | `text`, `agentId` | knowledge_search, text_generation | Lark reply | ready | `tests/system-self-check.test.mjs` |
| knowledge-brain | `/knowledge brain` | text, scope | `text`, `agentId` | knowledge_search, text_generation | Lark reply | ready | `tests/agent-registry.test.mjs` |
| knowledge-proposals | `/knowledge proposals` | text, scope | `text`, `agentId` | knowledge_search, semantic_classifier, text_generation | Lark reply | ready | `tests/system-self-check.test.mjs` |
| knowledge-approve | `/knowledge approve` | text, scope | `text`, `agentId` | knowledge_search, text_generation | Lark reply | ready | `tests/system-self-check.test.mjs` |
| knowledge-reject | `/knowledge reject` | text, scope | `text`, `agentId` | knowledge_search, text_generation | Lark reply | ready | `tests/system-self-check.test.mjs` |
| knowledge-ownership | `/knowledge ownership` | text, scope | `text`, `agentId` | knowledge_search, semantic_classifier, text_generation | Lark reply | ready | `tests/system-self-check.test.mjs` |
| knowledge-learn | `/knowledge learn` | text, scope | `text`, `agentId` | knowledge_search, semantic_classifier, text_generation | Lark reply | ready | `tests/system-self-check.test.mjs` |

## Notes

- Meeting flow remains command/workflow-based rather than a slash persona agent.
- Image tasks use the Nano Banana-oriented Gemini path first, then only pass compact structured fields into downstream text processing.
- Capability contract truth lives in `/Users/seanhan/Documents/Playground/src/agent-registry.mjs`; this file mirrors it for human review.

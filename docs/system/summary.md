# System Summary

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Core Capabilities

- system audit report for external architecture review:
  - [Lobster AI Executive System Audit Report v1](/Users/seanhan/Documents/Playground/docs/system/Lobster%20AI%20Executive%20System%20Audit%20Report%20v1.md)
- skill governance mirrors:
  - [Skill Routing Map](/Users/seanhan/Documents/Playground/docs/system/skill_routing_map.md)
  - [Skill Audit Summary](/Users/seanhan/Documents/Playground/docs/system/skill_audit_summary.md)
- Lark user OAuth
- Drive / Wiki / Doc browse and write
- local sync into SQLite
- hybrid retrieval (`FTS + local semantic embedding`)
- optional LLM answer generation
- message / calendar / task operations
- bitable / sheet / reaction / busy-free operations
- Bitable share-link parsing so pasted `base/...` URLs can resolve into app/table context
- comment-driven doc rewrite
- patch-plan preview before doc rewrite apply
- rewrite suggestion card for new document comments
- timer/manual poll workflow for watched comment suggestion cards
- OpenClaw plugin exposure
- guarded local action bridge
- binding / session / workspace runtime foundation
- capability-lane routing for DM / group / doc / knowledge requests
- closed-loop executive planner with shared multi-turn task state, evidence-based verification, reflection, and agent-to-agent handoff across registered agents
- bounded planner-side task driving v1 for unfinished / blocked / in-progress tasks, using local JSON task snapshots to suggest next steps, unblock actions, and minimal action-layer reminders without changing public planner contracts
- lane-specific execution strategies for DM / group / doc / knowledge requests
- structured runtime logging for long-connection event handling and doc resolution debugging
- prompt-budget governance, external workflow checkpoints, and tool-output compression for AI-heavy paths
- XML-governed prompts with anti-hallucination and user-intent self-check rules
- shared low-variance LLM settings (`temperature=0.1`, clamped `top_p=0.7~0.8`)
- text/image modality routing so image-only and image+text tasks can bypass the text path
- Nano Banana-oriented image understanding adapter that returns compact structured image fields before any optional text synthesis
- DM cloud-document classification preview with recommended owner-role mapping from local indexed docs
- `/meeting` workflow for chat-scoped meeting capture, optional calendar-backed session binding via `meeting_url`, optional local microphone recording, default local `faster-whisper` transcription, transcript compaction before summary prompting, optional meeting-image structuring, automatic per-meeting Lark doc creation, weekly/general meeting summarization, pending confirmation, doc write, and weekly todo tracking
- repo-local mirror for externally stored skills used by Lobster operations, including audited Traditional-Chinese first-batch governance docs

## Architecture Overview

This repo is a local Node service with a Python security subproject. It is not a browser app and not a fully autonomous multi-agent executive server, but it now includes a closed-loop executive orchestration layer for checked-in agents.

Main runtime shape:

- Node HTTP server
- optional Lark long connection listener
- SQLite local data store
- OpenClaw plugin calling local HTTP routes
- Python security wrapper for risky local actions

Architecture layer vs runtime layer is now split explicitly:

- [architecture.md](/Users/seanhan/Documents/Playground/docs/system/architecture.md)
  - code structure and module responsibilities
- [deployment.md](/Users/seanhan/Documents/Playground/docs/system/deployment.md)
  - process shape, runtime dependencies, and external boundaries

## Agent Overview

AI-like components exist, and now include:

- OpenClaw plugin tools
- OpenClaw-backed semantic classifier
- local semantic fallback classifier
- LLM answer generator
- LLM comment rewrite
- shared token-governance / checkpoint layer for those AI paths
- malformed JSON retry for MiniMax/OpenClaw semantic classification and meeting-summary JSON responses
- command-scoped `/meeting` workflow inside the capability-lane runtime
- checked-in slash-agent registry
- closed-loop executive planner
- shared per-session executive task state
- multi-turn continuation and agent handoff for registered agents

## Repo Scale

- main runtime code in `src/`
- plugin layer in `openclaw-plugin/`
- security wrapper subproject in `lobster_security/`

## Completed

- OAuth and account/token persistence
- Drive / Wiki / Doc operations
- Sync and FTS retrieval
- search and answer
- OpenClaw tool exposure
- secure local action bridge
- comment-driven doc rewrite workflow
- prompt slimming with stable section labels to improve cache-friendly prefixes for repeated LLM calls
- XML prompt wrapping and anti-hallucination guardrails for answer, rewrite, meeting-summary, and semantic-classifier flows
- shared compact system-prompt builder so answer / rewrite / meeting / classifier prompts do not repeat the same core rules

## Partial

- semantic organization quality
- assistant-like workflows around messages/comments/tasks
- stronger write safety
- runtime contract hardening between Node and `lobster_security`
- provider-side prompt caching cannot be confirmed from repo code, so the repo now uses stable prompt templates plus external checkpoints instead of re-sending large historical context each round
- the executive planner is still thin and synchronous; it does not yet run parallel subagents or a background queue

## Not Implemented

- company_brain
- agent learning pipeline
- unread-only semantics
- send-as-user
- task subtasks
- streaming card update

## Ten Most Important Architecture Questions

1. `http-server.mjs` 仍然很大，但 route contract 已外提，後續還要再拆 domain handlers。
2. Comment rewrite 已有 patch-plan preview 和 suggestion card，但最終寫回仍受 Lark doc API 限制，落地時仍是 replace。
3. OAuth scope 說明已補，但實際 Lark Developer Console 權限仍需人工核對。
4. Token 已可加密落地，但是否啟用取決於 `LARK_TOKEN_ENCRYPTION_SECRET`。
5. Retrieval 已有 local semantic embedding，但仍不是外部向量庫。
6. `lobster_security` 漂移風險已降到 runtime contract mismatch，不再是完全黑箱邊界。
7. Semantic classifier 現在可 local fallback，但 OpenClaw 品質仍高於本地規則。
8. Bitable / Sheet 已有 bulk-upsert / replace-batch，但 workflow 仍不算完整產品層。
9. hosted deployment topology 仍無法從 repo 確認。
10. closed-loop executive orchestration 已落地，但它仍不是背景 worker + 多 subagent 並行的完整 company brain。

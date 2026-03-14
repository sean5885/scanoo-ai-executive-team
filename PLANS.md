# PLANS

## Current Objective

Stabilize Lark Lobster document handling, lane execution, and comment-driven suggestion workflows.

## Done

- Established `docs/system` as the technical mirror for this repo.
- Added binding/session/workspace runtime scoping.
- Added capability lane routing for:
  - `group-shared-assistant`
  - `personal-assistant`
  - `doc-editor`
  - `knowledge-assistant`
- Replaced generic lane intro replies with lane-specific execution paths.
- Added preview-first document replace flow with confirmation IDs.
- Added comment-driven rewrite preview flow.
- Added human-readable rewrite preview cards.
- Added new-comment suggestion card generation.
- Added timer/manual polling path for watched comment suggestion cards.
- Hardened lane message parsing so structured `document_id` payloads and reply-chain doc follow-ups can route into the doc editor more reliably.
- Fixed lane executor auth fallback and upstream doc-token recovery so shared-doc replies can resolve document IDs without depending only on `doccn`-style tokens.
- Added structured runtime observability for long-connection events, lane routing, doc resolution, and failure paths to support live payload debugging.
- Added user-visible fallback replies for long-connection lane failures so event errors no longer fail silently in chat.
- Stopped the duplicate local LaunchAgent `com.seanhan.lark-kb-http`, so this machine now uses `ai-server` as the only live Lobster long-connection runtime.
- Removed the old Playground LaunchAgent plist and leftover log files after backup, and cleared the stale launchd disabled state so no local `lark-kb-http` process residue remains.
- Expanded Lark capabilities across:
  - docs
  - messages
  - calendar
  - tasks
  - bitable
  - sheets
- Synced README and `docs/system` with the current runtime model.
- Added external workflow checkpoints and governed prompts for knowledge answer, comment rewrite, and semantic classification flows so long AI tasks no longer need full-history replay.
- Added compact tool-output shaping for the OpenClaw plugin so oversized JSON/tool payloads are summarized before re-entering agent context.
- Added repeatable long-task governance verification (`npm run eval:long-task`) plus multi-round regression coverage for checkpoint-bounded prompt growth.

## In Progress

- Verify live `ai-server` long-connection behavior against real Lark message payloads now that the duplicate Playground runtime has been disabled.
- Validate `ai-server` user-token migration from existing Playground OAuth state, then run real Lark doc read/append smoke against the live stack.
- Keep `docs/system` aligned with runtime behavior and API changes.

## Next

- Validate real-world doc share, reply-to-doc, and comment suggestion flows in Lark.
- Retest the corrected `ai-server` follow-up handling in Lark with short clarification replies such as `我說的是 AI 系統`.
- Deepen lane-specific execution so each lane uses more targeted tools and reply styles.

## Risks

- Playground is no longer the live long-connection bot on this machine, so fixes in this repo will not change Lark message behavior unless the LaunchAgent is intentionally re-enabled.
- Lark shared-message payloads can still vary by message type, so the new structured-token parser still needs live validation against real events.
- Local `.env` OAuth scopes have already been expanded, but existing user authorization must still be refreshed before the new docx/message scopes take effect live.
- Comment suggestion workflows currently rely on polling or manual trigger, not native comment events.
- Final doc write-back still depends on replace-style application because of current Lark doc API limits.
- Playground token-optimization improvements still need a repo commit after live smoke and long-task evaluation finish.

## Operating Rules

- Update this file whenever the current objective, active implementation focus, or major risks change.
- Keep `Done` factual; only list capabilities that already exist in code.
- Keep `In Progress` short and limited to active engineering work.
- Move finished items from `In Progress` or `Next` into `Done` instead of duplicating them.

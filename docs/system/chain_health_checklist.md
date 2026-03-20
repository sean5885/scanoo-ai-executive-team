# Chain Health Checklist

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Router

- [x] slash command can resolve to a registered agent
- [x] knowledge subcommands can resolve to the correct knowledge agent
- [x] image-bearing events are split before plain text fallback
- [x] active executive task can continue across turns

## Prompt

- [x] registered agents use compact shared prompt governance
- [x] meeting flow uses bounded prompt input
- [x] image outputs are compacted before downstream text synthesis

## Tool

- [x] agent registry exposes allowed tools and fallback behavior
- [x] message send has retry for transient failures
- [x] doc/group/meeting high-risk operations emit runtime trace logs
- [x] drive/wiki/bitable/calendar/tasks high-risk HTTP routes emit route and handler step logs
- [x] drive/wiki/bitable/calendar/tasks high-risk routes have success-path smoke fixtures for preview/read and apply/write paths
- [x] image provider returns structured results or explicit failure reasons

## Formatter

- [x] executive output uses fixed brief sections
- [x] meeting summary strips internal fields
- [x] cloud-doc organization follow-up stays in the right workflow branch

## Group / Doc / Confirm

- [x] meeting preview sends group message before doc write
- [x] meeting confirmation writes doc only after confirm
- [x] Lobster-created docs grant initiator `full_access`
- [x] write failures preserve pending or return explicit failure

## Fallback

- [x] registered agents prefer OpenClaw MiniMax when direct LLM key is absent
- [x] retrieval-summary fallback is retained as the final safe degradation path
- [x] multimodal requests can fall back to the text lane if image analysis is unavailable

## Tests

- [x] self-check validates registry, route contracts, and service imports
- [x] self-check covers drive/wiki/bitable/calendar/tasks high-risk preview/read and apply/write route presence
- [x] smoke tests cover command routing and agent execution schema
- [x] integration tests cover meeting confirmation chain and knowledge chain
- [x] image understanding tests cover Gemini `generateContent`
- [x] workflow smoke / integration / workflow-specific regression baseline is documented in `docs/system/workflow-regression-baseline.md`

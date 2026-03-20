# Lobster v2 Upgrade

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## What Changed

Lobster moved from a workflow-heavy multi-role assistant toward a closed-loop executive agent runtime.

Key upgrades:

- explicit rule system
- lifecycle state machine
- evidence-based verifier
- reflection records
- improvement proposal generation
- proposal-first knowledge writeback
- structured meeting artifacts
- more natural answer-first executive briefs
- verification-fail recovery now returns to `executing / blocked / escalated`
- reflection and improvement schemas aligned with the root AGENTS / RULES contract

## Main New Modules

- `src/executive-rules.mjs`
- `src/executive-lifecycle.mjs`
- `src/executive-verifier.mjs`
- `src/executive-reflection.mjs`
- `src/executive-improvement.mjs`
- `src/executive-memory.mjs`
- `src/executive-closed-loop.mjs`

## Compatibility

- existing slash agents remain compatible
- existing meeting preview/confirm/doc-write flow remains compatible
- knowledge writeback is safer because meeting outputs now enter pending proposal memory first

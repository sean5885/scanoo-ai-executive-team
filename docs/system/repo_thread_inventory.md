# Repo Thread Inventory

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This file is a repo-side inventory of completed thread-sized work so thread/archive status can be recovered from checked-in evidence without rewriting git history.

It records:

- thread-to-commit correspondence
- which threads are safe to archive
- which capabilities are already part of the current baseline
- whether any work still needs a separate save

## Evidence Basis

- reachable `main` history up to `5ed0096 feat: add planner task driving v1 with state-aware next-step suggestions`
- clean working tree from `git status --short --branch`
- reflog entries on 2026-03-20 showing a mixed save and a later amend:
  - `0d4ad56 test/docs: cover heading-targeted doc updates`
  - `72d811b feat: add planner task-driving hints`
  - `5ed0096 commit (amend): feat: add planner task driving v1 with state-aware next-step suggestions`
- technical mirror files in `docs/system`, especially:
  - [summary.md](/Users/seanhan/Documents/Playground/docs/system/summary.md)
  - [system_state_snapshot.md](/Users/seanhan/Documents/Playground/docs/system/system_state_snapshot.md)
  - [system_status_next_phase.md](/Users/seanhan/Documents/Playground/docs/system/system_status_next_phase.md)

## Current Baseline Pointer

- current branch: `main`
- current reachable `HEAD`: `5ed0096`
- working tree: clean
- `72d811b` exists, but is not reachable from `main`
- `72d811b` and `5ed0096` have the same tree, so `72d811b` is a superseded save, not a missing baseline commit
- `0d4ad56` is also unreachable and reflects a mixed save that was later split into the reachable `5cdde38` plus the planner-task-driving save later amended into `5ed0096`

## Thread110 Addendum

This inventory originally stopped at the planner task-driving baseline. The latest completed stabilization round now additionally covers:

| Thread | Status | Reachable commit(s) | Why it is treated as one thread |
| --- | --- | --- | --- |
| Agent-system stabilization baseline | completed on branch, pending merge/archive | `67a0bd6`, `28ba87b`, `7c037a5`, `cbf29d0`, `b452d7c`, `88b9d1e`, `cee5659` | This round hardens chat-facing dispatcher/orchestrator output boundaries and stabilizes local `docs/system` snippet extraction, BD retrieval ranking, and BD query alias handling without adding new product/runtime capabilities. |

Thread110 themes:

- dispatcher fallback/no-match replies now render natural language instead of raw JSON envelopes
- registered-agent success output now guards against JSON-like structured payload leakage
- executive planner fallback replies now render natural language instead of raw JSON envelopes
- executive specialist/merge synthesis now rejects JSON-like structured replies
- local `docs/system` snippet extraction is cleaner and more stable
- BD retrieval ranking is more domain-aware
- generic `business` alias leakage is suppressed for explicit BD / 商機 queries

## Thread to Commit Map

| Thread | Status | Reachable commit(s) | Why it is treated as one thread |
| --- | --- | --- | --- |
| AI flow token governance and checkpoint baseline | completed, archiveable | `22f216f` | Added checkpointed token governance for answer, rewrite, semantic-classifier, and related docs/tests. |
| Playground repo checkpoint and technical mirror baseline | completed, archiveable | `026bc35` | Checkpointed the repo into a code-plus-docs baseline with `docs/system`, `lobster_security`, runtime routes, sync, retrieval, and capability-lane foundations. |
| Meeting workflow with confirmation cards | completed, archiveable | `d5b020c` | Added the bounded `/meeting` workflow, confirmation cards, DB support, route wiring, and tests. |
| Executive/planner checkpoint plus company-brain/workflow-kernel alignment | completed, archiveable | `7fc956e` | Landed the large executive/planner/runtime checkpoint plus the mirrored alignment/spec docs that describe the grounded surfaces. |
| Shared-link trace fix and heading-targeted doc update coverage | completed, archiveable | `5bbecd8`, `5cdde38` | This workstream fixed shared-link doc targeting and then added heading-targeted update coverage plus doc/test mirror updates. |
| Planner task-driving v1 | completed, archiveable | `5ed0096` | Added state-aware next-step suggestions derived from planner-side task snapshots without changing the public planner envelope. |

## Detached or Superseded Saves

These commits explain the recent thread/commit confusion, but they do not need rescue work because their content is already represented by reachable baseline commits.

| Commit | Reachability | Interpretation | Baseline outcome |
| --- | --- | --- | --- |
| `0d4ad56` | unreachable | mixed save that bundled heading-targeted doc-update work together with planner task-driving work | split into `5cdde38` and the later planner task-driving save |
| `72d811b` | unreachable | pre-amend save for planner task-driving hints | superseded by `5ed0096` with identical tree |

## Threads Safe To Archive

- AI flow token governance and checkpoint baseline
- Playground repo checkpoint and technical mirror baseline
- Meeting workflow with confirmation cards
- Executive/planner checkpoint plus company-brain/workflow-kernel alignment
- Shared-link trace fix and heading-targeted doc update coverage
- Planner task-driving v1

Reason: each thread now has reachable baseline commit coverage on `main`, the working tree is clean, and the recent detached saves are already absorbed by reachable commits.

## Capabilities In Current Baseline

The current baseline grounded in reachable `main` commits includes:

- Lark OAuth, token/account persistence, and local runtime bootstrapping
- Drive / Wiki / Doc browse-write flows, local sync, SQLite/FTS retrieval, and semantic classification
- OpenClaw plugin tooling plus LLM-assisted answer and comment-rewrite paths
- prompt-budget governance, external workflow checkpoints, and compact tool-output shaping for AI-heavy paths
- binding/session/workspace scoping and capability-lane routing
- comment-driven rewrite preview, suggestion-card, and watched-comment polling workflows
- meeting workflow with confirmation-before-write behavior
- closed-loop executive modules: planner, orchestrator, lifecycle, verifier, reflection, improvement, task state, and registered agents
- planner multi-flow runtime, action layer, conversation memory, task lifecycle v1, execution tracking, single-task targeting, and task-driving v1 hints
- controlled company-brain-adjacent surfaces already grounded in code: verified mirror ingest, read-side list/detail/search, and partial write-intake alignment docs
- workflow regression baselines, route-success/trace coverage, and self-check scaffolding
- shared-link doc tracing and heading-targeted doc-update coverage

## Separate Save Follow-Up

Current assessment: no additional repo save is required for already-completed work visible in this checkout.

Why:

- the working tree is clean
- the visible completed workstreams all have reachable commits on `main`
- the two confusing detached commits are already covered:
  - `72d811b` is preserved by `5ed0096`
  - `0d4ad56` was split into the reachable follow-up commits

The only follow-up still worth doing is external bookkeeping: if any thread tracker, note, or inbox item still points at `72d811b` or `0d4ad56`, relabel it to the reachable baseline commits above and then archive the old thread reference.

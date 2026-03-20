# Project Brief

## What This Repo Is

This repository is an AI-enabled Lark tool service built around a local Node runtime, a SQLite-backed knowledge layer, an OpenClaw plugin surface, and a Python security wrapper.

It currently supports:

- Lark OAuth and account/token persistence
- Drive / Wiki / Doc read and write flows
- Local sync, FTS retrieval, and semantic classification
- LLM-assisted answer generation
- Comment-driven document rewrite and suggestion workflows
- Binding/session/workspace scoping and capability-lane execution

## What This Repo Is Not

This repo is not a planner/router/specialist multi-agent executive system.

Current AI surfaces are limited to:

- OpenClaw plugin tools
- semantic classification
- answer generation
- document-comment rewrite

## Technical Ground Rules

- `AGENTS.md` is the repo operating contract for Codex work.
- `PLANS.md` is the live work tracker and current objective reference.
- `docs/system` is the single technical mirror for architecture and module behavior.
- If docs and code disagree, treat code as the source of truth and log the mismatch in `docs/system/open_questions.md`.

## Current Working Pattern

Before starting a new Codex thread:

1. Update `PLANS.md` `Current Objective` if the focus has changed.
2. Start a fresh Codex conversation.
3. Paste the kickoff text from `TASK_TEMPLATE.md`.

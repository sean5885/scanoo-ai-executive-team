# Lobster v2 Architecture

This file is the root-level overview for the Lobster AI Executive Team runtime.

Detailed technical mirror lives in:

- [/Users/seanhan/Documents/Playground/docs/system/architecture.md](/Users/seanhan/Documents/Playground/docs/system/architecture.md)
- [/Users/seanhan/Documents/Playground/docs/system/modules.md](/Users/seanhan/Documents/Playground/docs/system/modules.md)
- [/Users/seanhan/Documents/Playground/docs/system/data_flow.md](/Users/seanhan/Documents/Playground/docs/system/data_flow.md)

## Core Layers

- Orchestration layer
  - router
  - planner
  - specialist delegation
  - synthesis
  - memory read/write
- Reliability layer
  - lifecycle state machine
  - evidence model
  - verifier
  - fake-completion guard
- Reflection layer
  - post-task review
  - error taxonomy
  - routing / style review
- Improvement layer
  - rule / prompt / routing / checklist improvement proposals

## First-Class Flows

- executive slash agents
- knowledge governance
- meeting processing
- image understanding before text synthesis
- document and group writeback

## Important Constraint

Lobster v2 is now a closed-loop executive agent runtime, but it is still not a background worker mesh or company-brain graph server.

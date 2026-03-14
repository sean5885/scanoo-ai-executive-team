# Binding / Session / Workspace Spec

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Goal

Translate the OpenClaw-style concepts into a Lark Lobster runtime shape that this repository can actually implement now.

This repo still does not have planner/specialist agents.
What this spec does provide is:

- stable binding keys
- stable session keys
- stable workspace keys
- stable capability lanes on top of those keys
- a path to future per-peer or per-group agent routing

## Current Recommended Mode

Use a hybrid model:

- workspace:
  - shared
- session:
  - isolated by `channel + peer`
- sandbox:
  - isolated by `channel + peer` for risky actions

This matches the current repo better than either:

- one giant fully shared chat context
- one fully separate agent/workspace per user from day one

## Concept Mapping

- Channel
  - Lark as the inbound communication channel
- Binding
  - the routing key that decides which logical assistant lane the event belongs to
- Workspace
  - shared company asset layer
  - docs, knowledge index, synced content, reusable tool context
- Session
  - conversation-local context for one peer scope
- Sandbox
  - isolated execution lane for risky local actions

## Scope Strategy

### DM

- peer source:
  - sender `open_id`
- session isolation:
  - per user
- workspace:
  - shared company workspace
- sandbox:
  - per user

### Group Chat

- peer source:
  - `chat_id`
- session isolation:
  - per chat
- workspace:
  - shared company workspace
- sandbox:
  - per chat

## Runtime Keys

Implemented in:

- `/Users/seanhan/Documents/Playground/src/binding-runtime.mjs`

Current outputs:

- `agent_binding_key`
- `capability_lane`
- `lane_label`
- `lane_reason`
- `workspace_key`
- `session_key`
- `sandbox_key`
- `recommended_memory_layers`

### Default Key Shapes

- shared assistant binding:
  - `agent:lark:shared-assistant`
- group binding:
  - `agent:lark:group-shared`
- shared workspace:
  - `workspace:shared-company`
- DM session:
  - `session:lark:dm:<open_id>`
- group session:
  - `session:lark:group:<chat_id>`
- DM sandbox:
  - `sandbox:lark:dm:<open_id>`
- group sandbox:
  - `sandbox:lark:group:<chat_id>`

## Current Binding Strategy

Configured in:

- `/Users/seanhan/Documents/Playground/src/config.mjs`

Key env vars:

- `LOBSTER_BINDING_STRATEGY`
- `LOBSTER_SHARED_WORKSPACE_KEY`
- `LARK_SESSION_SCOPE_STORE`

Default:

- `LOBSTER_BINDING_STRATEGY=shared_workspace_per_peer_session`

## What Is Already Implemented

### Event-Time Scope Resolution

Implemented in:

- `/Users/seanhan/Documents/Playground/src/index.mjs`
- `/Users/seanhan/Documents/Playground/src/binding-runtime.mjs`
- `/Users/seanhan/Documents/Playground/src/session-scope-store.mjs`

Behavior:

- on each `im.message.receive_v1`
- resolve binding/session/workspace/sandbox keys
- resolve one capability lane from peer scope plus message intent
- persist latest session touch to local state

### Inspection API

Implemented in:

- `POST /api/runtime/resolve-scopes`
- `GET /api/runtime/sessions`

These are useful for validating real routing inputs before future agent expansion.

## Implementation Rules

1. Company knowledge stays shared.
2. Chat context never becomes globally shared across all peers.
3. Group chat and DM use different peer identities.
4. Sandbox isolation follows peer scope for risky actions.
5. Future multi-agent routing must use these keys rather than inventing new ad hoc scopes.

## Future Upgrade Path

### Stage 1

Current repo state:

- shared workspace
- per-peer session
- per-peer sandbox
- binding-based capability lanes:
  - `group-shared-assistant`
  - `personal-assistant`
  - `doc-editor`
  - `knowledge-assistant`

### Stage 2

Deepen lane-specific execution while keeping one shared workspace.

Current implemented lane execution:

- `group-shared-assistant`
  - group summary and reply drafting
- `personal-assistant`
  - personal calendar and task oriented replies
- `doc-editor`
  - document read and comment-rewrite suggestion-card flow
- `knowledge-assistant`
  - retrieval answer flow

### Stage 3

Only if needed, introduce per-peer workspaces:

- executive private workspace
- team workspace
- project workspace

This should not be the default now.

## What This Does Not Claim

- no planner exists here
- no specialist agent registry exists here
- no company_brain exists here
- no long-term personal memory model exists yet

This is a runtime scoping and capability-lane foundation, not a full agent orchestration architecture.

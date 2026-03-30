# System Interface Spec

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document defines the current minimum interface layer for the Lobster planner / agent / skill / tool chain.

It is intentionally narrow:

- it describes the smallest reusable contracts already implied by the checked-in runtime
- it does not claim a full autonomous multi-agent mesh
- it does not add new runtime behavior by itself

## 1. `planner_agent_interface`

- purpose:
  - let the planner choose a bounded action or preset and return a normalized execution result
- caller:
  - planner runtime in `/Users/seanhan/Documents/Playground/src/executive-planner.mjs`
- callee:
  - planner tool bridge or planner preset runner
- input shape:
  ```json
  {
    "userIntent": "string|null",
    "taskType": "string|null",
    "payload": "object"
  }
  ```
- output shape:
  ```json
  {
    "selected_action": "string|null",
    "execution_result": "object|null",
    "trace_id": "string|null"
  }
  ```
- failure handling:
  - fail-soft only
  - if no rule matches, return `selected_action=null`
  - if dispatch/preset fails, return normalized `ok=false` result with `error` and `trace_id`
- boundary:
  - planner is the only selector/dispatcher here
  - this interface does not define new workflow ownership
  - preset-level validation is final-output only; no step-level validation yet

## 2. `agent_skill_interface`

- purpose:
  - let an agent invoke a skill as a bounded capability instead of treating the skill as a task owner
- caller:
  - planner-selected agent path, agent bridge, or workflow-controlled agent execution
- callee:
  - a checked-in skill definition under `$CODEX_HOME/skills` or `$HOME/.agents/skills`
- input shape:
  ```json
  {
    "skill_name": "string",
    "intent": "string",
    "context": "object",
    "constraints": "object|null"
  }
  ```
- output shape:
  ```json
  {
    "ok": "boolean",
    "skill_name": "string",
    "result": "object|null",
    "evidence": "object|null",
    "trace_id": "string|null"
  }
  ```
- current registered-agent structured boundary normalizes successful replies onto the shared canonical envelope (`ok`, `answer`, `sources`, `limitations`) while still hiding raw planner/action envelopes from user-facing text
- failure handling:
  - fail-soft
  - missing skill, invalid capability use, or controlled refusal should return `ok=false`
  - skill output is evidence/capability output, not completion by itself
- boundary:
  - skills are tools/capabilities, never task owners
  - skill success does not imply workflow completion
  - approval/write/verification gates remain outside this interface

## 3. `skill_tool_interface`

- purpose:
  - let a skill call a concrete tool, route, SDK adapter, or external capability through a narrow payload/result contract
- caller:
  - skill runtime or planner-dispatched tool layer
- callee:
  - HTTP route, local adapter, SDK wrapper, or external tool
- input shape:
  ```json
  {
    "tool_name": "string",
    "payload": "object",
    "auth_context": "object|null"
  }
  ```
- output shape:
  ```json
  {
    "ok": "boolean",
    "action": "string|null",
    "data": "object",
    "trace_id": "string|null"
  }
  ```
- failure handling:
  - fail-soft
  - normalized errors should prefer:
    - `contract_violation`
    - `tool_error`
    - `runtime_exception`
    - `request_timeout`
    - `request_cancelled`
    - `business_error`
    - `not_found`
    - `permission_denied`
- boundary:
  - tool output is execution evidence only
  - tool success is not task completion
  - high-risk writes still require route/workflow/approval control outside this interface

## 4. `handoff_escalation_interface`

- purpose:
  - transfer execution to another bounded actor or stop current execution with a controlled escalation/block reason
- caller:
  - planner, preset runner, verifier gate, or controlled failure boundary
- callee:
  - another agent path, another preset/tool path, or a blocked/escalated terminal handler
- input shape:
  ```json
  {
    "source": "string",
    "target": "string|null",
    "reason": "string",
    "payload": "object|null",
    "trace_id": "string|null"
  }
  ```
- output shape:
  ```json
  {
    "ok": "boolean",
    "status": "string",
    "stopped": "boolean",
    "stop_reason": "string|null",
    "trace_id": "string|null"
  }
  ```
- failure handling:
  - fail-soft
  - if handoff target is unavailable or invalid, return controlled `ok=false`
  - if escalation is chosen, preserve stop reason and trace context
- boundary:
  - escalation does not silently become completion
  - handoff does not transfer workflow ownership away from the planner/kernel
  - current repo only has minimal planner/runtime stop boundaries, not a full handoff mesh

## Current Boundary Summary

- planner -> action/preset selection exists in code today
- agent-facing bridge routes exist for a narrow subset of document/runtime actions
- company-brain routes exist as minimal read/write mirrors, not a full knowledge operating system
- skill/tool usage is governed by checked-in policy and route contracts, but not yet by a single runtime interface module
- escalation/handoff is currently specified as a boundary contract, not a full runtime subsystem

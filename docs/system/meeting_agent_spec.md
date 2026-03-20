# Meeting Agent Spec

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document defines the minimum usable spec for `meeting_agent`.

It is intentionally narrow:

- summarize meeting transcript or notes
- extract decisions
- extract action items
- require owner and deadline coverage where possible
- stay inside the current controlled meeting workflow

It does **not** claim that `meeting_agent` is a standalone autonomous runtime.

## Input

Minimum input sources:

- `transcript`
- `notes`

Optional surrounding context:

- meeting metadata
- meeting type
- related calendar event metadata
- target document mapping

Minimum input shape:

```json
{
  "transcript": "string|null",
  "notes": "string|null",
  "meeting_type": "weekly|general|null",
  "metadata": {
    "event_summary": "string|null",
    "meeting_url": "string|null",
    "event_start_time": "string|null",
    "event_end_time": "string|null"
  }
}
```

Input boundary:

- at least one of `transcript` or `notes` must exist
- raw meeting audio is out of scope for this spec; transcription happens before meeting-agent summarization

## Output Shape

`meeting_agent` should produce a fixed structured result.

Minimum output shape:

```json
{
  "summary": "string",
  "decisions": ["string"],
  "action_items": [
    {
      "item": "string",
      "owner": "string|null",
      "deadline": "string|null"
    }
  ],
  "risks": ["string"],
  "open_questions": ["string"],
  "conflicts": ["string"],
  "knowledge_writeback": [
    {
      "type": "proposal",
      "content": "string"
    }
  ]
}
```

Required fixed core:

- `summary`
- `decisions`
- `action_items`

Minimum owner/deadline rule:

- each action item should carry `owner`
- each action item should carry `deadline`
- if owner/deadline cannot be confirmed, the result should keep that uncertainty visible instead of inventing values

## Core Fields

### Meeting Summary

- purpose:
  - provide a stable plain-language summary of the meeting
- expected shape:
  - one concise summary string

### Decisions

- purpose:
  - record explicit decisions made in the meeting
- expected shape:
  - string array

### Action Items

- purpose:
  - capture follow-up work
- expected shape:
  - array of `{ item, owner, deadline }`

### Owner

- purpose:
  - identify responsibility for each action item
- expected shape:
  - `string|null`

### Deadline

- purpose:
  - identify due date or time boundary for each action item
- expected shape:
  - `string|null`

## Relationship With Planner

- `planner_agent` is the decision owner for whether meeting workflow should start, continue, confirm, stop, or escalate.
- `meeting_agent` is a bounded execution capability inside the meeting workflow.
- `meeting_agent` should not declare executive completion by itself.
- `meeting_agent` outputs should still pass the existing verification boundary before any task can be considered completed.

## Post-Processing And Planner Handoff

`meeting_agent` output is not the end of the workflow.

After summarization, action items must be interpreted by `planner_agent` under a controlled handoff boundary.

### Action Items To Planner Conversion

Minimum conversion rule:

- each meeting `action_item` should be interpreted as a candidate planner `work_item`
- planner should preserve:
  - item text
  - owner
  - deadline
  - any visible uncertainty

Minimum normalized handoff shape:

```json
{
  "work_item": "string",
  "owner": "string|null",
  "deadline": "string|null",
  "source": "meeting_action_item",
  "status": "ready|pending_clarification"
}
```

### Incomplete Action Item

An action item is incomplete if:

- `owner` is missing
- or `deadline` is missing

Example:

```json
{
  "item": "整理新版定價頁文案",
  "owner": null,
  "deadline": null
}
```

Incomplete action items must remain explicit.

They must not be silently promoted into fully assigned tasks.

### Planner Handling Rules

When planner receives meeting-derived action items:

- complete items:
  - may be converted into normal `work_items`
- incomplete items:
  - should trigger `clarify`
  - or remain in `pending`

Minimum planner expectation:

- if owner/deadline are both usable:
  - planner may place the item in `work_items`
- if either owner/deadline is missing:
  - planner should not treat it as fully ready execution
  - planner should either:
    - ask for clarification
    - or retain it as a pending item awaiting confirmation

### Pending Boundary

Meeting-derived action items should stay pending when:

- responsibility is ambiguous
- timeline is ambiguous
- the item depends on an unresolved meeting decision
- the summary still requires human confirmation

This boundary exists to prevent:

- fake completeness
- silent task creation without ownership
- accidental admission of ambiguous meeting notes into formal execution

## Relationship With Company Brain

- `meeting_agent` may produce `knowledge_writeback` proposals.
- meeting-derived knowledge should be treated as proposal/intake material first.
- `meeting_agent` may feed controlled ingest paths, but it must not directly write approved company-brain knowledge.
- current allowed boundary is:
  - proposal-like writeback
  - controlled ingest/mirror path
- current disallowed boundary is:
  - direct approval
  - direct long-term company-brain admission

## Failure Handling

Minimum failure rules:

- malformed or incomplete transcript/notes should not be hidden as a completed summary
- missing owners or deadlines should remain visible in output uncertainty
- if structured result is incomplete, the workflow should remain in confirm/review/blocked style boundaries instead of claiming final completion

Minimum failure shape expectation:

```json
{
  "ok": false,
  "error": "string",
  "message": "string|null"
}
```

## Boundary

In scope:

- transcript/notes summarization
- decisions extraction
- action-item extraction
- owner/deadline coverage
- proposal-style knowledge writeback output

Out of scope:

- direct company-brain approval
- direct long-term memory admission
- standalone meeting workflow orchestration
- direct task completion authority
- raw audio transcription runtime

## Current Runtime Note

Current code-aligned reality is still:

- meeting capture
- transcript compaction
- structured summary generation
- confirmation before write
- controlled document writeback
- proposal/intake-style knowledge writeback

This spec does **not** mean a standalone `meeting_agent` runtime wrapper already exists.

# Meeting Agent Trial Run Report Spec

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document defines the minimum report shape for real-world `meeting_agent` trial runs.

It is meant for controlled trial operations, not for runtime replacement.

The goal is to make each trial run auditable and comparable across meetings.

## Required Report Fields

Each meeting trial run should record at least the following sections.

### 1. Meeting Meta

Minimum fields:

```json
{
  "meeting_meta": {
    "meeting_id": "string|null",
    "title": "string|null",
    "meeting_type": "weekly|general|unknown",
    "date": "string|null",
    "duration_minutes": "number|null",
    "participants": ["string"],
    "source_kind": "calendar_event|chat_capture|manual_notes|unknown"
  }
}
```

### 2. Recording Health

Minimum fields:

```json
{
  "recording_health": {
    "recording_attempted": "boolean",
    "recording_started": "boolean",
    "device_name": "string|null",
    "audio_file_present": "boolean",
    "capture_mode": "microphone|none|unknown",
    "status": "healthy|partial|failed",
    "issue_note": "string|null"
  }
}
```

### 3. Transcription Quality

Minimum fields:

```json
{
  "transcription_quality": {
    "transcription_attempted": "boolean",
    "provider": "string|null",
    "model": "string|null",
    "transcript_present": "boolean",
    "transcript_source": "audio_only|chat_only|audio_plus_chat|notes_only|unknown",
    "quality": "good|partial|failed",
    "issue_note": "string|null"
  }
}
```

### 4. Summary Quality

Minimum fields:

```json
{
  "summary_quality": {
    "summary_present": "boolean",
    "quality": "good|partial|failed",
    "issue_note": "string|null"
  }
}
```

### 5. Decisions Quality

Minimum fields:

```json
{
  "decisions_quality": {
    "decision_count": "number",
    "quality": "good|partial|failed",
    "issue_note": "string|null"
  }
}
```

### 6. Action Items Quality

Minimum fields:

```json
{
  "action_items_quality": {
    "action_item_count": "number",
    "executable_count": "number",
    "clarify_count": "number",
    "pending_count": "number",
    "quality": "good|partial|failed",
    "issue_note": "string|null"
  }
}
```

### 7. Planner Intake Result

Minimum fields:

```json
{
  "planner_result": {
    "work_items_count": "number",
    "clarify_count": "number",
    "pending_count": "number",
    "direct_work_item_rate": "number|null",
    "clarify_rate": "number|null",
    "pending_rate": "number|null"
  }
}
```

### 8. Writeback Result

Minimum fields:

```json
{
  "writeback_result": {
    "document_written": "boolean",
    "confirmation_required": "boolean",
    "knowledge_writeback_present": "boolean",
    "company_brain_written_directly": "boolean",
    "status": "healthy|partial|failed"
  }
}
```

### 9. Issues / Followups

Minimum fields:

```json
{
  "issues_followups": {
    "issues": ["string"],
    "followups": ["string"]
  }
}
```

### 10. Human Override

Human override is used to preserve the original meeting-agent output while recording manual correction.

It must not overwrite the original extracted result.

Minimum fields:

```json
{
  "human_override": {
    "corrected_action_items": [
      {
        "source_action_item_index": "number",
        "original_item": "string",
        "corrected_item": "string"
      }
    ],
    "corrected_owner": [
      {
        "source_action_item_index": "number",
        "original_owner": "string|null",
        "corrected_owner": "string"
      }
    ],
    "corrected_deadline": [
      {
        "source_action_item_index": "number",
        "original_deadline": "string|null",
        "corrected_deadline": "string"
      }
    ],
    "removed_items": [
      {
        "source_action_item_index": "number",
        "original_item": "string",
        "reason": "string|null"
      }
    ]
  }
}
```

Override boundary:

- original meeting-agent output must remain preserved
- human override must be recorded as a separate layer
- each correction must be traceable back to one original action item
- `source_action_item_index` is the minimum required linkage key

## Per-Meeting Recording Procedure

For each real meeting trial run:

1. record meeting meta first
2. record whether audio capture was attempted and whether it really started
3. record transcription result and transcript source
4. record meeting-agent output quality:
   - summary
   - decisions
   - action items
5. record planner intake result:
   - `work_items`
   - `clarify`
   - `pending`
6. record writeback result:
   - document
   - proposal/intake-style knowledge writeback
7. record human override if manual correction was needed
8. record issues and recommended followups

One report should correspond to one actual meeting run.

## Required Metrics

These metrics are mandatory for every trial report:

- `recording_started`
- `transcript_present`
- `summary_present`
- `decision_count`
- `action_item_count`
- `executable_count`
- `clarify_count`
- `pending_count`
- `document_written`

Derived indicators that should also be recorded:

- `action_items executable rate`
  - `executable_count / action_item_count`
- `clarify rate`
  - `clarify_count / action_item_count`
- `pending rate`
  - `pending_count / action_item_count`

If human override exists, the report should also make visible:

- how many action items needed manual correction
- how many missing owners were filled by a human
- how many missing deadlines were filled by a human
- how many extracted items were removed as invalid

## Failed / Partial Rules

### Mark As `failed`

A trial run should be marked `failed` when:

- recording was expected but did not start and no usable alternative content exists
- no usable transcript or notes exist
- no summary can be produced
- output is too incomplete to support confirmation or planner intake

### Mark As `partial`

A trial run should be marked `partial` when:

- recording exists but transcript quality is weak
- transcript exists but summary quality is weak
- summary exists but action items are mostly incomplete
- document write succeeds but planner intake quality is poor

### Mark As `healthy`

A trial run may be marked `healthy` when:

- transcript is usable
- summary is usable
- decisions are understandable
- action items are mostly executable or clearly routed into `clarify` / `pending`
- writeback path completes without false completion

## Distinguishing Meeting Problem vs System Problem

### Meeting Problem

Mark as a meeting/content problem when the main issue is:

- unclear meeting decisions
- missing owner assignment
- missing deadline assignment
- fragmented or low-quality notes from humans
- unresolved discussion with no decision closure
- most human override is filling genuinely missing owner/deadline information that the meeting itself did not provide

### System Problem

Mark as a system/runtime problem when the main issue is:

- recorder did not start correctly
- transcription provider failed
- transcript merge failed
- summary generation failed despite usable input
- document/writeback path failed unexpectedly
- action-item extraction needed frequent human correction even though the meeting content already contained the needed owner/deadline/detail

### Mixed Problem

Use mixed classification when:

- transcript quality is weak **and**
- the meeting itself is also ambiguous

Minimum classification shape:

```json
{
  "issue_classification": {
    "primary": "meeting_problem|system_problem|mixed",
    "reason": "string"
  }
}
```

## Recommended Trial Output Shape

Minimum combined report shape:

```json
{
  "meeting_meta": {},
  "recording_health": {},
  "transcription_quality": {},
  "summary_quality": {},
  "decisions_quality": {},
  "action_items_quality": {},
  "planner_result": {},
  "writeback_result": {},
  "human_override": {},
  "issue_classification": {},
  "issues_followups": {}
}
```

## Conservative Boundary

This spec is intentionally conservative:

- it is only a trial-run reporting spec
- it does not introduce a new runtime
- it does not change confirmation or writeback semantics
- it does not imply that meeting output is automatically approved company-brain knowledge

# Meeting Recording / Transcription Runtime Refactor Plan

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document defines a minimum refactor plan for evolving the current local meeting recording / transcription flow into a clearer and more stable meeting recording subsystem.

It starts from the code that already exists today:

- local microphone capture through `ffmpeg`
- persisted meeting capture session metadata
- stop-then-transcribe flow
- transcript merge into meeting summarization

It does **not** claim that the repo already has a product-grade recording runtime, streaming transcription engine, or system-audio subsystem.

## Current Structure

Current runtime is split across adjacent layers:

- recording runtime
  - `/Users/seanhan/Documents/Playground/src/meeting-audio-capture.mjs`
- capture/session persistence
  - `/Users/seanhan/Documents/Playground/src/meeting-capture-store.mjs`
- orchestration/runtime flow
  - `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`
- downstream summarization and writeback
  - `/Users/seanhan/Documents/Playground/src/meeting-agent.mjs`

Current flow is:

1. meeting capture starts
2. local recording is attempted
3. chat transcript is accumulated
4. stop ends capture
5. local file is transcribed
6. transcript is merged into meeting summarization

## Target Structure

Target structure should remain small and explicit:

- a bounded recording runtime layer
- a bounded transcription runtime layer
- explicit health state for recording and transcription
- explicit failure-boundary handling before summary generation
- clearer separation between:
  - recorder lifecycle
  - transcript generation
  - meeting summarization

Future interfaces should be attachable without rewriting the current stop-then-transcribe flow.

## Keep As-Is

These parts should remain unchanged during this refactor sequence:

- existing meeting commands and public route behavior
- current stop-then-transcribe semantics
- current meeting document confirmation/writeback semantics
- current provider defaults
- current meeting summary generation behavior

## Extract Later

Reasonable later extraction targets:

- recorder-state helpers
- transcription-state helpers
- recording/transcription failure-boundary helpers
- transcript merge helpers
- runtime status/health shaping helpers

## Defer For Now

These should remain deferred until later phases:

- realtime / streaming transcription
- system-audio capture runtime
- chunked recording persistence
- recording recovery mesh
- advanced provider failover
- product-grade device-selection UX

## Refactor Phases

### Phase 1

Add recording/transcription health state and clarify internal responsibility boundaries without changing behavior.

Focus:

- make recorder status easier to reason about
- make transcription status easier to reason about
- make recording vs transcription vs summarization responsibilities clearer

Guardrail:

- no public behavior change

Status:

- completed

Landed scope:

- clarified internal section boundaries between:
  - recording device discovery
  - recording runtime / health-state shaping
  - transcription runtime / health-state shaping
  - transcript merge boundary before meeting summarization
- extracted only small internal helpers for:
  - recording result / failure / status shaping
  - transcription result / failure shaping
  - persisted capture-session audio metadata shaping
  - transcript merge readability in the meeting stop path
- kept capture / stop / confirm semantics, transcript-to-summary path, and existing user-visible outputs unchanged

### Phase 2

Extract minimum recording/transcription helpers and failure-boundary structure.

Focus:

- bounded helper extraction for:
  - recording start/stop/status
  - transcription result shaping
  - transcript merge boundary
- centralize minimum failure boundary before downstream meeting summary generation

Guardrail:

- still no public surface change
- still no streaming runtime

### Phase 3

Reserve interfaces for chunking / recover / streaming / system audio.

Focus:

- define internal hook points for chunked recording
- define internal hook points for recover/reconcile after restart
- define internal hook points for future streaming transcript updates
- define internal hook points for future system-audio strategy

Guardrail:

- no full streaming mesh yet
- no full system-audio runtime yet

## What Must Not Move Yet

These are too risky to change now:

- current meeting capture command behavior
- current meeting stop semantics
- current confirmed writeback path
- current transcript-to-summary path
- current company-brain proposal/intake boundary

## What Can Be Refactored Safely First

Safe early candidates:

- internal naming cleanup
- internal helper extraction
- health-state shaping
- internal failure-boundary normalization
- recorder/transcriber responsibility comments

## What Belongs To Later Work

These belong to later work:

- chunked long-duration recording
- partial transcript streaming
- system-audio support
- recorder recovery orchestration
- product-grade recorder health UI

## Validation Strategy

Each phase should validate:

- no meeting command contract change
- no meeting writeback regression
- no transcript merge regression
- no false-success summary when transcript is missing

Recommended validation approach:

- existing meeting audio capture tests
- existing meeting capture store tests
- existing meeting agent tests
- workflow smoke/integration baselines

## Rollback Boundary

Rollback should stay simple:

- if internal refactor changes recording or stop behavior, revert to the prior helper/flow layout
- keep public capture/stop/confirm semantics unchanged until a dedicated recording subsystem truly exists
- do not merge streaming or system-audio terminology into current local microphone runtime until those interfaces actually land

## Current Planning Boundary

This plan is intentionally conservative:

- current runtime is still a bounded local recording + stop-then-transcribe flow
- meeting summarization still remains downstream of transcript generation
- streaming, chunking, recover, and system audio remain future work

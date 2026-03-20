# Meeting Recording / Transcription Alignment

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Purpose

This document aligns the current meeting recording / transcription runtime with the code that already exists today.

It covers:

- `/Users/seanhan/Documents/Playground/src/meeting-audio-capture.mjs`
- `/Users/seanhan/Documents/Playground/src/meeting-capture-store.mjs`
- `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`
- `/Users/seanhan/Documents/Playground/src/meeting-agent.mjs`

It does **not** claim that the repo already has a product-grade live meeting recorder or streaming transcription runtime.

## Current Runtime Mapping

Current grounded runtime is split across four adjacent layers:

- recording runtime
  - `/Users/seanhan/Documents/Playground/src/meeting-audio-capture.mjs`
- meeting capture session persistence
  - `/Users/seanhan/Documents/Playground/src/meeting-capture-store.mjs`
- runtime orchestration
  - `/Users/seanhan/Documents/Playground/src/lane-executor.mjs`
- structured summarization and writeback
  - `/Users/seanhan/Documents/Playground/src/meeting-agent.mjs`

The current path is:

1. user starts meeting capture
2. lane runtime opens a capture session
3. local microphone recording is attempted through `ffmpeg`
4. chat text is appended into the same session
5. on stop, local audio is stopped and then transcribed
6. audio transcript and chat transcript are merged
7. merged text is passed into `meeting-agent`
8. summary/result is written into a meeting document
9. confirmation gates the final document writeback
10. proposal-style knowledge writeback may be registered afterward

## Recording Path

Current recording path is grounded in:

- `startMeetingAudioCapture(sessionId)`
- `stopMeetingAudioCapture(sessionId)`
- `stopMeetingAudioCaptureByMetadata(sessionId, persisted)`
- `detectPreferredAudioInput()`

Current behavior:

- macOS host microphone recording is attempted through `ffmpeg` + `avfoundation`
- microphone-like devices are discovered from `ffmpeg -list_devices true`
- a preferred input device is auto-selected when no explicit input-device index is configured
- a configured `MEETING_AUDIO_INPUT_DEVICE_INDEX` can override auto-selection
- capture writes a local `.m4a` file under the configured meeting-audio directory
- active in-memory recording state is tracked in process memory
- recorder metadata is also persisted into meeting-capture session state so stop/status can recover after restart

What is already usable:

- local microphone capture on the host machine
- minimal input-device selection by config
- start/stop capture
- local file persistence

What is only demo-grade or bounded:

- device selection is config-based, not a real user-facing picker
- only microphone input is grounded here
- no grounded system-audio capture path was found

## Transcription Path

Current transcription path is grounded in:

- `transcribeMeetingAudio(filePath)`
- `resolveMeetingTranscribeProvider(...)`
- `transcribeMeetingAudioWithFasterWhisper(...)`
- `transcribeMeetingAudioWithOpenAiCompatible(...)`
- `/Users/seanhan/Documents/Playground/scripts/transcribe-with-faster-whisper.py`

Current behavior:

- transcription happens after recording stops
- default provider is local `faster-whisper`
- optional provider is an OpenAI-compatible audio transcription endpoint
- local transcription runs through the bundled Python helper script
- output is normalized into `{ ok, text, provider?, model? }`

Grounded providers / models:

- default:
  - provider: `faster_whisper`
  - model: configured `MEETING_TRANSCRIBE_FASTER_WHISPER_MODEL` (default `small`)
  - device: configured `MEETING_TRANSCRIBE_FASTER_WHISPER_DEVICE` (default `cpu`)
- optional:
  - provider: `openai_compatible`
  - model: configured `MEETING_TRANSCRIBE_MODEL` (default `whisper-1`)

What is already usable:

- record-then-transcribe flow
- local transcription by default
- bounded provider switching

What is not grounded:

- streaming / realtime transcription
- partial transcript emission during recording
- product-grade provider failover mesh

## Storage / Output Path

Current storage/output path is grounded in:

- `meeting_capture_sessions`
- `meeting_capture_entries`
- local audio files under configured meeting-audio dir
- meeting document writeback
- proposal-style knowledge writeback registration

Current persisted outputs:

- local audio file
  - `.m4a` file on disk
- session metadata
  - `audio_file_path`
  - `audio_device_name`
  - `audio_pid`
  - `audio_started_at`
  - `audio_stopped_at`
- chat transcript entries
  - stored in `meeting_capture_entries`
- merged transcript text
  - built at runtime from:
    - local audio transcript
    - chat transcript
- structured meeting output
  - summary
  - decisions
  - action_items
  - risks
  - open_questions
  - conflicts
  - knowledge_writeback
  - task_writeback
- meeting document content
  - preview/draft first
  - final write after confirmation
- proposal-style knowledge writeback
  - registered through the existing closed-loop path

Current company-brain boundary:

- meeting output may feed proposal/intake-style writeback
- this is **not** direct approved company-brain admission

## Failure Handling

Current failure handling is grounded but still minimal.

Recording-side failure:

- if audio capture is disabled or missing device:
  - recording does not start
  - runtime returns `started: false` with a reason
- if `ffmpeg` exits early:
  - runtime returns `started: false` with captured stderr or fallback reason

Transcription-side failure:

- if file is missing:
  - returns `ok: false`
- if transcript is empty:
  - returns `ok: false, reason: "empty_transcript"`
- if provider fails:
  - returns bounded failure reason instead of pretending success

Meeting-output failure:

- when stop is reached but no usable transcript exists:
  - runtime does not fake a meeting summary
  - a failure note is written to the meeting document, or the document is removed according to preference
- meeting summary writeback still stays under confirmation control

What is already good:

- bounded failure return instead of fake success
- failure note path for missing transcript

What is still weak:

- no quality score for transcript health
- no progressive health signal during recording
- no chunk recovery for long recordings

## Current Gaps

Current gaps that matter:

- no realtime / streaming transcription
- no grounded system-audio capture path
- no explicit user-facing input-device selection route
- no long-recording chunking / rollover / recovery strategy
- no recording health telemetry beyond minimal process metadata
- no transcription progress reporting
- no product-grade recovery path for partial/corrupted recordings

## What Is Already Usable

- local microphone capture on macOS host
- config-level input-device selection
- record start/stop
- audio-file persistence
- stop-then-transcribe flow
- local `faster-whisper` default transcription
- meeting transcript merge with chat text
- meeting summary / decisions / action items generation
- confirmation-gated final document writeback

## What Is Only Demo-Grade

- config-based device choice
- single-process local recorder lifecycle
- bounded OpenAI-compatible transcription path
- local-only stop-then-transcribe operation without streaming state

## What Is Not Product-Grade Yet

- long-duration recording resilience
- recorder recovery / reconcile after host/runtime faults
- realtime transcript visibility
- explicit recording quality monitoring
- full system-audio capture support
- product-grade transcription provider governance

## Next Refactor Targets

Highest-priority next targets:

1. make recording/transcription health explicit
   - recorder state
   - transcript quality state
   - operator-visible failure reason
2. clarify long-recording boundary
   - chunking
   - rollover
   - stop/recover behavior
3. separate recording runtime concern from meeting summarization concern more clearly
4. reserve future interfaces for:
   - explicit input-device selection
   - streaming transcript
   - system-audio capture strategy

## Conservative Boundary

This alignment is intentionally conservative:

- current runtime can record and transcribe in a bounded local flow
- current runtime is good enough for controlled meeting capture demos and internal use
- current runtime should not yet be described as a product-grade recording/transcription subsystem

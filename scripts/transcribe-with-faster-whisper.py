#!/usr/bin/env python3
import argparse
import json
import os
import sys


def parse_args():
    parser = argparse.ArgumentParser(description="Transcribe one audio file with faster-whisper.")
    parser.add_argument("--file", required=True, help="Path to the audio file.")
    parser.add_argument("--model", default="small", help="faster-whisper model name.")
    parser.add_argument("--device", default="cpu", help="faster-whisper device.")
    parser.add_argument("--compute-type", default="int8", help="faster-whisper compute type.")
    parser.add_argument("--language", default="", help="Optional language hint, such as zh.")
    parser.add_argument("--cache-dir", default="", help="Optional model cache directory.")
    return parser.parse_args()


def main():
    args = parse_args()

    if not os.path.isfile(args.file):
        raise FileNotFoundError(f"audio file not found: {args.file}")

    try:
        from faster_whisper import WhisperModel
    except Exception as error:  # pragma: no cover - runtime dependency check
        raise RuntimeError(
            "faster_whisper_not_installed: run `python3 -m pip install --user faster-whisper` first"
        ) from error

    cache_dir = args.cache_dir or None
    model = WhisperModel(
        args.model,
        device=args.device,
        compute_type=args.compute_type,
        download_root=cache_dir,
    )
    segments, info = model.transcribe(
        args.file,
        language=args.language or None,
        vad_filter=True,
        beam_size=1,
        condition_on_previous_text=False,
    )
    text = " ".join(segment.text.strip() for segment in segments if getattr(segment, "text", "").strip()).strip()
    if not text:
        raise RuntimeError("empty_transcript")

    print(
        json.dumps(
            {
                "ok": True,
                "text": text,
                "model": args.model,
                "language": getattr(info, "language", None),
                "duration": getattr(info, "duration", None),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # pragma: no cover - surfaced to Node stderr
        print(str(error), file=sys.stderr)
        sys.exit(1)

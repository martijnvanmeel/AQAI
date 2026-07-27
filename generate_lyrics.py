#!/usr/bin/env python3
"""Batch-generate word-level lyric timing for every track in the library.

For each (json, audio) pair that has lyrics and doesn't already have cached
timing, this runs Whisper (word-level timestamps) on the audio, then aligns
those timestamps against the *real* lyrics we already know from the Suno
metadata (see align_lyrics.py) rather than trusting Whisper's own transcript.
Results are cached to player/lyrics_auto/<track id>.json so this only ever
needs to run once per track; re-running is safe and skips finished tracks.
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))

import server
from align_lyrics import align_words_to_timing, words_from_segments

AUTO_DIR = os.path.join(os.path.dirname(__file__), "lyrics_auto")
os.makedirs(AUTO_DIR, exist_ok=True)

MODEL_SIZE = os.environ.get("LYRICS_MODEL", "small")


def already_done(track_id: str) -> bool:
    return os.path.exists(os.path.join(AUTO_DIR, f"{track_id}.json"))


def main():
    from faster_whisper import WhisperModel

    tracks = server.scan_library()
    todo = [t for t in tracks if t["lyrics"] and not already_done(t["id"])]
    print(f"{len(tracks)} tracks total, {len(todo)} need lyric timing generated")
    if not todo:
        return

    print(f"Loading Whisper model ({MODEL_SIZE})...")
    model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")

    done = 0
    failed = []
    t_start = time.time()
    for track in todo:
        tid = track["id"]
        out_path = os.path.join(AUTO_DIR, f"{tid}.json")
        try:
            segments, info = model.transcribe(
                track["_path"], word_timestamps=True, language="en", vad_filter=True
            )
            hyp_words = words_from_segments(segments)
            duration = info.duration or track["duration"] or 180
            lines = align_words_to_timing(track["lyrics"], hyp_words, duration)
            with open(out_path, "w", encoding="utf-8") as fh:
                json.dump({"lines": lines}, fh)
            done += 1
            elapsed = time.time() - t_start
            print(f"[{done}/{len(todo)}] {track['folder']}/{track['title']} "
                  f"({elapsed:.0f}s elapsed)")
        except Exception as e:
            failed.append((track["title"], str(e)))
            print(f"FAILED: {track['folder']}/{track['title']}: {e}")

    print(f"\nDone. {done} generated, {len(failed)} failed.")
    if failed:
        for title, err in failed:
            print(f"  - {title}: {err}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""One-off: generate .karaoke.json sidecars for audio files that have no
lyric source at all yet (no Suno metadata json to align against, unlike
generate_lyrics.py) - so this transcribes with Whisper and uses its own
transcript directly as the lyrics, same as the existing "source": "asr"
sidecars already in the library.
"""

import json
import os

LIBRARY_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
MODEL_SIZE = os.environ.get("LYRICS_MODEL", "small")
MAX_WORDS_PER_LINE = 5
BLANK_GAP_SECONDS = 0.5
MIN_PROBABILITY = 0.4

TARGETS = [
    ("Collective", "Taakatvar Aadmi Remastered.m4a"),
    ("Collective", "Every morning same old station.m4a"),
    ("Collective", "The Existence of God.m4a"),
    ("Collective", "Dont Like Me Again_1.m4a"),
    ("Collective", "Tempête Dans Le Verre.m4a"),
    ("Collective", "Where Do I Go.m4a"),
    ("Collective", "Big Pizza Pie.mp3"),
    ("Collective", "In the Clouds_1.m4a"),
    ("Collective", "The Story of My Life Remastered x2 Cover.m4a"),
    ("SmoothFemaleSinger", "FLOWERS IN HER HAIR.WAV"),
    ("SmoothSinger", "The Best Is Yet To Come.mp3"),
    ("SmoothSinger", "You Never Seen To Care.mp3"),
    ("SmoothSinger", "Walking Without an End in Sight.mp3"),
    ("SmoothSinger", "You and me are living together.wav"),
]


def group_into_lines(words):
    lines, cur, prev_end = [], [], None
    for w, s, e in words:
        if cur and (len(cur) >= MAX_WORDS_PER_LINE or (prev_end is not None and s - prev_end >= BLANK_GAP_SECONDS)):
            lines.append(cur)
            cur = []
        cur.append((w, s, e))
        prev_end = e
    if cur:
        lines.append(cur)
    return lines


def main():
    from faster_whisper import WhisperModel

    print(f"Loading Whisper model ({MODEL_SIZE})...")
    model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")

    for i, (folder, filename) in enumerate(TARGETS, 1):
        audio_path = os.path.join(LIBRARY_ROOT, folder, filename)
        title = os.path.splitext(filename)[0]
        out_path = os.path.join(LIBRARY_ROOT, folder, f"{title}.karaoke.json")
        if os.path.exists(out_path):
            print(f"[{i}/{len(TARGETS)}] skip (already exists): {folder}/{title}")
            continue
        if not os.path.exists(audio_path):
            print(f"[{i}/{len(TARGETS)}] MISSING AUDIO: {audio_path}")
            continue

        print(f"[{i}/{len(TARGETS)}] transcribing: {folder}/{title}")
        # vad_filter=True has misfired on a few tracks here - misreading a
        # full song with plenty of audible vocals as speech-free and
        # dropping every word (see retry_missing_karaoke.py) - so it's off
        segments, info = model.transcribe(audio_path, word_timestamps=True, vad_filter=False)

        words = []
        for seg in segments:
            for w in seg.words:
                if w.probability >= MIN_PROBABILITY:
                    words.append((w.word.strip(), w.start, w.end))
        duration = round(info.duration or 0, 2)

        if not words:
            data = {
                "title": title,
                "audioFile": filename,
                "duration": duration,
                "source": "instrumental",
                "render": {"maxWordsPerLine": MAX_WORDS_PER_LINE, "leadSeconds": 0.3, "blankGapSeconds": BLANK_GAP_SECONDS},
                "lines": [],
            }
        else:
            lines = []
            for idx, group in enumerate(group_into_lines(words)):
                lines.append({
                    "i": idx,
                    "start": round(group[0][1], 2),
                    "end": round(group[-1][2], 2),
                    "text": " ".join(w for w, _, _ in group),
                    "words": [{"w": w, "s": round(s, 2), "e": round(e, 2)} for w, s, e in group],
                })
            data = {
                "title": title,
                "audioFile": filename,
                "duration": duration,
                "source": "asr",
                "render": {"maxWordsPerLine": MAX_WORDS_PER_LINE, "leadSeconds": 0.3, "blankGapSeconds": BLANK_GAP_SECONDS},
                "lines": lines,
            }

        with open(out_path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=1)
        print(f"   -> {len(data['lines'])} lines written to {out_path}")

    print("Done.")


if __name__ == "__main__":
    main()

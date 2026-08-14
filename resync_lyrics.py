#!/usr/bin/env python3
"""Re-sync specific tracks whose audio was re-edited/re-exported after
their .karaoke.json was generated (e.g. a Suno-style drum-roll intro
trimmed out) - the words are still right but the timestamps drift.

Always re-transcribes the CURRENT audio with Whisper. When a Suno
metadata .json (with the real lyric prompt) exists for a track, its real
lyric lines are aligned to the fresh Whisper timestamps (align_lyrics.py)
rather than trusting Whisper's own transcript - more accurate, and keeps
the track's natural line breaks. Falls back to raw ASR (Whisper's own
transcript, hard-wrapped every 5 words) for tracks with no such metadata.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server
from align_lyrics import lcs_align, normalize, flatten_lines

MODEL_SIZE = os.environ.get("LYRICS_MODEL", "small")
MAX_WORDS_PER_LINE = 5
BLANK_GAP_SECONDS = 0.5
MIN_PROBABILITY = 0.4

# (folder, wav filename) - .wav only, per instruction: these are the
# edited/current versions, other formats in the same folder may be stale
TARGETS = [
    ("BeatlesBeltolf", "Don't Like Me Again.wav"),
    ("BeatlesBeltolf", "Hard Love Again (Remastered).wav"),
    ("BeatlesBeltolf", "Hard To Swallow.wav"),
    ("BeatlesBeltolf", "One Little Thing.wav"),
    ("BeatlesBeltolf", "The Stages of Love.wav"),
    ("BeatlesBeltolf", "You and me are living together.wav"),
    ("BeatlesBeltolf", "My Special One (Cover).wav"),
]


def align_words_to_timing_se(lyric_lines, hyp_words, duration):
    """Same LCS-anchor-and-interpolate approach as
    align_lyrics.align_words_to_timing, but keeps each word's (start, end)
    pair instead of collapsing to a single timestamp - karaoke.json needs
    both.
    """
    ref_flat = flatten_lines(lyric_lines)
    if not ref_flat:
        return []

    ref_norm = [normalize(w) for w, _ in ref_flat]
    hyp_norm = [normalize(w) for w, _, _ in hyp_words]
    pairs = lcs_align(ref_norm, hyp_norm)

    anchors = {ri: (hyp_words[hi][1], hyp_words[hi][2]) for ri, hi in pairs}
    n = len(ref_flat)
    starts = [None] * n
    ends = [None] * n
    for ri, (s, e) in anchors.items():
        starts[ri] = s
        ends[ri] = e

    matched_idx = sorted(anchors.keys())
    if not matched_idx:
        for i in range(n):
            starts[i] = duration * (i / max(1, n))
            ends[i] = starts[i] + 0.3
    else:
        first = matched_idx[0]
        if first > 0:
            next_t = starts[first]
            for k in range(first - 1, -1, -1):
                next_t = max(0.0, next_t - 0.4)
                starts[k] = next_t
                ends[k] = next_t + 0.3

        for a, b in zip(matched_idx, matched_idx[1:]):
            gap_words = b - a
            if gap_words <= 1:
                continue
            t0, t1 = starts[a], starts[b]
            span = max(0.05, t1 - t0)
            for k in range(1, gap_words):
                starts[a + k] = t0 + span * (k / gap_words)
                ends[a + k] = starts[a + k] + min(0.3, span / gap_words)

        last = matched_idx[-1]
        if last < n - 1:
            pace = 0.4
            if len(matched_idx) >= 2:
                a, b = matched_idx[-2], matched_idx[-1]
                if b > a:
                    pace = max(0.15, (starts[b] - starts[a]) / (b - a))
            t = starts[last]
            for k in range(last + 1, n):
                t = min(duration - 0.05, t + pace)
                starts[k] = t
                ends[k] = min(duration, t + 0.3)

    lines_out = []
    li_cur = -1
    for (word, li), s, e in zip(ref_flat, starts, ends):
        if li != li_cur:
            lines_out.append([])
            li_cur = li
        lines_out[-1].append({"w": word, "s": round(float(s), 2), "e": round(float(max(e, s + 0.05)), 2)})
    return lines_out


def group_into_lines_asr(words):
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
        audio_path = os.path.join(server.LIBRARY_ROOT, folder, filename)
        title = os.path.splitext(filename)[0]
        out_path = os.path.join(server.LIBRARY_ROOT, folder, f"{title}.karaoke.json")
        meta_path = os.path.join(server.LIBRARY_ROOT, folder, f"{title}.json")

        if not os.path.isfile(audio_path):
            print(f"[{i}/{len(TARGETS)}] MISSING AUDIO: {audio_path}")
            continue

        print(f"[{i}/{len(TARGETS)}] re-transcribing: {folder}/{title}")
        segments, info = model.transcribe(audio_path, word_timestamps=True, vad_filter=False)
        hyp_words = []
        for seg in segments:
            for w in seg.words:
                if w.probability >= MIN_PROBABILITY:
                    hyp_words.append((w.word.strip(), w.start, w.end))
        duration = round(info.duration or 0, 2)

        lines = []
        source = "asr"
        if os.path.isfile(meta_path):
            with open(meta_path, "r", encoding="utf-8") as fh:
                meta = json.load(fh)
            metadata = meta.get("metadata") or {}
            lyric_lines, _ = server.clean_lyrics(metadata.get("prompt", ""))
            line_word_groups = align_words_to_timing_se(lyric_lines, hyp_words, duration)
            if line_word_groups:
                source = "official-lyrics"
                for idx, words in enumerate(line_word_groups):
                    if not words:
                        continue
                    lines.append({
                        "i": idx,
                        "start": words[0]["s"],
                        "end": words[-1]["e"],
                        "text": " ".join(w["w"] for w in words),
                        "words": words,
                    })

        if not lines:
            for idx, group in enumerate(group_into_lines_asr(hyp_words)):
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
            "source": source if lines else "instrumental",
            "render": {"maxWordsPerLine": MAX_WORDS_PER_LINE, "leadSeconds": 0.3, "blankGapSeconds": BLANK_GAP_SECONDS},
            "lines": lines,
        }
        with open(out_path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=1)
        print(f"   -> {len(lines)} lines written ({source}) to {out_path}")

    print("Done.")


if __name__ == "__main__":
    main()

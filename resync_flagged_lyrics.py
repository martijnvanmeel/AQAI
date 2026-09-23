#!/usr/bin/env python3
"""Re-sync every track currently sitting in lyrics_flags.json (flagged via
the in-app "flag out-of-sync lyrics" button) by re-transcribing the current
audio with Whisper and re-aligning it to the track's own known-correct
lyric text (see align_lyrics.py) - the words stay the same, only the
timestamps are refreshed.

Writes to whichever file actually governs that track's playback, per the
priority chain in server.py's /api/sync route (manual > karaoke sidecar >
auto):
  - sync/<id>.json already exists (a prior manual/Sync-Studio pass)  -> overwritten
  - a .karaoke.json sidecar exists                                  -> overwritten (text/title/audioFile kept, only timing refreshed)
  - neither, but real lyric text exists (Suno metadata prompt)      -> lyrics_auto/<id>.json written
  - no lyric text anywhere (nothing to align against)               -> a brand-new .karaoke.json sidecar is
                                                                         written straight from Whisper's own transcript

Tracks whose flagged audio file no longer resolves in the library (renamed/
removed since being flagged) are skipped and reported, not guessed at.

On success, clears that track's entry from lyrics_flags.json.
"""

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server
from align_lyrics import align_words_to_timing, words_from_segments, lcs_align, normalize, flatten_lines

MODEL_SIZE = os.environ.get("LYRICS_MODEL", "small")
MAX_WORDS_PER_LINE = 5
BLANK_GAP_SECONDS = 0.5
MIN_PROBABILITY = 0.4

FLAGS_PATH = os.path.join(os.path.dirname(__file__), "lyrics_flags.json")
AUTO_DIR = os.path.join(os.path.dirname(__file__), "lyrics_auto")
SYNC_DIR = os.path.join(os.path.dirname(__file__), "sync")


def align_words_to_timing_se(lyric_lines, hyp_words, duration):
    """Same LCS-anchor-and-interpolate approach as
    align_lyrics.align_words_to_timing, but keeps each word's (start, end)
    pair instead of collapsing to a single timestamp - karaoke.json needs
    both. (mirrors resync_lyrics.py's version)
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

    with open(FLAGS_PATH, "r", encoding="utf-8") as fh:
        flags = json.load(fh)
    if not flags:
        print("No flagged tracks.")
        return

    tracks = server.scan_library()
    idx = {t["id"]: t for t in tracks}
    sync_ids = {f[:-5] for f in os.listdir(SYNC_DIR) if f.endswith(".json")}

    resolved = {}
    missing = {}
    for tid, info in flags.items():
        t = idx.get(tid)
        if not t:
            missing[tid] = info
            continue
        resolved[tid] = t

    print(f"{len(flags)} flagged, {len(resolved)} resolved in the library, {len(missing)} orphaned (skipped):")
    for tid, info in missing.items():
        print(f"  SKIP (not found): {info['folder']}/{info['title']} [{tid}]")

    if not resolved:
        return

    print(f"\nLoading Whisper model ({MODEL_SIZE})...")
    model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")

    done = []
    failed = []
    for i, (tid, t) in enumerate(resolved.items(), 1):
        label = f"{t['folder']}/{t['title']}"
        try:
            print(f"[{i}/{len(resolved)}] transcribing: {label}")
            segments, winfo = model.transcribe(t["_path"], word_timestamps=True, vad_filter=False)
            hyp_words = words_from_segments(segments, min_probability=MIN_PROBABILITY)
            duration = round(winfo.duration or t.get("duration") or 0, 2)

            manual = tid in sync_ids
            karaoke_path = t.get("_karaoke_path")
            lyric_lines = t["lyrics"]

            if manual:
                lines = align_words_to_timing(lyric_lines, hyp_words, duration)
                out_path = os.path.join(SYNC_DIR, f"{tid}.json")
                with open(out_path, "w", encoding="utf-8") as fh:
                    json.dump({"lines": lines}, fh, ensure_ascii=False)
                print(f"   -> re-synced manual override: {out_path}")

            elif karaoke_path:
                se_lines = align_words_to_timing_se(lyric_lines, hyp_words, duration)
                orig = server.load_karaoke_file(karaoke_path) or {}
                new_lines = []
                for idx_, words in enumerate(se_lines):
                    if not words:
                        continue
                    new_lines.append({
                        "i": idx_,
                        "start": words[0]["s"],
                        "end": words[-1]["e"],
                        "text": " ".join(w["w"] for w in words),
                        "words": words,
                    })
                orig["duration"] = duration
                orig["source"] = "official-lyrics-resynced"
                orig["lines"] = new_lines
                orig.setdefault("render", {"maxWordsPerLine": MAX_WORDS_PER_LINE, "leadSeconds": 0.3, "blankGapSeconds": BLANK_GAP_SECONDS})
                with open(karaoke_path, "w", encoding="utf-8") as fh:
                    json.dump(orig, fh, ensure_ascii=False, indent=1)
                print(f"   -> re-synced karaoke sidecar: {karaoke_path}")

            elif lyric_lines:
                lines = align_words_to_timing(lyric_lines, hyp_words, duration)
                out_path = os.path.join(AUTO_DIR, f"{tid}.json")
                with open(out_path, "w", encoding="utf-8") as fh:
                    json.dump({"lines": lines}, fh, ensure_ascii=False)
                print(f"   -> re-synced auto timing: {out_path}")

            else:
                # nothing to align against at all - use Whisper's own
                # transcript as the lyrics, same as generate_missing_karaoke.py
                title = os.path.splitext(os.path.basename(t["_path"]))[0]
                out_path = os.path.join(os.path.dirname(t["_path"]), f"{title}.karaoke.json")
                if not hyp_words:
                    data = {
                        "title": title, "audioFile": os.path.basename(t["_path"]),
                        "duration": duration, "source": "instrumental",
                        "render": {"maxWordsPerLine": MAX_WORDS_PER_LINE, "leadSeconds": 0.3, "blankGapSeconds": BLANK_GAP_SECONDS},
                        "lines": [],
                    }
                else:
                    new_lines = []
                    for idx_, group in enumerate(group_into_lines_asr(hyp_words)):
                        new_lines.append({
                            "i": idx_,
                            "start": round(group[0][1], 2),
                            "end": round(group[-1][2], 2),
                            "text": " ".join(w for w, _, _ in group),
                            "words": [{"w": w, "s": round(s, 2), "e": round(e, 2)} for w, s, e in group],
                        })
                    data = {
                        "title": title, "audioFile": os.path.basename(t["_path"]),
                        "duration": duration, "source": "asr",
                        "render": {"maxWordsPerLine": MAX_WORDS_PER_LINE, "leadSeconds": 0.3, "blankGapSeconds": BLANK_GAP_SECONDS},
                        "lines": new_lines,
                    }
                with open(out_path, "w", encoding="utf-8") as fh:
                    json.dump(data, fh, ensure_ascii=False, indent=1)
                print(f"   -> generated new karaoke sidecar from raw transcript: {out_path}")

            done.append(tid)
        except Exception as e:
            failed.append((label, str(e)))
            print(f"   FAILED: {e}")

    # clear successfully-resynced tracks from the flag queue; leave failures
    # and orphans flagged so they're still visible for follow-up
    if done:
        for tid in done:
            flags.pop(tid, None)
        with open(FLAGS_PATH, "w", encoding="utf-8") as fh:
            json.dump(flags, fh, ensure_ascii=False)

    print(f"\nDone. {len(done)} re-synced, {len(failed)} failed, {len(missing)} orphaned (still flagged).")
    if failed:
        for label, err in failed:
            print(f"  - {label}: {err}")


if __name__ == "__main__":
    main()

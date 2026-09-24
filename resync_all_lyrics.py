#!/usr/bin/env python3
"""Audit + re-sync the karaoke/lyrics timing of EVERY track in the library.

For each track that has lyric text (or existing timing):
  1. Transcribe the CURRENT audio with Whisper (word timestamps) - cached in
     whisper_cache/<id>.<model>.json so a re-run/re-align never re-transcribes.
  2. Align the track's known lyric words to Whisper's timestamps (LCS anchors,
     interpolating in between) - same approach as resync_flagged_lyrics.py.
  3. Score the EXISTING timing against Whisper (how many matched words are
     within 0.8s of where Whisper heard them) plus structural checks (words
     stacked on one timestamp, zero-length words).
  4. Only rewrite the file when the existing timing is actually bad and the new
     alignment is trustworthy (Whisper heard enough of the lyrics) - good files
     are left alone, unreliable ones are reported for a human to look at.
  5. Sung passages Whisper clearly hears that are NOT in the lyric text (the
     "missing parts") are inserted as extra lines.

Original files are copied to BACKUP_DIR before being overwritten. Manual
Sync-Studio files (sync/<id>.json, human-confirmed) are never overwritten -
they are only reported.

Usage:  resync_all_lyrics.py [--model small|medium] [--shard K/N] [--limit N]
                             [--ids a,b,c] [--report-only] [--threads T]
"""

import argparse
import json
import os
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import server
from align_lyrics import lcs_align, normalize, flatten_lines, words_from_segments

CACHE_DIR = os.path.join(HERE, "whisper_cache")
REPORT_DIR = os.path.join(HERE, "lyrics_resync_reports")
BACKUP_DIR = os.path.expanduser("~/Documents/AQAI_lyrics_backup_20260924")
AUTO_DIR = os.path.join(HERE, "lyrics_auto")
SYNC_DIR = os.path.join(HERE, "sync")

MIN_PROBABILITY = 0.4
MAX_WORDS_PER_LINE = 5
BLANK_GAP_SECONDS = 0.5
AGREE_TOLERANCE = 0.8       # seconds: existing word within this of Whisper = "in sync"
MIN_COVERAGE = 0.5          # Whisper must have matched this much of the lyrics to be trusted
ASR_MAX_COVERAGE = 0.35     # below this the lyric text doesn't match the audio: use Whisper's transcript
ASR_MIN_WORDS = 30          # ...but only if Whisper actually heard a real amount of singing
MISSING_MIN_WORDS = 6       # unmatched Whisper run this long (and this confident) = missing lyrics
MISSING_MIN_PROB = 0.55


HALLUCINATION_TOKENS = {"sous", "titres", "réalisés", "realises", "communauté", "communaute", "amara", "org",
                        "subtitles", "subtitle", "subscribe", "www", "com", "ondertiteld", "ondertiteling"}


def clean_hyp(hyp):
    """Drop what Whisper invents on stretches without clear singing: stock
    subtitle-credit phrases, and 'clumps' of words all given the same
    (zero-length) timestamp - those timestamps carry no information."""
    out = []
    n = len(hyp)
    for i, h in enumerate(hyp):
        if normalize(h[0]) in HALLUCINATION_TOKENS:
            continue
        zero = (h[2] - h[1]) < 0.06
        same_prev = i > 0 and abs(hyp[i - 1][1] - h[1]) < 0.011
        same_next = i + 1 < n and abs(hyp[i + 1][1] - h[1]) < 0.011
        if zero and (same_prev or same_next):
            continue
        out.append(h)
    return out


def asr_trustworthy(hyp):
    if len(hyp) < ASR_MIN_WORDS:
        return False
    uniq = len({normalize(h[0]) for h in hyp}) / len(hyp)
    avg_p = sum(h[3] for h in hyp) / len(hyp)
    return uniq > 0.25 and avg_p >= 0.5


def transcribe_cached(model, model_name, t):
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, f"{t['id']}.{model_name}.json")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as fh:
            d = json.load(fh)
        return d["words"], d["duration"]
    segments, info = model.transcribe(t["_path"], word_timestamps=True, vad_filter=False)
    words = []
    for seg in segments:
        for w in (seg.words or []):
            words.append([w.word.strip(), round(w.start, 2), round(w.end, 2), round(w.probability, 3)])
    duration = round(info.duration or t.get("duration") or 0, 2)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"words": words, "duration": duration}, fh, ensure_ascii=False)
    return words, duration


def current_timing(t):
    """(source, [[(word, start, end|None), ...] per line]) of whatever governs playback now."""
    tid = t["id"]
    manual = os.path.join(SYNC_DIR, f"{tid}.json")
    if os.path.exists(manual):
        with open(manual, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
        src = "manual"
    else:
        kp = t.get("_karaoke_path")
        kd = server.load_karaoke_file(kp) if kp else None
        payload = server.karaoke_to_sync_payload(kd) if kd else {"lines": []}
        src = "karaoke"
        if not payload["lines"]:
            ap = os.path.join(AUTO_DIR, f"{tid}.json")
            if os.path.exists(ap):
                with open(ap, "r", encoding="utf-8") as fh:
                    payload = json.load(fh)
                src = "auto"
            else:
                src = "none"
    lines = []
    for ln in payload.get("lines", []):
        ws = ln["words"] if isinstance(ln, dict) else ln
        lines.append([(w["w"], w.get("t", w.get("s", 0)), w.get("e")) for w in ws])
    return src, lines


def score_existing(lines, hyp):
    """How well existing timing agrees with what Whisper heard."""
    flat = [w for ln in lines for w in ln]
    n = len(flat)
    if not n:
        return dict(n=0, agree=0.0, matched=0, stacked=0.0, zero=0.0)
    stacked = sum(1 for a, b in zip(flat, flat[1:]) if abs(b[1] - a[1]) < 0.011) / max(1, n - 1)
    zero = sum(1 for w in flat if w[2] is not None and w[2] - w[1] < 0.06) / n
    ref_norm = [normalize(w[0]) for w in flat]
    hyp_norm = [normalize(h[0]) for h in hyp]
    pairs = lcs_align(ref_norm, hyp_norm)
    if not pairs:
        return dict(n=n, agree=0.0, matched=0, stacked=stacked, zero=zero)
    ok = sum(1 for ri, hi in pairs if abs(flat[ri][1] - hyp[hi][1]) <= AGREE_TOLERANCE)
    # local defects that whole-song averages hide: a run of words piled on one
    # timestamp, or a stretch where (nearly) every matched word is off
    run = best = 1
    for a, b in zip(flat, flat[1:]):
        run = run + 1 if abs(b[1] - a[1]) < 0.011 else 1
        best = max(best, run)
    off = [abs(flat[ri][1] - hyp[hi][1]) > AGREE_TOLERANCE for ri, hi in pairs]
    local_drift = any(sum(off[i:i + 12]) >= 10 for i in range(0, max(1, len(off) - 11)))
    return dict(n=n, agree=ok / len(pairs), matched=len(pairs) / n, stacked=stacked, zero=zero,
                stack_run=best, local_drift=local_drift)


def align_new(lyric_lines, hyp, duration):
    """Align lyric lines to Whisper words. Returns (lines_out, coverage, extra_lines_inserted).
    lines_out: list[list[{"w","s","e"}]]."""
    ref_flat = flatten_lines(lyric_lines)
    n = len(ref_flat)
    if not n:
        return [], 0.0, 0
    ref_norm = [normalize(w) for w, _ in ref_flat]
    hyp_norm = [normalize(h[0]) for h in hyp]
    pairs = lcs_align(ref_norm, hyp_norm)
    coverage = len(pairs) / n
    starts = [None] * n
    ends = [None] * n
    for ri, hi in pairs:
        starts[ri], ends[ri] = hyp[hi][1], hyp[hi][2]
    matched_idx = sorted(ri for ri, _ in pairs)

    if not matched_idx:
        return [], 0.0, 0

    first = matched_idx[0]
    t = starts[first]
    for k in range(first - 1, -1, -1):
        t = max(0.0, t - 0.4)
        starts[k], ends[k] = t, t + 0.3
    for a, b in zip(matched_idx, matched_idx[1:]):
        gap = b - a
        if gap <= 1:
            continue
        t0, t1 = starts[a], starts[b]
        span = max(0.05, t1 - t0)
        if span / gap > 1.0:
            # Whisper heard nothing across a long stretch (instrumental break
            # / unheard section): don't smear the words evenly over it (9s per
            # word) - they read as the continuation of the previous phrase
            for k in range(1, gap):
                starts[a + k] = min(t1 - 0.05, t0 + 0.45 * k)
                ends[a + k] = starts[a + k] + 0.3
        else:
            for k in range(1, gap):
                starts[a + k] = t0 + span * (k / gap)
                ends[a + k] = starts[a + k] + min(0.3, span / gap)
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
            starts[k], ends[k] = t, min(duration, t + 0.3)

    # monotonic + sane word lengths (a word never ends after the next begins)
    for k in range(n):
        if k and starts[k] < starts[k - 1]:
            starts[k] = starts[k - 1]
        ends[k] = max(ends[k], starts[k] + 0.05)
        if k + 1 < n:
            ends[k] = min(ends[k], max(starts[k] + 0.05, starts[k + 1]))

    lines_out, li_cur = [], -1
    for (word, li), s, e in zip(ref_flat, starts, ends):
        if li != li_cur:
            lines_out.append([])
            li_cur = li
        lines_out[-1].append({"w": word, "s": round(float(s), 2), "e": round(float(e), 2)})

    # --- missing passages: confident Whisper words the lyrics don't contain ---
    matched_h = {hi: ri for ri, hi in pairs}
    extras = []  # (line index to insert BEFORE, [word dicts])
    hi_sorted = sorted(matched_h)
    bounds = [(-1, -1)] + [(hi, matched_h[hi]) for hi in hi_sorted] + [(len(hyp), n)]
    word_line = [li for _, li in ref_flat]
    for (h0, r0), (h1, r1) in zip(bounds, bounds[1:]):
        run = [hyp[i] for i in range(h0 + 1, h1) if hyp[i][3] >= MISSING_MIN_PROB]
        ref_between = r1 - r0 - 1 if r0 >= 0 and r1 <= n else None
        if len(run) < MISSING_MIN_WORDS or len({normalize(h[0]) for h in run}) < 3:
            continue
        # the lyrics already have roughly this many words here -> it's just
        # Whisper mis-hearing them, not a missing passage
        if ref_between is None or ref_between > 0:
            continue  # only gaps with NO lyric words in them: never interleave with re-timed words
        if run[-1][2] - run[0][1] < 2.0:
            continue
        before = word_line[r1] if r1 < n else len(lines_out)
        for g in range(0, len(run), MAX_WORDS_PER_LINE):
            grp = run[g:g + MAX_WORDS_PER_LINE]
            extras.append((before, [{"w": h[0], "s": round(h[1], 2), "e": round(max(h[2], h[1] + 0.05), 2)} for h in grp]))
    for before, words in sorted(extras, key=lambda x: -x[0]):
        lines_out.insert(before, words)
    lines_out.sort(key=lambda ws: ws[0]["s"] if ws else 0)  # stable: keeps ties in lyric order
    prev_s = 0.0
    for ws in lines_out:  # safety net: times never run backwards
        for w in ws:
            if w["s"] < prev_s:
                w["s"] = prev_s
            w["e"] = round(max(w["e"], w["s"] + 0.05), 2)
            prev_s = w["s"]
    return lines_out, coverage, len(extras)


def write_result(t, src, lines_out, duration):
    tid = t["id"]
    os.makedirs(BACKUP_DIR, exist_ok=True)

    def backup(p):
        rel = os.path.relpath(p, os.path.dirname(HERE))
        dst = os.path.join(BACKUP_DIR, rel)
        if not os.path.exists(dst):
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(p, dst)

    kp = t.get("_karaoke_path")
    if kp:
        backup(kp)
        orig = server.load_karaoke_file(kp) or {}
        orig["duration"] = duration
        orig["source"] = "official-lyrics-resynced"
        orig["lines"] = [{
            "i": i, "start": ws[0]["s"], "end": ws[-1]["e"],
            "text": " ".join(w["w"] for w in ws), "words": ws,
        } for i, ws in enumerate(lines_out) if ws]
        orig.setdefault("render", {"maxWordsPerLine": MAX_WORDS_PER_LINE, "leadSeconds": 0.3, "blankGapSeconds": BLANK_GAP_SECONDS})
        with open(kp, "w", encoding="utf-8") as fh:
            json.dump(orig, fh, ensure_ascii=False, indent=1)
        return kp
    out = os.path.join(AUTO_DIR, f"{tid}.json")
    if os.path.exists(out):
        backup(out)
    os.makedirs(AUTO_DIR, exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump({"lines": [{"words": [{"w": w["w"], "t": w["s"], "e": w["e"]} for w in ws]}
                             for ws in lines_out if ws]}, fh, ensure_ascii=False)
    return out


def asr_lines(hyp):
    """Whisper's own transcript grouped into short lines (5 words / 0.5s gap)."""
    lines, cur, prev_end = [], [], None
    for w, s, e, _p in hyp:
        if cur and (len(cur) >= MAX_WORDS_PER_LINE or (prev_end is not None and s - prev_end >= BLANK_GAP_SECONDS)):
            lines.append(cur)
            cur = []
        cur.append({"w": w, "s": round(s, 2), "e": round(max(e, s + 0.05), 2)})
        prev_end = e
    if cur:
        lines.append(cur)
    return lines


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="small")
    ap.add_argument("--shard", default="0/1")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--ids", default="")
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--report-only", action="store_true")
    args = ap.parse_args()
    k, nshards = (int(x) for x in args.shard.split("/"))

    tracks = server.scan_library()
    want = set(args.ids.split(",")) if args.ids else None
    todo = []
    for t in tracks:
        if want and t["id"] not in want:
            continue
        src, lines = current_timing(t)
        if not t["lyrics"] and not lines:
            continue  # instrumental / nothing to sync
        todo.append(t)
    todo.sort(key=lambda t: t["id"])
    todo = [t for i, t in enumerate(todo) if i % nshards == k]
    if args.limit:
        todo = todo[:args.limit]

    from faster_whisper import WhisperModel
    model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=args.threads or 0)

    os.makedirs(REPORT_DIR, exist_ok=True)
    report_path = os.path.join(REPORT_DIR, f"report_{args.model}_{k}of{nshards}.jsonl")
    print(f"[{k}/{nshards}] {len(todo)} tracks, model={args.model}", flush=True)
    for i, t in enumerate(todo, 1):
        label = f"{t['folder']}/{t['title']}"
        rec = {"id": t["id"], "folder": t["folder"], "title": t["title"]}
        t0 = time.time()
        try:
            hyp, duration = transcribe_cached(model, args.model, t)
            src, lines = current_timing(t)
            ex = score_existing(lines, clean_hyp([h for h in hyp if h[3] >= MIN_PROBABILITY]))
            lyric_lines = t["lyrics"] or [" ".join(w for w, _, _ in ln) for ln in lines]
            hyp_ok = clean_hyp([h for h in hyp if h[3] >= MIN_PROBABILITY])
            new_lines, coverage, n_extra = align_new(lyric_lines, hyp_ok, duration)
            bad_existing = (ex["n"] == 0 or ex["agree"] < 0.85 or ex["stacked"] > 0.15 or ex["zero"] > 0.15
                            or ex["matched"] < 0.6
                            or ex.get("stack_run", 0) >= 5 or ex.get("local_drift", False))
            rec.update(src=src, existing=ex, coverage=round(coverage, 3), extra_lines=n_extra,
                       whisper_words=len(hyp_ok), bad_existing=bad_existing)
            if src == "manual":
                rec["action"] = "manual-kept" + ("-CHECK" if bad_existing else "")
            elif not bad_existing and n_extra == 0:
                rec["action"] = "ok-kept"
            elif coverage >= MIN_COVERAGE:
                # Whisper heard most of the known lyrics: re-time them (plus
                # any clearly-sung passages the lyric text was missing)
                if args.report_only:
                    rec["action"] = "would-rewrite"
                else:
                    rec["written"] = write_result(t, src, new_lines, duration)
                    rec["action"] = "rewritten"
            elif coverage < ASR_MAX_COVERAGE and asr_trustworthy(hyp_ok) and bad_existing:
                # the lyric text barely matches what's actually sung (wrong /
                # over-long lyrics) - fall back to what Whisper heard
                if args.report_only:
                    rec["action"] = "would-use-ASR"
                else:
                    rec["written"] = write_result(t, src, asr_lines(hyp_ok), duration)
                    rec["action"] = "rewritten-from-ASR"
            else:
                rec["action"] = "whisper-unreliable-REVIEW"
        except Exception as e:
            rec["action"] = "error"
            rec["error"] = f"{type(e).__name__}: {e}"
        rec["secs"] = round(time.time() - t0, 1)
        with open(report_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        print(f"[{k}/{nshards}] {i}/{len(todo)} {rec['action']:26s} {label}  ({rec['secs']}s)", flush=True)


if __name__ == "__main__":
    main()

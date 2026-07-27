"""Align known ground-truth lyrics to audio using Whisper word timestamps
as anchors, rather than trusting Whisper's own (often mis-heard) transcript.

We already know the real words (from the Suno metadata prompt). What we
don't know is *when* each word is sung. So: run ASR to get a rough set of
(word, start_time) anchors, then align that hypothesis sequence against the
real lyric words with a longest-common-subsequence match. Matched words take
the ASR timestamp; everything in between is interpolated.
"""

import re


def normalize(word: str) -> str:
    w = word.lower()
    w = re.sub(r"[^a-z0-9']", "", w)
    w = w.strip("'")
    return w


def flatten_lines(lines):
    """lines: list[str] (one lyric line each) -> list[(word, line_idx)]"""
    flat = []
    for li, line in enumerate(lines):
        for w in line.split():
            flat.append((w, li))
    return flat


def lcs_align(ref_norm, hyp_norm):
    """Longest common subsequence alignment between two token lists.
    Returns list of (ref_idx, hyp_idx) for matched pairs, in order.
    """
    n, m = len(ref_norm), len(hyp_norm)
    if n == 0 or m == 0:
        return []

    # DP LCS length table (O(n*m) — fine for song-length word counts)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            if ref_norm[i] and ref_norm[i] == hyp_norm[j]:
                dp[i][j] = dp[i + 1][j + 1] + 1
            else:
                dp[i][j] = max(dp[i + 1][j], dp[i][j + 1])

    pairs = []
    i = j = 0
    while i < n and j < m:
        if ref_norm[i] and ref_norm[i] == hyp_norm[j]:
            pairs.append((i, j))
            i += 1
            j += 1
        elif dp[i + 1][j] >= dp[i][j + 1]:
            i += 1
        else:
            j += 1
    return _drop_weak_isolated_matches(pairs, ref_norm)


def _drop_weak_isolated_matches(pairs, ref_norm, min_isolated_len=5):
    """A single short/common word (e.g. "late", "was") matching in isolation
    is often a coincidence (misheard filler noise, VAD hiccup) rather than a
    real anchor. Keep a match only if it's part of a run of >=2 consecutive
    ref/hyp words, or the matched word is long/distinctive enough to trust
    on its own.
    """
    if not pairs:
        return pairs
    keep = [False] * len(pairs)
    for idx, (ri, hi) in enumerate(pairs):
        prev_run = idx > 0 and pairs[idx - 1] == (ri - 1, hi - 1)
        next_run = idx + 1 < len(pairs) and pairs[idx + 1] == (ri + 1, hi + 1)
        if prev_run or next_run or len(ref_norm[ri]) >= min_isolated_len:
            keep[idx] = True
    return [p for p, k in zip(pairs, keep) if k]


def words_from_segments(segments, min_probability=0.4):
    """Flatten faster-whisper segments into (word, start, end), dropping
    low-confidence words. Whisper occasionally hallucinates a word during
    an instrumental intro/silence with near-zero probability; those make
    terrible timing anchors, so they're filtered before alignment.
    """
    out = []
    for s in segments:
        for w in s.words:
            if w.probability >= min_probability:
                out.append((w.word.strip(), w.start, w.end))
    return out


def align_words_to_timing(lyric_lines, hyp_words, duration):
    """
    lyric_lines: list[str] ground-truth lyric lines (as sung, real words)
    hyp_words: list[(word, start, end)] from Whisper, in time order,
               already filtered for confidence (see words_from_segments)
    duration: track duration in seconds

    Returns: [{"words": [{"w": word, "t": seconds}, ...]}, ...] per line
    """
    ref_flat = flatten_lines(lyric_lines)
    if not ref_flat:
        return []

    ref_norm = [normalize(w) for w, _ in ref_flat]
    hyp_norm = [normalize(w) for w, _, _ in hyp_words]

    pairs = lcs_align(ref_norm, hyp_norm)

    # anchors[i] = start time assigned to ref word i, for matched indices
    anchors = {}
    for ri, hi in pairs:
        anchors[ri] = hyp_words[hi][1]

    n = len(ref_flat)
    times = [None] * n
    for ri, t in anchors.items():
        times[ri] = t

    # interpolate gaps between matched anchors (and before/after)
    matched_idx = sorted(anchors.keys())
    if not matched_idx:
        # no anchors at all: spread evenly across duration as last resort
        for i in range(n):
            times[i] = duration * (i / max(1, n))
    else:
        # before first anchor: space backwards at the local pace
        first = matched_idx[0]
        if first > 0:
            next_t = times[first]
            local_gap = 0.4
            for k in range(first - 1, -1, -1):
                next_t = max(0.0, next_t - local_gap)
                times[k] = next_t

        # between anchors
        for a, b in zip(matched_idx, matched_idx[1:]):
            gap_words = b - a
            if gap_words <= 1:
                continue
            t0, t1 = times[a], times[b]
            span = max(0.05, t1 - t0)
            for k in range(1, gap_words):
                times[a + k] = t0 + span * (k / gap_words)

        # after last anchor: continue at local pace, capped to duration
        last = matched_idx[-1]
        if last < n - 1:
            # estimate local pace from the last matched gap if possible
            pace = 0.4
            if len(matched_idx) >= 2:
                a, b = matched_idx[-2], matched_idx[-1]
                if b > a:
                    pace = max(0.15, (times[b] - times[a]) / (b - a))
            t = times[last]
            for k in range(last + 1, n):
                t = min(duration - 0.05, t + pace)
                times[k] = t

    # rebuild per-line structure
    lines_out = []
    li_cur = -1
    for (word, li), t in zip(ref_flat, times):
        if li != li_cur:
            lines_out.append({"words": []})
            li_cur = li
        lines_out[-1]["words"].append({"w": word, "t": round(float(t), 2)})
    return lines_out

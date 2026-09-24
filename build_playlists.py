#!/usr/bin/env python3
"""Builds static/playlists.json: 5 mix playlists across ALL artists.

1. Loads the per-track audio features from playlist_cache/ (analyze_tracks.py).
2. Clusters the tracks into 5 moods (k-means) on tempo, energy, brightness,
   onset density, dynamics and major/minor, plus a few "texture" dimensions
   distilled from the words in each track's style description (piano, jazz,
   synth, atmospheric...). Artists are deliberately NOT a feature, so every
   playlist mixes artists.
3. Names each cluster for what sets it apart (loudest, sparsest, slowest...).
4. Orders each playlist as an energy arc (gentle start, build to a peak
   around 70%, then wind down), preferring neighbours that are close in key
   (circle of fifths) and tempo, and avoiding the same artist twice in a row.

Playlist entries are keyed by (folder, title) - track ids are hashes of the
audio file's absolute path, which differs between this Mac and the server.

Usage: build_playlists.py [--seed N]
"""

import argparse
import glob
import json
import math
import os
import re
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

K = 5
# name -> (blurb, feature it is picked for, +1 = highest / -1 = lowest). Picked
# greedily in this order, so each cluster gets the name that fits it best.
PLAYLIST_DEFS = [
    ("Full Tilt", "Big, loud and dramatic - the most energetic, most dynamic tracks.", "energy", +1),
    ("Slow Burn", "Dark, sparse and intimate - dim lights, soft edges.", "brightness", -1),
    ("Golden Hour", "The slowest, warmest grooves - easy and unhurried.", "tempo", -1),
    ("Open Road", "A steady, driving pulse - the fastest tempos, held in a groove.", "tempo", +1),
    ("Bright Lights", "Busy, bright and electric - lots going on.", "onset_density", +1),
]
# one accent color per mix, same vibrancy as the artist palette's orange
MIX_COLORS = {
    "Slow Burn": "#7FD672",     # green (the snail)
    "Golden Hour": "#FF7F27",   # orange (the goldfish)
    "Open Road": "#C9A27A",     # brown (the horse)
    "Bright Lights": "#FF5A4E", # red (the ant)
    "Full Tilt": "#B5713F",     # darker brown (the bear)
}
DISPLAY_ORDER = ["Slow Burn", "Golden Hour", "Open Road", "Bright Lights", "Full Tilt"]
TEXTURES = {
    "piano": ["piano", "rhodes", "keys"],
    "guitar": ["guitar"],
    "synth": ["synth", "synths", "pads"],
    "jazz": ["jazz", "jazzy", "upright", "brushed", "swing"],
    "rock": ["rock", "distorted", "overdriven"],
    "funk": ["funk", "funky", "groove", "slap"],
    "electro": ["electro", "electronic", "808", "techno", "house"],
    "pop": ["pop", "catchy"],
    "indie": ["indie", "lo-fi", "lofi"],
    "acoustic": ["acoustic", "folk"],
    "atmos": ["atmospheric", "ambient", "ethereal", "dreamy", "reverb"],
    "warm": ["warm", "intimate", "gentle", "soft", "tape"],
    "sparse": ["sparse", "minimal", "understated"],
    "punchy": ["punchy", "driving", "upbeat", "energetic", "tight"],
    "soul": ["soul", "soulful", "gospel", "blues"],
    "horns": ["sax", "saxophone", "trumpet", "horns", "brass", "strings"],
}


def load_rows():
    rows = [json.load(open(f, encoding="utf-8")) for f in glob.glob(os.path.join(HERE, "playlist_cache", "*.json"))]
    rows.sort(key=lambda r: (r["folder"], r["title"]))
    return rows


def texture_matrix(rows):
    M = np.zeros((len(rows), len(TEXTURES)))
    for i, r in enumerate(rows):
        words = set(re.findall(r"[a-z0-9][a-z0-9\-']+", (r.get("tags") or "").lower()))
        for j, keys in enumerate(TEXTURES.values()):
            M[i, j] = 1.0 if any(k in words for k in keys) else 0.0
    return M


def zscore(x):
    return (x - x.mean(0)) / (x.std(0) + 1e-9)


def kmeans(X, k, rng, iters=100):
    n = len(X)
    c = [X[rng.integers(n)]]
    for _ in range(1, k):  # k-means++ seeding
        d2 = np.min([((X - ci) ** 2).sum(1) for ci in c], axis=0)
        c.append(X[rng.choice(n, p=d2 / d2.sum())])
    c = np.array(c)
    for _ in range(iters):
        lab = np.argmin(((X[:, None, :] - c[None]) ** 2).sum(2), axis=1)
        new = np.array([X[lab == j].mean(0) if (lab == j).any() else c[j] for j in range(k)])
        if np.allclose(new, c):
            break
        c = new
    lab = np.argmin(((X[:, None, :] - c[None]) ** 2).sum(2), axis=1)
    return lab, c, float(((X - c[lab]) ** 2).sum())


def fifths_pos(key_idx, mode):
    major_idx = key_idx if mode == "major" else (key_idx + 3) % 12  # relative major
    return (major_idx * 7) % 12


def key_dist(a, b):
    d = abs(fifths_pos(a["key_idx"], a["mode"]) - fifths_pos(b["key_idx"], b["mode"]))
    return min(d, 12 - d)  # 0..6


def order_playlist(items, energy_rank):
    """Energy arc + harmonic/tempo flow + no same artist back to back."""
    n = len(items)
    left = list(range(n))
    out = []
    for pos in range(n):
        x = pos / max(1, n - 1)
        target = 0.15 + 0.75 * (math.sin(math.pi * (x ** 0.8)) ** 1.0)  # rises to a peak ~70%, eases down
        best, best_cost = None, 1e9
        for i in left:
            cost = 2.0 * abs(energy_rank[i] - target)
            if out:
                p = items[out[-1]]
                cost += 0.35 * key_dist(items[i], p) / 6 * 3
                cost += 1.0 * abs(items[i]["tempo"] - p["tempo"]) / 40
                if items[i]["folder"] == p["folder"]:
                    cost += 1.5
                if len(out) > 1 and items[i]["folder"] == items[out[-2]]["folder"]:
                    cost += 0.4
            if cost < best_cost:
                best, best_cost = i, cost
        out.append(best)
        left.remove(best)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    rows = load_rows()
    n = len(rows)
    tempo = np.log([r["tempo"] for r in rows])
    audio = np.column_stack([
        tempo,
        [r["energy"] for r in rows],
        [r["brightness"] for r in rows],
        [r["onset_density"] for r in rows],
        [r["dynamics"] for r in rows],
        [1.0 if r["mode"] == "major" else 0.0 for r in rows],
    ])
    Za = zscore(audio)
    T = texture_matrix(rows)
    Tc = T - T.mean(0)
    U, S, _ = np.linalg.svd(Tc, full_matrices=False)
    Zt = zscore(U[:, :3] * S[:3])
    X = np.hstack([Za * np.array([1.0, 1.2, 1.0, 1.0, 0.7, 0.6]), Zt * 0.55])

    rng = np.random.default_rng(args.seed)
    cands = []
    for _ in range(60):
        lab, c, inertia = kmeans(X, K, rng)
        sizes = np.bincount(lab, minlength=K)
        cands.append((inertia, sizes.min(), lab, c))
    best_inertia = min(c[0] for c in cands)
    # among near-best solutions prefer the most balanced one
    good = [c for c in cands if c[0] <= best_inertia * 1.06]
    inertia, smallest, lab, cent = max(good, key=lambda c: c[1])

    # give each cluster the name that fits it best (see PLAYLIST_DEFS)
    stats = []
    for j in range(K):
        rs = [rows[i] for i in np.where(lab == j)[0]]
        stats.append({k: float(np.mean([r[k] for r in rs])) for k in ("energy", "brightness", "tempo", "onset_density")})
    free = set(range(K))
    assigned = {}
    for name, blurb, feat, sign in PLAYLIST_DEFS:
        j = max(free, key=lambda c: sign * stats[c][feat])
        assigned[name] = j
        free.discard(j)

    out_lists = []
    for name in DISPLAY_ORDER:
        j = assigned[name]
        blurb = next(d[1] for d in PLAYLIST_DEFS if d[0] == name)
        idx = np.where(lab == j)[0]
        items = [rows[i] for i in idx]
        e = np.array([r["energy"] for r in items])
        e_rank = (e.argsort().argsort() / max(1, len(e) - 1)).tolist()
        seq = order_playlist(items, e_rank)
        tracks = [{"folder": items[s]["folder"], "title": items[s]["title"]} for s in seq]
        avg_bpm = round(float(np.mean([r["tempo"] for r in items])))
        minutes = round(sum(r["duration"] for r in items) / 60)
        tex_share = T[idx].mean(0)
        top = [list(TEXTURES.keys())[t] for t in np.argsort(-(tex_share - T.mean(0)))[:3]]
        out_lists.append({
            "id": re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-"),
            "name": name,
            "blurb": blurb,
            "color": MIX_COLORS[name],
            "avgBpm": avg_bpm,
            "minutes": minutes,
            "feel": ", ".join(top),
            "tracks": tracks,
        })

    result = {"generated": time.strftime("%Y-%m-%d"), "playlists": out_lists}
    dst = os.path.join(HERE, "static", "playlists.json")
    with open(dst, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=1)

    print(f"{n} tracks -> {K} playlists (smallest cluster {smallest})")
    for pl in out_lists:
        folders = {}
        for t in pl["tracks"]:
            folders[t["folder"]] = folders.get(t["folder"], 0) + 1
        print(f"\n{pl['name']}: {len(pl['tracks'])} tracks, ~{pl['minutes']} min, avg {pl['avgBpm']} BPM, feel: {pl['feel']}")
        print("  artists:", dict(sorted(folders.items(), key=lambda kv: -kv[1])))
    print("\nwrote", dst)


if __name__ == "__main__":
    main()

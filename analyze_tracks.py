#!/usr/bin/env python3
"""Audio features for every track, used to build the mix playlists
(build_playlists.py). Pure numpy + the bundled ffmpeg (no librosa/scipy):

  tempo (BPM, autocorrelation of the onset envelope, folded into 70-160),
  key + mode (Krumhansl-Schmuckler on a chroma vector),
  energy (mean RMS), dynamics (p90-p10 of RMS), brightness (spectral
  centroid), onset density (onsets/sec).

Results are cached per track in playlist_cache/<track key>.json so a re-run
only analyses new/changed tracks.   Usage: analyze_tracks.py [--shard K/N]
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import server
import video_export

CACHE_DIR = os.path.join(HERE, "playlist_cache")
SR = 22050
N_FFT = 2048
HOP = 512
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def track_key(t):
    return hashlib.sha1(f"{t['folder']}/{t['title']}".encode()).hexdigest()[:16]


def decode(path):
    cmd = [video_export.FFMPEG, "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


def frames(y):
    n = 1 + (len(y) - N_FFT) // HOP
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(n)[:, None]
    return y[idx] * np.hanning(N_FFT)[None, :].astype(np.float32)


def analyze(y):
    S = np.abs(np.fft.rfft(frames(y), axis=1)).astype(np.float32)  # (T, F)
    freqs = np.fft.rfftfreq(N_FFT, 1.0 / SR)
    rms = np.sqrt(np.mean(S ** 2, axis=1))
    cent = (S * freqs[None, :]).sum(1) / (S.sum(1) + 1e-9)
    live = rms > 0.1 * np.percentile(rms, 90)  # ignore near-silent frames

    # onset envelope: positive spectral flux on a log-compressed spectrum
    L = np.log1p(10 * S[:, 1:400])
    flux = np.maximum(0, np.diff(L, axis=0)).sum(1)
    env = (flux - flux.mean()) / (flux.std() + 1e-9)
    fps = SR / HOP
    thr = 1.0
    peaks = (env[1:-1] > env[:-2]) & (env[1:-1] >= env[2:]) & (env[1:-1] > thr)
    onset_density = float(peaks.sum() / (len(env) / fps))

    # tempo: autocorrelation of the onset envelope, biased to 70-160 BPM
    ac = np.correlate(env, env, mode="full")[len(env) - 1:]
    lags = np.arange(len(ac))
    bpms = 60.0 * fps / np.maximum(lags, 1)
    ok = (bpms >= 55) & (bpms <= 200)
    prior = np.exp(-0.5 * (np.log2(np.maximum(bpms, 1) / 110.0) / 0.6) ** 2)
    score = np.where(ok, ac * prior, -np.inf)
    best = int(np.argmax(score))
    tempo = float(bpms[best])
    while tempo < 70:
        tempo *= 2
    while tempo > 160:
        tempo /= 2

    # chroma -> key/mode
    sel = (freqs >= 65) & (freqs <= 2000)
    f = freqs[sel]
    pc = (np.round(12 * np.log2(f / 440.0)) + 9).astype(int) % 12
    mag = S[:, sel][live] if live.any() else S[:, sel]
    chroma = np.zeros(12)
    for k in range(12):
        chroma[k] = mag[:, pc == k].sum()
    chroma = chroma / (chroma.sum() + 1e-9)
    best_corr, key, mode = -2, 0, 1
    for k in range(12):
        for m, prof in ((1, MAJOR), (0, MINOR)):
            c = np.corrcoef(chroma, np.roll(prof, k))[0, 1]
            if c > best_corr:
                best_corr, key, mode = c, k, m
    return dict(
        tempo=round(tempo, 1),
        key=NOTES[key], mode="major" if mode else "minor", key_idx=key, key_conf=round(float(best_corr), 3),
        energy=float(np.mean(rms[live])) if live.any() else float(np.mean(rms)),
        dynamics=float(np.percentile(rms, 90) - np.percentile(rms, 10)),
        brightness=float(np.mean(cent[live])) if live.any() else float(np.mean(cent)),
        onset_density=round(onset_density, 3),
        duration=round(len(y) / SR, 1),
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shard", default="0/1")
    args = ap.parse_args()
    k, n = (int(x) for x in args.shard.split("/"))
    os.makedirs(CACHE_DIR, exist_ok=True)
    tracks = sorted(server.scan_library(), key=lambda t: (t["folder"], t["title"]))
    tracks = [t for i, t in enumerate(tracks) if i % n == k]
    for i, t in enumerate(tracks, 1):
        out = os.path.join(CACHE_DIR, track_key(t) + ".json")
        if os.path.exists(out):
            continue
        try:
            feats = analyze(decode(t["_path"]))
            feats.update(folder=t["folder"], title=t["title"], tags=t.get("tags") or "")
            with open(out, "w", encoding="utf-8") as fh:
                json.dump(feats, fh, ensure_ascii=False)
            print(f"[{k}/{n}] {i}/{len(tracks)} {t['folder']}/{t['title']}: {feats['tempo']} BPM {feats['key']} {feats['mode']}", flush=True)
        except Exception as e:
            print(f"[{k}/{n}] {i}/{len(tracks)} FAILED {t['folder']}/{t['title']}: {e}", flush=True)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Renders the 1:1 and 9:16 videos of many songs with the frame-exact renderer (video_export/offline.py).

Backgrounds are fully-3D scenes only (the `scene=` export parameter), spread over the songs in a fixed rotation - never the
animation clips from the anims folder. Output: 30 fps, ~6 Mbps H.264 + 320k AAC.

Resumable: a finished video is never rendered again (it is written as *.part.mp4 and renamed when complete), so the script can
be stopped and started at will. --count N renders the next N songs that still have missing videos (a "batch"), then stops, so
the finished files can be moved elsewhere before the next batch; already-moved videos are remembered in done.json.

  python3 render_batch.py --out exports/batch --count 60
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

ASPECTS = [("vertical", "9x16"), ("square", "1x1")]
# the 3D scenes the backgrounds rotate through (see ENVIRONMENT_SCENES in static/app.js); trimmed to the ones that render well
DEFAULT_SCENES = ["road", "mist", "maze", "tiles", "beams", "prism", "rings", "check", "cube", "portal", "domino"]


def safe(name):
    name = re.sub(r'[\\/:*?"<>|]+', " ", name).strip()
    return re.sub(r"\s+", " ", name)[:90] or "untitled"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(HERE, "exports", "batch"))
    ap.add_argument("--count", type=int, default=60, help="songs to do in this run (both videos each)")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--crf", default="21")
    ap.add_argument("--maxrate", default="8M")
    ap.add_argument("--preset", default="medium")
    ap.add_argument("--scenes", default=",".join(DEFAULT_SCENES))
    ap.add_argument("--port", type=int, default=8420)
    ap.add_argument("--only", default=None, help="comma separated track ids (testing)")
    a = ap.parse_args()

    import server
    scenes = [s for s in a.scenes.split(",") if s]
    os.makedirs(a.out, exist_ok=True)
    state_path = os.path.join(a.out, "done.json")
    done = set(json.load(open(state_path))) if os.path.exists(state_path) else set()

    tracks = sorted((t for t in server.scan_library() if os.path.isfile(t.get("_path", ""))),
                    key=lambda t: (str(t.get("folder", "")).lower(), str(t.get("title", "")).lower(), t["id"]))
    if a.only:
        want = set(a.only.split(","))
        tracks = [t for t in tracks if t["id"] in want]
    used = {}
    jobs = []          # (song_index, track, aspect, label, scene, path)
    songs_todo = []
    for idx, t in enumerate(tracks):
        base = safe(f"{t.get('artist', '')} - {t['title']}")
        if base in used and used[base] != t["id"]:
            base = f"{base} [{t['id'][:6]}]"
        used[base] = t["id"]
        scene = scenes[idx % len(scenes)]
        missing = []
        for aspect, label in ASPECTS:
            final = os.path.join(a.out, f"{base} ({label}).mp4")
            key = f"{t['id']}_{aspect}"
            if key in done or os.path.exists(final):
                continue
            missing.append((aspect, label, final, key))
        if missing:
            songs_todo.append((t, scene, missing))
    songs_todo = songs_todo[: a.count]
    print(f"{len(tracks)} songs in the library, {len(songs_todo)} in this batch "
          f"({sum(len(m) for _, _, m in songs_todo)} videos), {a.workers} at a time -> {a.out}", flush=True)

    queue = [(t, scene, aspect, label, final, key) for t, scene, missing in songs_todo for aspect, label, final, key in missing]
    running = []
    started = time.time()
    finished = 0
    failed = []
    retries = {}
    last_launch = [0.0]

    def launch(job):
        t, scene, aspect, label, final, key = job
        part = final[:-4] + ".part.mp4"
        cmd = [sys.executable, "-m", "video_export.offline", t["id"], aspect, part, "--fps", str(a.fps), "--crf", a.crf,
               "--maxrate", a.maxrate, "--preset", a.preset, "--shot", "jpeg", "--scene", scene, "--port", str(a.port)]
        log = open(os.path.join(a.out, "render.log"), "a")
        log.write(f"\n=== {t['id']} {aspect} scene={scene} {t.get('artist')} - {t['title']}\n")
        log.flush()
        p = subprocess.Popen(cmd, cwd=HERE, stdout=log, stderr=subprocess.STDOUT)
        return {"p": p, "job": job, "part": part, "t0": time.time(), "log": log}

    try:
        while queue or running:
            while queue and len(running) < a.workers and time.time() - last_launch[0] > 12:   # staggered: the page loads are heavy
                running.append(launch(queue.pop(0)))
                last_launch[0] = time.time()
            time.sleep(5)
            for r in list(running):
                rc = r["p"].poll()
                if rc is None:
                    continue
                running.remove(r)
                r["log"].close()
                t, scene, aspect, label, final, key = r["job"]
                if rc == 0 and os.path.exists(r["part"]):
                    os.replace(r["part"], final)
                    done.add(key)
                    json.dump(sorted(done), open(state_path, "w"))
                    finished += 1
                    print(f"[{finished}] {os.path.basename(final)}  ({time.time() - r['t0']:.0f}s)  "
                          f"elapsed {(time.time() - started) / 3600:.2f}h, {len(queue)} queued", flush=True)
                else:
                    if os.path.exists(r["part"]):
                        os.remove(r["part"])
                    n = retries.get(key, 0) + 1
                    retries[key] = n
                    if n < 4:
                        print(f"retry {n} for {t['id']} {aspect} (exit {rc})", flush=True)
                        queue.insert(0, r["job"])
                    else:
                        failed.append((t["id"], aspect))
                        print(f"FAILED {t['id']} {aspect} (exit {rc}) - see render.log", flush=True)
    except KeyboardInterrupt:
        for r in running:
            r["p"].terminate()
        print("stopped; unfinished videos are discarded, finished ones are kept", flush=True)
        return
    print(f"BATCH DONE: {finished} videos in {(time.time() - started) / 3600:.2f}h, {len(failed)} failed: {failed}", flush=True)


if __name__ == "__main__":
    main()

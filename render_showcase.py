#!/usr/bin/env python3
"""13 showcase videos in 9:16: one song from every category (artist folder), plus two more from the two biggest ones.
Backgrounds are mixed: 5 x the upright portrait clips, 4 x 3D scenes, 4 x the panorama sphere with a clip.

  python3 render_showcase.py --out exports/showcase --workers 4
"""
import argparse, os, re, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# the background of each video, in order: kind, value (scene id, or the clip file)
PORTRAIT = ["003 For You.mp4", "007 I'm Turning Mad.mp4", "011 She Is Magnetic.mp4", "019 Being So Amazing I Am.mp4", "004 I Don't Want Nobody But You.mp4"]
SCENES = ["road", "rings", "prism", "portal"]
SPHERES = ["magnific_make-looping-videos_jSYQEKdLD0.mp4", "magnific_make-looping-videos_aQOeT71fSh.mp4",
           "magnific_make-looping-videos_wPDkHcL7EI.mp4", "magnific_make-looping-videos_porG99Sehw.mp4"]
KINDS = ["portrait", "scene", "sphere", "portrait", "sphere", "scene", "portrait", "sphere", "scene", "portrait", "scene", "sphere", "portrait"]


def safe(name):
    return re.sub(r"\s+", " ", re.sub(r'[\\/:*?"<>|]+', " ", name)).strip()[:90] or "untitled"


def pick_songs():
    import server
    tracks = [t for t in server.scan_library() if os.path.isfile(t.get("_path", ""))]
    by_folder = {}
    for t in sorted(tracks, key=lambda t: t["id"]):
        if t.get("lyrics") and 120 <= (t.get("duration") or 0) <= 250:
            by_folder.setdefault(t["folder"], []).append(t)
    for t in sorted(tracks, key=lambda t: t["id"]):          # a category without a song with lyrics (instrumentals): any song of a normal length
        if t["folder"] not in by_folder and 120 <= (t.get("duration") or 0) <= 300:
            by_folder.setdefault(t["folder"], []).append(t)
    picks = [lst[0] for _, lst in sorted(by_folder.items())]
    for extra in ("SmoothSinger", "Collective"):          # the two biggest categories get a second video
        picks.append(by_folder[extra][1])
    return picks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(HERE, "exports", "showcase"))
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--crf", default="17")
    ap.add_argument("--maxrate", default="8M")
    ap.add_argument("--preset", default="medium")
    ap.add_argument("--port", type=int, default=8420)
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    songs = pick_songs()
    pi = si = pa = 0
    jobs = []
    for t, kind in zip(songs, KINDS):
        if kind == "portrait":
            scene, pano, label = "sphere", PORTRAIT[pi], "portrait"; pi += 1
        elif kind == "scene":
            scene, pano, label = SCENES[si], None, "3D " + SCENES[si]; si += 1
        else:
            scene, pano, label = "sphere", SPHERES[pa], "sphere"; pa += 1
        final = os.path.join(a.out, f"{safe(t['artist'] + ' - ' + t['title'])} (9x16).mp4")
        jobs.append((t, scene, pano, label, final))
    for t, scene, pano, label, final in jobs:
        print(f"{t['folder']:22s} {t['artist']:16s} {t['title']:35s} {int(t['duration']):4d}s  [{label}]  {pano or ''}", flush=True)
    if a.list:
        return
    queue = [j for j in jobs if not os.path.exists(j[4])]
    running, last_launch, retries, failed, started = [], 0.0, {}, [], time.time()
    while queue or running:
        while queue and len(running) < a.workers and time.time() - last_launch > 12:
            t, scene, pano, label, final = queue.pop(0)
            part = final[:-4] + ".part.mp4"
            cmd = [sys.executable, "-m", "video_export.offline", t["id"], "vertical", part, "--fps", str(a.fps), "--crf", a.crf,
                   "--maxrate", a.maxrate, "--preset", a.preset, "--shot", "jpeg", "--scene", scene, "--port", str(a.port)]
            if pano:
                cmd += ["--pano", pano]
            log = open(os.path.join(a.out, "render.log"), "a")
            log.write(f"\n=== {t['id']} scene={scene} pano={pano} {t['artist']} - {t['title']}\n"); log.flush()
            running.append({"p": subprocess.Popen(cmd, cwd=HERE, stdout=log, stderr=subprocess.STDOUT), "job": (t, scene, pano, label, final), "part": part, "log": log, "t0": time.time()})
            last_launch = time.time()
        time.sleep(5)
        for r in list(running):
            rc = r["p"].poll()
            if rc is None:
                continue
            running.remove(r); r["log"].close()
            t, scene, pano, label, final = r["job"]
            if rc == 0 and os.path.exists(r["part"]):
                os.replace(r["part"], final)
                print(f"DONE {os.path.basename(final)} ({time.time() - r['t0']:.0f}s) elapsed {(time.time() - started) / 3600:.2f}h", flush=True)
            else:
                if os.path.exists(r["part"]): os.remove(r["part"])
                n = retries.get(t["id"], 0) + 1; retries[t["id"]] = n
                if n < 4:
                    print(f"retry {n} for {t['title']}", flush=True); queue.insert(0, r["job"])
                else:
                    failed.append(t["title"]); print(f"FAILED {t['title']}", flush=True)
    print(f"SHOWCASE DONE in {(time.time() - started) / 3600:.2f}h, failed: {failed}", flush=True)


if __name__ == "__main__":
    main()

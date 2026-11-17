#!/usr/bin/env python3
"""Social videos: picks random songs that have no video yet, renders them (9:16), and keeps a ledger of which songs have a video
made and which have been posted where, so no song is ever done twice.

  python3 social_videos.py status                    what is made / posted / still open
  python3 social_videos.py make 4                    render 4 random songs that have no video yet (4 at a time)
  python3 social_videos.py posted "Artist - Title" facebook=URL instagram=URL youtube=URL
                                                     record where a video was posted (done after posting, e.g. through Buffer)

The ledger is social/ledger.json. A song is identified by the audio file's path inside the library (the same on every machine, unlike
the track id). "Made" songs are skipped by `make` whether or not they were posted.
"""

import argparse
import datetime
import json
import os
import random
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
LEDGER = os.path.join(HERE, "social", "ledger.json")
OUT_DIR = os.path.join(HERE, "exports", "social")


def now():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def load():
    if os.path.exists(LEDGER):
        with open(LEDGER, encoding="utf-8") as fh:
            return json.load(fh)
    return {"songs": {}}


def save(data):
    os.makedirs(os.path.dirname(LEDGER), exist_ok=True)
    tmp = LEDGER + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=1, ensure_ascii=False, sort_keys=True)
    os.replace(tmp, LEDGER)


def library():
    import server
    tracks = [t for t in server.scan_library() if os.path.isfile(t.get("_path", ""))]
    out = []
    for t in tracks:
        key = os.path.relpath(t["_path"], server.LIBRARY_ROOT)
        out.append((key, t))
    return out


def safe(name):
    return re.sub(r"\s+", " ", re.sub(r'[\\/:*?"<>|]+', " ", name)).strip()[:90] or "untitled"


def find(data, text):
    """The ledger key whose "Artist - Title" matches `text` (case-insensitive)."""
    want = text.strip().lower()
    for key, s in data["songs"].items():
        if f"{s.get('artist', '')} - {s.get('title', '')}".lower() == want or key.lower() == want:
            return key
    return None


def cmd_status(args):
    data = load()
    lib = library()
    made = {k for k, s in data["songs"].items() if s.get("made")}
    posted = {k for k, s in data["songs"].items() if s.get("posted")}
    print(f"{len(lib)} songs in the library; {len(made)} with a video made, {len(posted)} posted, {len(lib) - len(made & {k for k, _ in lib})} still open")
    for key, s in sorted(data["songs"].items(), key=lambda kv: (kv[1].get("made") or {}).get("at", "")):
        where = ", ".join(f"{c}" for c in (s.get("posted") or {})) or "not posted"
        print(f"  {s.get('artist')} - {s.get('title')}: made {(s.get('made') or {}).get('at', '-')[:10]} | {where}")


def cmd_posted(args):
    data = load()
    key = find(data, args.song)
    if not key:
        sys.exit(f"'{args.song}' is not in the ledger (make its video first)")
    posts = data["songs"][key].setdefault("posted", {})
    for pair in args.where:
        ch, _, url = pair.partition("=")
        posts[ch.strip().lower()] = {"url": url.strip(), "at": now()}
    save(data)
    print("recorded:", ", ".join(posts))


def anim_clips():
    """(numbered portrait clips, all other clips) directly in anims/ (never _pp or new), each sorted by name."""
    import server
    names = sorted(f for f in os.listdir(server.ANIMS_DIR)
                   if f.lower().endswith(".mp4") and not f.startswith(".") and os.path.isfile(os.path.join(server.ANIMS_DIR, f)))
    numbered = [f for f in names if re.match(r"^\d{3} ", f)]
    return numbered, [f for f in names if f not in numbered]


def assign_clips(data, count, rng):
    """One background clip per video: the numbered portrait clips come first (a clip that no video has used yet), only when those
    are all used do the other clips follow."""
    used = {(s.get("made") or {}).get("bgclip") for s in data["songs"].values()}
    numbered, others = anim_clips()
    pool = [c for c in numbered if c not in used]
    rng.shuffle(pool)
    rest = [c for c in others if c not in used]
    rng.shuffle(rest)
    pool += rest
    if len(pool) < count:                       # everything used once: start over with the numbered clips
        again = list(numbered)
        rng.shuffle(again)
        pool += again
    return pool[:count]


def cmd_make(args):
    data = load()
    lib = library()
    open_songs = [(k, t) for k, t in lib if not (data["songs"].get(k) or {}).get("made")]
    if args.min_seconds:
        open_songs = [(k, t) for k, t in open_songs if (t.get("duration") or 0) >= args.min_seconds]
    if not open_songs:
        sys.exit("every song already has a video")
    rng = random.Random(args.seed)
    picks = rng.sample(open_songs, min(args.count, len(open_songs)))
    os.makedirs(OUT_DIR, exist_ok=True)
    clips = assign_clips(data, len(picks), rng)
    print(f"{len(open_songs)} songs have no video yet; rendering {len(picks)}:", flush=True)
    jobs = []
    for (key, t), clip in zip(picks, clips):
        final = os.path.join(OUT_DIR, f"{safe(t['artist'] + ' - ' + t['title'])} (9x16).mp4")
        jobs.append((key, t, final, clip))
        print(f"  {t['artist']} - {t['title']} ({int(t.get('duration') or 0)}s)  background: {clip}", flush=True)
    running, queue, failed, started = [], list(jobs), [], time.time()
    retries = {}
    last = 0.0
    while queue or running:
        while queue and len(running) < args.workers and time.time() - last > 12:
            key, t, final, clip = queue.pop(0)
            part = final[:-4] + ".part.mp4"
            cmd = [sys.executable, "-m", "video_export.offline", t["id"], "vertical", part, "--fps", "30", "--crf", "17",
                   "--maxrate", "8M", "--preset", "medium", "--shot", "jpeg", "--bgclip", clip]
            log = open(os.path.join(OUT_DIR, "render.log"), "a")
            log.write(f"\n=== {t['id']} {t['artist']} - {t['title']}\n")
            log.flush()
            running.append({"p": subprocess.Popen(cmd, cwd=HERE, stdout=log, stderr=subprocess.STDOUT), "job": (key, t, final, clip),
                            "part": part, "log": log, "n": 0})
            last = time.time()
        time.sleep(5)
        for r in list(running):
            rc = r["p"].poll()
            if rc is None:
                continue
            running.remove(r)
            r["log"].close()
            key, t, final, clip = r["job"]
            if rc == 0 and os.path.exists(r["part"]):
                os.replace(r["part"], final)
                d = load()
                d["songs"].setdefault(key, {}).update({"title": t["title"], "artist": t["artist"], "folder": t["folder"]})
                d["songs"][key]["made"] = {"file": os.path.relpath(final, HERE), "at": now(), "aspect": "9:16",
                                           "bgclip": clip}
                save(d)
                print(f"made: {t['artist']} - {t['title']} -> {os.path.basename(final)}", flush=True)
            else:
                if os.path.exists(r["part"]):
                    os.remove(r["part"])
                n = retries.get(key, 0) + 1
                retries[key] = n
                if n < 3:
                    print(f"retry {n}: {t['title']}", flush=True)
                    queue.insert(0, (key, t, final, clip))
                else:
                    failed.append(t["title"])
                    print(f"FAILED: {t['title']}", flush=True)
    print(f"DONE in {(time.time() - started) / 3600:.2f}h; failed: {failed}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status").set_defaults(fn=cmd_status)
    m = sub.add_parser("make")
    m.add_argument("count", type=int)
    m.add_argument("--workers", type=int, default=4)
    m.add_argument("--seed", type=int, default=None)
    m.add_argument("--min-seconds", type=int, default=60, help="skip songs shorter than this (default 60)")
    m.set_defaults(fn=cmd_make)
    p = sub.add_parser("posted")
    p.add_argument("song")
    p.add_argument("where", nargs="+", help="channel=URL, e.g. youtube=https://...")
    p.set_defaults(fn=cmd_posted)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()

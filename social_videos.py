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
    forced = []
    for want in (args.include or []):
        hit = [(k, t) for k, t in open_songs if f"{t['artist']} - {t['title']}".lower() == want.strip().lower()]
        if not hit:
            sys.exit(f"'{want}' not found among the songs without a video")
        forced.append(hit[0])
    rest = [kt for kt in open_songs if kt not in forced]
    picks = forced + rng.sample(rest, max(0, min(args.count - len(forced), len(rest))))
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


BUFFER_CHANNELS = {            # Buffer channel ids (from list_channels)
    "facebook": "6afb998aece6dfde5fee1906",
    "instagram": "6afb8b24ece6dfde5fec981a",
    "youtube": "6afb8be0ece6dfde5fecb84c",
}
HOST = "root@185.95.13.177"
KEY = os.path.expanduser("~/.ssh/aqai_deploy")


class Buffer:
    """Minimal client for Buffer's hosted MCP server (the same one `claude mcp add buffer` points at); reads the key from ~/.claude.json
    without ever printing it."""
    def __init__(self):
        import urllib.request
        cfg = json.load(open(os.path.expanduser("~/.claude.json")))["mcpServers"]["buffer"]
        self.url = cfg["url"]
        self.headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", **cfg.get("headers", {})}
        self.n = 0
        self.sid = None
        r = self._rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                                                                                       "clientInfo": {"name": "aqai-social", "version": "1"}}})
        try:
            self._rpc({"jsonrpc": "2.0", "method": "notifications/initialized"})
        except Exception:
            pass

    def _rpc(self, body):
        import urllib.request
        h = dict(self.headers)
        if self.sid:
            h["Mcp-Session-Id"] = self.sid
        req = urllib.request.Request(self.url, data=json.dumps(body).encode(), headers=h, method="POST")
        r = urllib.request.urlopen(req, timeout=120)
        raw = r.read().decode()
        self.sid = r.headers.get("Mcp-Session-Id") or self.sid
        if "data:" in raw[:30] or raw.lstrip().startswith("event:"):
            for line in raw.splitlines():
                if line.startswith("data:"):
                    try:
                        return json.loads(line[5:].strip())
                    except Exception:
                        pass
        return json.loads(raw) if raw.strip() else {}

    def tool(self, name, args):
        self.n += 1
        r = self._rpc({"jsonrpc": "2.0", "id": 100 + self.n, "method": "tools/call", "params": {"name": name, "arguments": args}})
        res = r.get("result", {})
        txt = "".join(c.get("text", "") for c in res.get("content", []))
        try:
            data, _ = json.JSONDecoder().raw_decode(txt)
        except Exception:
            data = {"raw": txt}
        return data, bool(res.get("isError")) or "error" in (data if isinstance(data, dict) else {})


def live_track_ids():
    import urllib.request
    d = json.load(urllib.request.urlopen("https://aqaimusic.com/api/tracks", timeout=60))
    d = d.get("tracks", d)
    return {(t["artist"], t["title"]): t["id"] for t in d}


def cmd_schedule(args):
    from zoneinfo import ZoneInfo
    data = load()
    todo = [(k, s) for k, s in sorted(data["songs"].items(), key=lambda kv: (kv[1].get("made") or {}).get("at", ""))
            if (s.get("made") or {}).get("bgclip") and not s.get("posted") and not s.get("scheduled")
            and os.path.exists(os.path.join(HERE, s["made"]["file"]))]
    if not todo:
        sys.exit("no finished, unscheduled videos")
    tz = ZoneInfo("Europe/Amsterdam")
    times = [tuple(int(x) for x in t.split(":")) for t in args.times.split(",")]
    day0 = datetime.date.fromisoformat(args.start)
    live = live_track_ids()
    buf = Buffer()
    for i, (key, s) in enumerate(todo[: args.max]):
        day = day0 + datetime.timedelta(days=i // len(times))
        hh, mm = times[i % len(times)]
        due = datetime.datetime(day.year, day.month, day.day, hh, mm, tzinfo=tz)
        local = os.path.join(HERE, s["made"]["file"])
        name = re.sub(r"[^a-z0-9]+", "-", f"{s['artist']}-{s['title']}".lower()).strip("-") + ".mp4"
        subprocess.run(["scp", "-i", KEY, "-o", "BatchMode=yes", local, f"{HOST}:/opt/aqai/player/static/social/{name}"], check=True)
        subprocess.run(["ssh", "-i", KEY, "-o", "BatchMode=yes", HOST, f"chown aqai:aqai /opt/aqai/player/static/social/{name}"], check=True)
        url = "https://aqaimusic.com/social/" + name
        tid = live.get((s["artist"], s["title"]))
        text = f"Listening to \u201c{s['title']}\u201d by {s['artist']}" + (f"\nhttps://www.aqaimusic.com/?t={tid}" if tid else "")
        sched = {}
        for ch, cid in BUFFER_CHANNELS.items():
            md = {"facebook": {"facebook": {"type": "reel"}},
                  "instagram": {"instagram": {"type": "reel", "shouldShareToFeed": True, "isAiGenerated": True}},
                  "youtube": {"youtube": {"title": f"{s['title']} \u2013 {s['artist']}"[:100], "categoryId": "10", "privacy": "public",
                                           "madeForKids": False, "isAiGenerated": True}}}[ch]
            res, err = buf.tool("create_post", {"channelId": cid, "schedulingType": "automatic", "mode": "customScheduled",
                                                "dueAt": due.isoformat(), "text": text, "assets": [{"video": {"url": url}}], "metadata": md})
            if err:
                print(f"  {ch}: ERROR {res}", flush=True)
            else:
                sched[ch] = {"postId": res.get("id"), "dueAt": res.get("dueAt") or due.isoformat()}
        if sched:
            data["songs"][key]["scheduled"] = {"at": now(), "due": due.isoformat(), "video": url, "channels": sched}
            save(data)
        print(f"scheduled {s['artist']} - {s['title']} for {due.strftime('%a %d %b %H:%M')}: {', '.join(sched)}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status").set_defaults(fn=cmd_status)
    m = sub.add_parser("make")
    m.add_argument("count", type=int)
    m.add_argument("--workers", type=int, default=4)
    m.add_argument("--seed", type=int, default=None)
    m.add_argument("--include", action="append", help="\"Artist - Title\" that must be among the songs (repeatable)")
    m.add_argument("--min-seconds", type=int, default=60, help="skip songs shorter than this (default 60)")
    m.set_defaults(fn=cmd_make)
    sc = sub.add_parser("schedule")
    sc.add_argument("--start", required=True, help="first day, YYYY-MM-DD (Amsterdam time)")
    sc.add_argument("--times", default="09:00,14:00,19:00")
    sc.add_argument("--max", type=int, default=9)
    sc.set_defaults(fn=cmd_schedule)
    p = sub.add_parser("posted")
    p.add_argument("song")
    p.add_argument("where", nargs="+", help="channel=URL, e.g. youtube=https://...")
    p.set_defaults(fn=cmd_posted)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()

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
    skip = server.excluded_clips()          # (the clips excluded with the button on the video preview page)
    names = sorted(f for f in os.listdir(server.ANIMS_DIR)
                   if f.lower().endswith(".mp4") and not f.startswith(".") and f not in skip and os.path.isfile(os.path.join(server.ANIMS_DIR, f)))
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


SHORT_MAX = 179          # a YouTube Short is at most 3 minutes: a longer song gets its first 2:59, faded out
FPS = 24                 # the new format: 24 frames per second


def needs_video(song, kind):
    """kind "short" (9:16) / "wide" (16:9, full length): does this song still need that video? An old-format 9:16 video (made before the new
    format: no "fps" in its record) that has not been scheduled or posted yet counts as not made - it is rendered again."""
    if kind == "wide":
        return not (song or {}).get("made_wide")
    m = (song or {}).get("made")
    if not m:
        return True
    return m.get("fps") != FPS and not (song or {}).get("scheduled") and not (song or {}).get("posted")


def cmd_make(args):
    """Renders videos for `count` songs - the hearted songs (social/priority.json) first, then random ones. args.aspect: "short" = the 9:16 video
    (Reels / Shorts; a song over 2:59 is cut there with a fade-out), "wide" = the full-length 16:9 video for YouTube, "both" = both of every
    song (the two videos of a song one after the other, so a song is complete early)."""
    aspect = getattr(args, "aspect", "both") or "both"
    kinds = ["short", "wide"] if aspect == "both" else [aspect]
    data = load()
    lib = library()
    open_songs = [(k, t) for k, t in lib if any(needs_video(data["songs"].get(k), kd) for kd in kinds)]
    if args.min_seconds:
        open_songs = [(k, t) for k, t in open_songs if (t.get("duration") or 0) >= args.min_seconds]
    if getattr(args, "max_seconds", None):
        open_songs = [(k, t) for k, t in open_songs if (t.get("duration") or 0) <= args.max_seconds]
    if not open_songs:
        sys.exit("every song already has its video(s)")
    rng = random.Random(args.seed)
    forced = []
    for want in (args.include or []):
        hit = [(k, t) for k, t in open_songs if f"{t['artist']} - {t['title']}".lower() == want.strip().lower()]
        if not hit:
            sys.exit(f"'{want}' not found among the songs that still need a video")
        forced.append(hit[0])
    rest = [kt for kt in open_songs if kt not in forced]
    # the songs the owner hearted in the player (social/priority.json) are first in line, then random songs fill the rest
    prio = set()
    try:
        with open(os.path.join(HERE, "social", "priority.json"), encoding="utf-8") as fh:
            prio = set(json.load(fh))
    except (OSError, ValueError):
        pass
    hearted = [kt for kt in rest if kt[0] in prio]
    rng.shuffle(hearted)
    hearted = hearted[:max(0, args.count - len(forced))]
    others = [kt for kt in rest if kt not in hearted]
    picks = forced + hearted + rng.sample(others, max(0, min(args.count - len(forced) - len(hearted), len(others))))
    if hearted:
        print(f"{len(hearted)} hearted song(s) first: " + ", ".join(f"{t['artist']} - {t['title']}" for _, t in hearted), flush=True)
    os.makedirs(OUT_DIR, exist_ok=True)
    clips = assign_clips(data, len(picks), rng)
    try:                                    # a clip pinned to a song in the player (social/bgclips.json) is the one its videos get
        with open(os.path.join(HERE, "social", "bgclips.json"), encoding="utf-8") as fh:
            pins = json.load(fh)
        import server
        clips = [pins.get(k) if (pins.get(k) and os.path.isfile(os.path.join(server.ANIMS_DIR, pins[k]))) else c
                 for (k, _t), c in zip(picks, clips)]
    except (OSError, ValueError):
        pass
    print(f"{len(open_songs)} songs still need a video; rendering {len(picks)} song(s) as {', '.join(kinds)}:", flush=True)
    jobs = []
    for (key, t), clip in zip(picks, clips):
        for kind in kinds:
            if not needs_video(data["songs"].get(key), kind):
                continue
            final = os.path.join(OUT_DIR, f"{safe(t['artist'] + ' - ' + t['title'])} ({'9x16' if kind == 'short' else '16x9'}).mp4")
            jobs.append((kind, key, t, final, clip))
        print(f"  {t['artist']} - {t['title']} ({int(t.get('duration') or 0)}s)  background: {clip}", flush=True)
    running, queue, failed, started = [], list(jobs), [], time.time()
    retries = {}
    last = 0.0
    while queue or running:
        while queue and len(running) < args.workers and time.time() - last > 12:
            kind, key, t, final, clip = queue.pop(0)
            part = final[:-4] + ".part.mp4"
            if kind == "short":
                cmd = [sys.executable, "-m", "video_export.offline", t["id"], "vertical", part, "--fps", str(FPS), "--crf", "17",
                       "--maxrate", "8M", "--preset", "medium", "--shot", "jpeg", "--bgclip", clip]
                if (t.get("duration") or 0) > SHORT_MAX + 1:          # a Short is at most 3:00: the first 2:59, faded out over the last 3 seconds
                    cmd += ["--seconds", str(SHORT_MAX), "--fade-out", "3"]
            else:
                cmd = [sys.executable, "-m", "video_export.offline", t["id"], "horizontal", part, "--fps", str(FPS), "--crf", "20",
                       "--maxrate", "5M", "--preset", "medium", "--shot", "jpeg", "--bgclip", clip]
            log = open(os.path.join(OUT_DIR, "render.log"), "a")
            log.write(f"\n=== {kind} {t['id']} {t['artist']} - {t['title']}\n")
            log.flush()
            running.append({"p": subprocess.Popen(cmd, cwd=HERE, stdout=log, stderr=subprocess.STDOUT), "job": (kind, key, t, final, clip),
                            "part": part, "log": log, "n": 0})
            last = time.time()
        time.sleep(5)
        for r in list(running):
            rc = r["p"].poll()
            if rc is None:
                continue
            running.remove(r)
            r["log"].close()
            kind, key, t, final, clip = r["job"]
            if rc == 0 and os.path.exists(r["part"]):
                os.replace(r["part"], final)
                d = load()
                d["songs"].setdefault(key, {}).update({"title": t["title"], "artist": t["artist"], "folder": t["folder"]})
                trimmed = kind == "short" and (t.get("duration") or 0) > SHORT_MAX + 1
                d["songs"][key]["made" if kind == "short" else "made_wide"] = {
                    "file": os.path.relpath(final, HERE), "at": now(), "aspect": "9:16" if kind == "short" else "16:9",
                    "bgclip": clip, "fps": FPS, **({"trimmed": SHORT_MAX} if trimmed else {})}
                save(d)
                print(f"made ({kind}): {t['artist']} - {t['title']} -> {os.path.basename(final)}", flush=True)
            else:
                if os.path.exists(r["part"]):
                    os.remove(r["part"])
                n = retries.get((kind, key), 0) + 1
                retries[(kind, key)] = n
                if n < 3:
                    print(f"retry {n}: {kind} {t['title']}", flush=True)
                    queue.insert(0, (kind, key, t, final, clip))
                else:
                    failed.append(f"{kind}: {t['title']}")
                    print(f"FAILED: {kind} {t['title']}", flush=True)
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
        return data, bool(res.get("isError")) or bool(isinstance(data, dict) and data.get("error"))


def live_track_ids():
    import urllib.request
    d = json.load(urllib.request.urlopen("https://aqaimusic.com/api/tracks", timeout=60))
    d = d.get("tracks", d)
    return {(t["artist"], t["title"]): t["id"] for t in d}


def cmd_schedule(args):
    from zoneinfo import ZoneInfo
    data = load()
    def short_ready(s):
        m = s.get("made") or {}
        return (m.get("bgclip") and (m.get("fps") == FPS or s.get("scheduled")) and not s.get("posted")
                and len((s.get("scheduled") or {}).get("channels", {})) + len((s.get("scheduled") or {}).get("skipped", {})) < len(BUFFER_CHANNELS)
                and os.path.exists(os.path.join(HERE, m["file"])))

    def wide_ready(s):
        m = s.get("made_wide") or {}
        return bool(m.get("bgclip") and not s.get("scheduled_wide") and not s.get("posted_wide") and os.path.exists(os.path.join(HERE, m["file"])))

    todo = [(k, s) for k, s in sorted(data["songs"].items(), key=lambda kv: ((kv[1].get("made") or {}).get("at", ""), (kv[1].get("made_wide") or {}).get("at", "")))
            if short_ready(s) or wide_ready(s)]
    if not todo:
        sys.exit("no finished, unscheduled videos")
    tz = ZoneInfo("Europe/Amsterdam")
    times = [tuple(int(x) for x in t.split(":")) for t in args.times.split(",")]
    day0 = datetime.date.fromisoformat(args.start)
    live = live_track_ids()
    buf = Buffer()
    taken = [datetime.datetime.fromisoformat(v["scheduled"]["due"]) for v in data["songs"].values() if v.get("scheduled")]
    floor = max([datetime.datetime.now(tz)] + taken)
    def slots():
        day = day0
        while True:
            for hh, mm in times:
                d = datetime.datetime(day.year, day.month, day.day, hh, mm, tzinfo=tz)
                if d > floor:
                    yield d
            day += datetime.timedelta(days=1)
    slot_iter = slots()
    for i, (key, s) in enumerate(todo[: args.max]):
        prev = s.get("scheduled")
        due = None
        if short_ready(s):
            due = datetime.datetime.fromisoformat(prev["due"]) if prev else next(slot_iter)
            local = os.path.join(HERE, s["made"]["file"])
            name = re.sub(r"[^a-z0-9]+", "-", f"{s['artist']}-{s['title']}".lower()).strip("-") + ".mp4"
            subprocess.run(["scp", "-i", KEY, "-o", "BatchMode=yes", local, f"{HOST}:/opt/aqai/player/static/social/{name}"], check=True)
            subprocess.run(["ssh", "-i", KEY, "-o", "BatchMode=yes", HOST, f"chown aqai:aqai /opt/aqai/player/static/social/{name}"], check=True)
            url = "https://aqaimusic.com/social/" + name
            tid = live.get((s["artist"], s["title"]))
            text = f"Listening to \u201c{s['title']}\u201d by {s['artist']}" + (f"\nhttps://www.aqaimusic.com/?t={tid}" if tid else "")
            sched = dict((prev or {}).get("channels", {}))
            for ch, cid in BUFFER_CHANNELS.items():
                if ch in sched:
                    continue          # (this channel's post already exists in Buffer: never created twice)
                md = {"facebook": {"facebook": {"type": "reel"}},
                      "instagram": {"instagram": {"type": "reel", "shouldShareToFeed": True, "isAiGenerated": True}},
                      "youtube": {"youtube": {"title": f"{s['title']} \u2013 {s['artist']}"[:100], "categoryId": "10", "privacy": "public",
                                               "madeForKids": False, "isAiGenerated": True}}}[ch]
                res, err = buf.tool("create_post", {"channelId": cid, "schedulingType": "automatic", "mode": "customScheduled",
                                                    "dueAt": due.isoformat(), "text": text, "assets": [{"video": {"url": url}}], "metadata": md})
                if err and "no longer than 3 minutes" in json.dumps(res):
                    skipped = data["songs"][key].setdefault("scheduled", {"at": now(), "due": due.isoformat(), "video": url, "channels": sched})
                    skipped.setdefault("skipped", {})[ch] = "longer than 3 minutes (YouTube Shorts)"
                    save(data)
                    print(f"  {ch}: skipped (video longer than 3 minutes)", flush=True)
                elif err:
                    print(f"  {ch}: ERROR {json.dumps(res)[:300]}", flush=True)
                else:
                    sched[ch] = {"postId": res.get("id"), "dueAt": res.get("dueAt") or due.isoformat()}
                    data["songs"][key]["scheduled"] = {"at": now(), "due": due.isoformat(), "video": url, "channels": sched}
                    save(data)        # (after every channel, so a stop in the middle never loses track of a post)
            print(f"scheduled {s['artist']} - {s['title']} for {due.strftime('%a %d %b %H:%M')}: {', '.join(sched)}", flush=True)
        if wide_ready(s):
            # the full-length 16:9 video: YouTube only, one hour after the Short of the same song (the next free slot when there is no Short)
            base = due or (datetime.datetime.fromisoformat(prev["due"]) if prev else next(slot_iter))
            wdue = base + datetime.timedelta(hours=1)
            local = os.path.join(HERE, s["made_wide"]["file"])
            name = re.sub(r"[^a-z0-9]+", "-", f"{s['artist']}-{s['title']}".lower()).strip("-") + "-16x9.mp4"
            subprocess.run(["scp", "-i", KEY, "-o", "BatchMode=yes", local, f"{HOST}:/opt/aqai/player/static/social/{name}"], check=True)
            subprocess.run(["ssh", "-i", KEY, "-o", "BatchMode=yes", HOST, f"chown aqai:aqai /opt/aqai/player/static/social/{name}"], check=True)
            url = "https://aqaimusic.com/social/" + name
            tid = live.get((s["artist"], s["title"]))
            text = f"\u201c{s['title']}\u201d by {s['artist']} \u2013 the full song." + (f"\nListen on https://www.aqaimusic.com/?t={tid}" if tid else "")
            md = {"youtube": {"title": f"{s['title']} \u2013 {s['artist']} (full song)"[:100], "categoryId": "10", "privacy": "public",
                              "madeForKids": False, "isAiGenerated": True}}
            res, err = buf.tool("create_post", {"channelId": BUFFER_CHANNELS["youtube"], "schedulingType": "automatic", "mode": "customScheduled",
                                                "dueAt": wdue.isoformat(), "text": text, "assets": [{"video": {"url": url}}], "metadata": md})
            if err:
                print(f"  youtube (16:9): ERROR {json.dumps(res)[:300]}", flush=True)
            else:
                data["songs"][key]["scheduled_wide"] = {"at": now(), "due": wdue.isoformat(), "video": url,
                                                         "channels": {"youtube": {"postId": res.get("id"), "dueAt": res.get("dueAt") or wdue.isoformat()}}}
                save(data)
                print(f"scheduled {s['artist']} - {s['title']} (16:9, YouTube) for {wdue.strftime('%a %d %b %H:%M')}", flush=True)


def cmd_cleanup(args):
    """For every scheduled video whose Buffer posts have all been sent: record the posts as posted (with their links) and delete the
    video from the server (Buffer fetches the file when the post goes out, so it has to stay until then). Covers the 9:16 videos and the
    16:9 YouTube videos."""
    data = load()
    buf = None
    for key, s in data["songs"].items():
        for sched_key, posted_key in (("scheduled", "posted"), ("scheduled_wide", "posted_wide")):
            sch = s.get(sched_key)
            if sch and not s.get(posted_key) and not sch.get("removed"):
                buf = buf or Buffer()
                states = {}
                for ch, info in sch["channels"].items():
                    res, err = buf.tool("get_post", {"postId": info["postId"]})
                    states[ch] = (res.get("status"), res.get("externalLink") or res.get("sharedLink") or "")
                if all(st == "sent" for st, _ in states.values()):
                    s[posted_key] = {ch: {"url": url, "at": now()} for ch, (st, url) in states.items()}
                    name = sch["video"].rsplit("/", 1)[-1]
                    subprocess.run(["ssh", "-i", KEY, "-o", "BatchMode=yes", HOST, f"rm -f /opt/aqai/player/static/social/{name}"], check=True)
                    sch["removed"] = now()
                    print(f"posted + removed from the server: {s['artist']} - {s['title']} ({sched_key})", flush=True)
                else:
                    print(f"waiting: {s['artist']} - {s['title']} ({sched_key}) {states}", flush=True)
                save(data)


def cmd_remove_hosted(args):
    """Delete a hosted video from the server by file name (only for videos whose posts are all sent)."""
    subprocess.run(["ssh", "-i", KEY, "-o", "BatchMode=yes", HOST, f"rm -f /opt/aqai/player/static/social/{os.path.basename(args.name)}"], check=True)
    print("removed", args.name)


def cmd_auto(args):
    """Keeps the schedule filled: removes sent videos from the server, renders more songs when fewer than --days-ahead days are scheduled,
    schedules them, and sleeps. Run it in the background; stop it with Ctrl+C / kill."""
    from zoneinfo import ZoneInfo
    tz = ZoneInfo("Europe/Amsterdam")
    per_day = len(args.times.split(","))
    while True:
        try:
            cmd_cleanup(args)
        except Exception as e:
            print("cleanup problem:", e, flush=True)
        data = load()
        n_future = sum(1 for v in data["songs"].values()
                       if v.get("scheduled") and datetime.datetime.fromisoformat(v["scheduled"]["due"]) > datetime.datetime.now(tz))
        n_ready = sum(1 for v in data["songs"].values()
                      if ((v.get("made") or {}).get("bgclip") and (v.get("made") or {}).get("fps") == FPS and not v.get("scheduled") and not v.get("posted"))
                      or ((v.get("made_wide") or {}).get("bgclip") and not v.get("scheduled_wide") and not v.get("posted_wide")))
        target = args.days_ahead * per_day
        print(f"[{now()}] scheduled ahead: {n_future} (target {target}), rendered and waiting: {n_ready}", flush=True)
        try:
            if n_ready:
                cmd_schedule(argparse.Namespace(start=datetime.datetime.now(tz).date().isoformat(), times=args.times, max=n_ready))
            elif n_future < target:
                cmd_make(argparse.Namespace(count=min(2, target - n_future), workers=2, seed=None, include=None, min_seconds=60, max_seconds=None, aspect="both"))
                continue
        except SystemExit as e:
            print("stopped step:", e, flush=True)
        except Exception as e:
            print("problem:", e, flush=True)
        time.sleep(args.sleep_minutes * 60)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status").set_defaults(fn=cmd_status)
    m = sub.add_parser("make")
    m.add_argument("count", type=int)
    m.add_argument("--workers", type=int, default=4)
    m.add_argument("--seed", type=int, default=None)
    m.add_argument("--include", action="append", help="\"Artist - Title\" that must be among the songs (repeatable)")
    m.add_argument("--max-seconds", type=int, default=None, help="skip songs longer than this (YouTube Shorts allow 180)")
    m.add_argument("--min-seconds", type=int, default=60, help="skip songs shorter than this (default 60)")
    m.add_argument("--aspect", choices=["short", "wide", "both"], default="both",
                   help="short = 9:16 (Reels/Shorts), wide = full-length 16:9 for YouTube, both = the two of the same songs")
    m.set_defaults(fn=cmd_make)
    sc = sub.add_parser("schedule")
    sc.add_argument("--start", required=True, help="first day, YYYY-MM-DD (Amsterdam time)")
    sc.add_argument("--times", default="09:00,14:00,19:00")
    sc.add_argument("--max", type=int, default=9)
    sc.set_defaults(fn=cmd_schedule)
    sub.add_parser("cleanup").set_defaults(fn=cmd_cleanup)
    rh = sub.add_parser("remove-hosted")
    rh.add_argument("name")
    rh.set_defaults(fn=cmd_remove_hosted)
    au = sub.add_parser("auto")
    au.add_argument("--days-ahead", type=int, default=14)
    au.add_argument("--times", default="09:00,14:00,19:00")
    au.add_argument("--sleep-minutes", type=int, default=30)
    au.set_defaults(fn=cmd_auto)
    p = sub.add_parser("posted")
    p.add_argument("song")
    p.add_argument("where", nargs="+", help="channel=URL, e.g. youtube=https://...")
    p.set_defaults(fn=cmd_posted)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()

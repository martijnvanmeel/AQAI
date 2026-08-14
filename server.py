#!/usr/bin/env python3
"""Local server for the AQAI music player.

Scans every folder under the library root for Suno-style .json metadata
files paired with an audio file (m4a > mp3 > wav, smallest usable first),
exposes a JSON manifest of the whole library, and streams audio with
HTTP Range support so the browser can seek.

No song list is hardcoded anywhere here or in the frontend - the
manifest is rebuilt from disk on every /api/tracks request, so dropping
new (json, audio) pairs into any folder makes them show up automatically.
"""

import hashlib
import http.server
import json
import mimetypes
import os
import re
import shutil
import socketserver
import urllib.parse

LIBRARY_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
ASSETS_DIR = os.path.join(STATIC_DIR, "assets")
SYNC_DIR = os.path.join(os.path.dirname(__file__), "sync")
AUTO_LYRICS_DIR = os.path.join(os.path.dirname(__file__), "lyrics_auto")
PANORAMA_DIR = os.path.join(LIBRARY_ROOT, "panoramas")
PANORAMA2_DIR = os.path.join(LIBRARY_ROOT, "Panoramas2")
SONG_NAMES_PATH = os.path.join(LIBRARY_ROOT, "song_names.json")
os.makedirs(SYNC_DIR, exist_ok=True)
os.makedirs(AUTO_LYRICS_DIR, exist_ok=True)

SKIP_DIR_NAMES = {".claude", ".git", "player", "node_modules", "panoramas", "Panoramas2", "_deleted"}
AUDIO_EXT_PRIORITY = ["m4a", "mp3", "wav"]
SECTION_TAG_RE = re.compile(r"^\s*\[[^\]]*\]\s*$")


def norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", name.lower())


def track_id(path: str) -> str:
    return hashlib.sha1(path.encode("utf-8")).hexdigest()[:16]


def load_folder_artist_map():
    """song_names.json's top-level "folders" list holds one renamed
    artist display name per real library folder, in the same order as
    that folder's name sorts among every folder referenced by "songs" -
    e.g. folders[0] is the display name for the alphabetically-first
    folder. Re-read on every scan (not cached) so edits to the file take
    effect without restarting the server.
    """
    try:
        with open(SONG_NAMES_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {}
    folder_names = sorted({s["folder"] for s in data.get("songs", []) if s.get("folder")})
    return dict(zip(folder_names, data.get("folders") or []))


def load_folder_photo_map(real_folders):
    """Each artist gets one profile pic - static/assets/artist_1.png,
    artist_2.png etc, assigned by alphabetically-sorted folder index (same
    convention as load_folder_artist_map, but keyed off the real folders
    actually found on disk this scan, not song_names.json). Stops at
    however many artist_N.png files actually exist, so a folder past that
    count just gets no photo (falls back to profilepic.png client-side)
    rather than wrapping back around to someone else's picture.
    """
    folder_names = sorted(real_folders)
    photo_map = {}
    for i, folder in enumerate(folder_names):
        photo_path = os.path.join(ASSETS_DIR, f"artist_{i + 1}.png")
        if os.path.isfile(photo_path):
            photo_map[folder] = f"assets/artist_{i + 1}.png"
    return photo_map


# one accent color per artist, assigned by the same alphabetically-sorted
# folder index as load_folder_photo_map - 12 colors picked from the
# swatch the user provided, plus a 13th (grey) for the one folder left over
ARTIST_COLORS = [
    # third entry (sorted folder "BOBS PLACE" = Downtown): the red variant
    # of Instrumental's #1E90FF blue - same saturation/brightness, hue
    # rotated to red (was #FF8FDB pink)
    "#7ED957", "#FF8A73", "#FF1E1E", "#7FD6FF", "#FFC27A", "#9B72FF",
    "#1E90FF", "#FF7F27", "#8C6FFF", "#52C41A", "#FFD700", "#CBA378",
    "#AAAAAA",
]


def load_folder_color_map(real_folders):
    """Same alphabetically-sorted folder index as load_folder_photo_map,
    but mapped against a fixed color list instead of files on disk - folders
    past the end of ARTIST_COLORS just get no color (client falls back to
    the default green) rather than wrapping back to someone else's color.
    """
    folder_names = sorted(real_folders)
    color_map = {}
    for i, folder in enumerate(folder_names):
        if i < len(ARTIST_COLORS):
            color_map[folder] = ARTIST_COLORS[i]
    return color_map


def clean_lyrics(prompt: str):
    """Strips [Verse]/[Chorus]/[Bridge]-style section tags out of the raw
    lyric text, but remembers where each one was so the UI can still show
    an extra gap between sections. Returns (lines, section_breaks) where
    section_breaks holds the index (into lines) of each line that starts
    a new section.
    """
    lines = []
    section_breaks = []
    pending_break = False
    for raw in (prompt or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        if SECTION_TAG_RE.match(line):
            pending_break = True
            continue
        if pending_break and lines:
            section_breaks.append(len(lines))
        lines.append(line)
        pending_break = False
    return lines, section_breaks


def _normalize_words(text):
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).split()


def remap_section_breaks(raw_lines, prompt_breaks, karaoke_lines):
    """The [Verse]/[Chorus] tags are only present in the original prompt
    text, not in the karaoke line data (which re-wraps lines to a fixed
    words-per-line render setting). Re-locate each section's opening
    words within the karaoke line stream by fuzzy word matching, so the
    section gaps survive switching to the karaoke-sourced lyrics.
    """
    flat = []
    for idx, line in enumerate(karaoke_lines):
        for w in _normalize_words(line):
            flat.append((w, idx))

    breaks = []
    pos = 0
    for b in prompt_breaks:
        if b >= len(raw_lines):
            continue
        fingerprint = _normalize_words(raw_lines[b])[:3]
        if not fingerprint:
            continue
        found_idx = None
        for start in range(pos, len(flat) - len(fingerprint) + 1):
            if [flat[start + k][0] for k in range(len(fingerprint))] == fingerprint:
                found_idx = flat[start][1]
                pos = start
                break
        if found_idx:
            breaks.append(found_idx)
    return sorted(set(breaks))


def load_karaoke_file(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, OSError):
        return None


# Suno-style karaoke exports hard-wrap long lyric lines at a fixed width,
# so a single sentence often lands as two+ separate line entries (e.g.
# "I got a life full" / "of love and bliss"). A wrapped line reliably ends
# on a word that needs something after it to read as complete - merge
# whenever the current line's last word is one of those.
CONTINUATION_LAST_WORDS = {
    "a", "an", "the", "of", "to", "in", "on", "at", "for", "with", "from",
    "by", "into", "onto", "upon", "about", "above", "below", "under",
    "over", "through", "between", "among",
    "my", "your", "his", "her", "its", "our", "their",
    "and", "or", "but", "so", "nor", "yet",
    "can", "could", "will", "would", "shall", "should", "must", "may", "might",
    "is", "are", "was", "were", "am", "be", "been", "being",
    "do", "does", "did", "don't", "doesn't", "didn't",
    "no", "not", "this", "that", "these", "those", "if", "when", "while", "as",
}


def merge_wrapped_karaoke_lines(lines):
    merged = []
    for line in lines or []:
        words = line.get("words") or []
        if merged and words:
            prev_words = merged[-1].get("words") or []
            last = re.sub(r"[^a-z']", "", (prev_words[-1]["w"] if prev_words else "").lower())
            if last in CONTINUATION_LAST_WORDS:
                prev_words.extend(words)
                merged[-1]["words"] = prev_words
                merged[-1]["text"] = " ".join(w["w"] for w in prev_words)
                continue
        merged.append({"text": line.get("text", ""), "words": list(words)})
    return merged


def karaoke_lyrics_text(data):
    lines = merge_wrapped_karaoke_lines(data.get("lines"))
    return [line["text"] for line in lines if line.get("text")]


def karaoke_to_sync_payload(data):
    out = []
    for line in merge_wrapped_karaoke_lines(data.get("lines")):
        words = [{"w": w["w"], "t": w.get("s", 0)} for w in (line.get("words") or [])]
        if words:
            out.append({"words": words})
    return {"lines": out}


def scan_library():
    tracks = []
    folder_artist_map = load_folder_artist_map()
    for dirpath, dirnames, filenames in os.walk(LIBRARY_ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIR_NAMES and not d.startswith(".")]
        rel_dir = os.path.relpath(dirpath, LIBRARY_ROOT)
        folder = "Library" if rel_dir == "." else rel_dir

        audio_by_norm = {}
        for f in filenames:
            base, ext = os.path.splitext(f)
            ext = ext[1:].lower()
            if ext in AUDIO_EXT_PRIORITY:
                audio_by_norm.setdefault(norm(base), {})[ext] = f

        karaoke_by_norm = {}
        for f in filenames:
            if f.endswith(".karaoke.json"):
                base = f[: -len(".karaoke.json")]
                karaoke_by_norm[norm(base)] = os.path.join(dirpath, f)

        matched_karaoke_norms = set()

        for f in filenames:
            if not f.endswith(".json") or f.endswith(".karaoke.json"):
                continue
            base = f[:-5]
            candidates = audio_by_norm.get(norm(base))
            if not candidates:
                continue
            audio_file = next((candidates[e] for e in AUDIO_EXT_PRIORITY if e in candidates), None)
            if not audio_file:
                continue

            json_path = os.path.join(dirpath, f)
            try:
                with open(json_path, "r", encoding="utf-8") as fh:
                    meta = json.load(fh)
            except (json.JSONDecodeError, OSError):
                continue

            title = meta.get("title") or base
            metadata = meta.get("metadata") or {}
            audio_path = os.path.join(dirpath, audio_file)
            tid = track_id(audio_path)

            lyrics, section_breaks = clean_lyrics(metadata.get("prompt", ""))
            # only mark whichever norm actually resolved the match as
            # consumed - marking both unconditionally could exclude an
            # unrelated song in loop 2 whose own filename norm happens to
            # equal this track's *title* norm (distinct song, same title)
            karaoke_path = karaoke_by_norm.get(norm(base))
            if karaoke_path:
                matched_karaoke_norms.add(norm(base))
            else:
                karaoke_path = karaoke_by_norm.get(norm(title))
                if karaoke_path:
                    matched_karaoke_norms.add(norm(title))
            if karaoke_path:
                karaoke_data = load_karaoke_file(karaoke_path)
                if karaoke_data:
                    official_lyrics = karaoke_lyrics_text(karaoke_data)
                    if official_lyrics:
                        section_breaks = remap_section_breaks(lyrics, section_breaks, official_lyrics)
                        lyrics = official_lyrics

            tracks.append({
                "id": tid,
                "title": title,
                "artist": folder_artist_map.get(folder) or meta.get("display_name") or "AQAI Records Amsterdam",
                "folder": folder,
                "duration": metadata.get("duration"),
                "tags": metadata.get("tags") or "",
                "lyrics": lyrics,
                "sectionBreaks": section_breaks,
                "audioUrl": f"/audio/{tid}",
                "audioExt": os.path.splitext(audio_file)[1][1:],
                "downloadName": f"{title}.{os.path.splitext(audio_file)[1][1:]}",
                "_path": audio_path,
                "_karaoke_path": karaoke_path,
                "_meta_path": json_path,
            })

        # Songs that only have a karaoke sidecar + audio (no Suno metadata
        # json) still deserve to show up - the karaoke file carries its own
        # title/duration/lyrics, that's enough to build a track from.
        for knorm, karaoke_path in karaoke_by_norm.items():
            if knorm in matched_karaoke_norms:
                continue
            candidates = audio_by_norm.get(knorm)
            if not candidates:
                continue
            audio_file = next((candidates[e] for e in AUDIO_EXT_PRIORITY if e in candidates), None)
            if not audio_file:
                continue
            karaoke_data = load_karaoke_file(karaoke_path)
            if not karaoke_data:
                continue
            matched_karaoke_norms.add(knorm)

            title = karaoke_data.get("title") or os.path.splitext(audio_file)[0]
            audio_path = os.path.join(dirpath, audio_file)
            tid = track_id(audio_path)

            tracks.append({
                "id": tid,
                "title": title,
                "artist": folder_artist_map.get(folder) or "AQAI Records Amsterdam",
                "folder": folder,
                "duration": karaoke_data.get("duration"),
                "tags": "",
                "lyrics": karaoke_lyrics_text(karaoke_data),
                "sectionBreaks": [],
                "audioUrl": f"/audio/{tid}",
                "audioExt": os.path.splitext(audio_file)[1][1:],
                "downloadName": f"{title}.{os.path.splitext(audio_file)[1][1:]}",
                "_path": audio_path,
                "_karaoke_path": karaoke_path,
                "_meta_path": None,
            })

    real_folders = {t["folder"] for t in tracks}
    photo_map = load_folder_photo_map(real_folders)
    color_map = load_folder_color_map(real_folders)
    for t in tracks:
        t["artistPhoto"] = photo_map.get(t["folder"])
        t["artistColor"] = color_map.get(t["folder"])

    tracks.sort(key=lambda t: (t["folder"], t["title"]))
    return tracks


_track_index = {}


def refresh_index():
    global _track_index
    tracks = scan_library()
    _track_index = {t["id"]: t for t in tracks}
    return tracks


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "AQAIPlayer/1.0"

    def log_message(self, fmt, *args):
        pass

    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _is_public_request(self):
        # A tunnel (Cloudflare Tunnel, ngrok, etc.) runs on this same Mac and
        # connects to this server over localhost, so self.client_address is
        # 127.0.0.1 for a stranger on the public internet too - it can't be
        # used to tell them apart from a request made on this machine/LAN.
        # What differs is that the tunnel stamps the real visitor's address
        # into a forwarding header before passing the request through; a
        # request that reaches this process directly (no tunnel in front)
        # never has one of these set.
        return bool(
            self.headers.get("Cf-Connecting-Ip")
            or self.headers.get("X-Forwarded-For")
            or self.headers.get("True-Client-Ip")
        )

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)

        if path == "/api/tracks":
            tracks = refresh_index()
            public = [{k: v for k, v in t.items() if k not in ("_path", "_karaoke_path", "_meta_path")} for t in tracks]
            # same local-vs-public boundary the POST edit endpoints already
            # enforce (see _is_public_request) - told to the client so it can
            # hide rename/delete/lyrics-edit controls it can't actually use
            self._send_json({"tracks": public, "editable": not self._is_public_request()})
            return

        if path == "/api/lyrics-audit":
            # owner-only QA tool: flag tracks whose karaoke sidecar looks
            # missing, empty, or suspiciously sparse for its duration - the
            # same shape of bug a misfiring VAD filter produced during a
            # batch Whisper run (a full song read as speech-free, dropping
            # every word). Not a guarantee anything's actually wrong, just
            # worth a human's eyes.
            if self._is_public_request():
                self.send_error(403)
                return
            tracks = refresh_index()
            items = []
            for t in tracks:
                karaoke_path = t.get("_karaoke_path")
                if not karaoke_path:
                    continue
                data = load_karaoke_file(karaoke_path)
                if not data:
                    continue
                source = data.get("source") or ""
                duration = data.get("duration") or t.get("duration") or 0
                lines = data.get("lines") or []
                all_words = [w for ln in lines for w in (ln.get("words") or [])]
                word_count = len(all_words)
                density = (word_count / duration) if duration else 0
                # a real sung/spoken word has some non-zero duration; a run of
                # words all stamped at the exact same instant is Whisper
                # hallucinating a stock phrase ("thanks for watching", "see
                # you next time"...) over an instrumental/silent passage -
                # a real failure mode seen firsthand generating this library
                zero_dur = sum(1 for w in all_words if (w.get("e", 0) - w.get("s", 0)) < 0.05)
                zero_dur_frac = (zero_dur / word_count) if word_count else 0

                reason = None
                if source == "instrumental" and duration > 20:
                    reason = "marked instrumental - confirm there's really no vocals"
                elif word_count == 0:
                    reason = "no lyric words at all"
                elif zero_dur_frac > 0.15:
                    reason = (
                        f"{zero_dur}/{word_count} words with no real duration - "
                        "looks like a hallucinated line over silence/instrumental"
                    )
                elif duration > 30 and density < 0.5:
                    reason = (
                        f"only {word_count} words over {duration:.0f}s "
                        f"({density:.2f} words/sec) - looks truncated"
                    )
                if reason:
                    items.append({
                        "folder": t["folder"],
                        "title": t["title"],
                        "duration": round(duration, 1),
                        "wordCount": word_count,
                        "density": round(density, 2),
                        "reason": reason,
                    })
            items.sort(key=lambda it: it["density"])
            self._send_json({"count": len(items), "items": items})
            return

        if path == "/api/panoramas":
            files = []
            if os.path.isdir(PANORAMA_DIR):
                # gradient.mp4 is a special overlay asset, not a pickable
                # background - it's still served via /panorama/, just left
                # out of the selectable list
                names = [
                    f for f in os.listdir(PANORAMA_DIR)
                    if f.lower().endswith(".mp4") and norm(f) != "gradientmp4"
                ]
                # newest first, so freshly-added clips are favored by the
                # frontend's panorama picker over older ones
                files = sorted(
                    names,
                    key=lambda f: os.path.getmtime(os.path.join(PANORAMA_DIR, f)),
                    reverse=True,
                )
            self._send_json({"files": files})
            return

        if path == "/api/panoramas2":
            files = []
            if os.path.isdir(PANORAMA2_DIR):
                names = [
                    f for f in os.listdir(PANORAMA2_DIR)
                    if f.lower().endswith((".mp4", ".gif"))
                ]
                files = sorted(
                    names,
                    key=lambda f: os.path.getmtime(os.path.join(PANORAMA2_DIR, f)),
                    reverse=True,
                )
            self._send_json({"files": files})
            return

        if path.startswith("/panorama/"):
            name = os.path.basename(path[len("/panorama/"):])
            filepath = os.path.join(PANORAMA_DIR, name)
            if not name.lower().endswith(".mp4") or not os.path.isfile(filepath):
                self.send_error(404, "Panorama not found")
                return
            self._serve_audio(filepath)
            return

        if path.startswith("/panorama2/"):
            name = os.path.basename(path[len("/panorama2/"):])
            filepath = os.path.join(PANORAMA2_DIR, name)
            if not name.lower().endswith((".mp4", ".gif")) or not os.path.isfile(filepath):
                self.send_error(404, "Panorama not found")
                return
            self._serve_audio(filepath)
            return

        if path.startswith("/api/sync/"):
            # basename strips any "../" a crafted request path could smuggle
            # in, so tid can only ever resolve to a file inside SYNC_DIR
            tid = os.path.basename(path[len("/api/sync/"):])
            # Priority: manual tap-sync (Sync Studio) always wins, since a
            # human confirmed it. Then an official karaoke.json sidecar
            # (hand-authored/verified lyric timing dropped into the library).
            # Then Whisper-aligned auto timing. Otherwise the client falls
            # back to its own rough word-count estimate.
            manual_path = os.path.join(SYNC_DIR, f"{tid}.json")
            auto_path = os.path.join(AUTO_LYRICS_DIR, f"{tid}.json")
            if os.path.exists(manual_path):
                with open(manual_path, "r", encoding="utf-8") as fh:
                    payload = json.load(fh)
                payload["source"] = "manual"
                self._send_json(payload)
                return

            if tid not in _track_index:
                refresh_index()
            track = _track_index.get(tid)
            karaoke_path = track.get("_karaoke_path") if track else None
            if karaoke_path:
                karaoke_data = load_karaoke_file(karaoke_path)
                if karaoke_data:
                    payload = karaoke_to_sync_payload(karaoke_data)
                    if payload["lines"]:
                        payload["source"] = "karaoke"
                        self._send_json(payload)
                        return

            if os.path.exists(auto_path):
                with open(auto_path, "r", encoding="utf-8") as fh:
                    payload = json.load(fh)
                payload["source"] = "auto"
                self._send_json(payload)
            else:
                self._send_json({"lines": [], "source": "none"})
            return

        if path.startswith("/audio/"):
            tid = path[len("/audio/"):]
            if tid not in _track_index:
                refresh_index()
            track = _track_index.get(tid)
            if not track or not os.path.exists(track["_path"]):
                self.send_error(404, "Track not found")
                return
            self._serve_audio(track["_path"])
            return

        self._serve_static(path)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)

        if path.startswith("/api/sync/"):
            if self._is_public_request():
                self.send_error(403, "Editing is only available locally")
                return
            tid = os.path.basename(path[len("/api/sync/"):])
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                self.send_error(400, "Invalid JSON")
                return
            sync_path = os.path.join(SYNC_DIR, f"{tid}.json")
            with open(sync_path, "w", encoding="utf-8") as fh:
                json.dump(payload, fh)
            self._send_json({"ok": True})
            return

        if path == "/api/panoramas2/remove":
            if self._is_public_request():
                self.send_error(403, "Editing is only available locally")
                return
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                self.send_error(400, "Invalid JSON")
                return
            name = os.path.basename(payload.get("file", ""))
            if not name.lower().endswith((".mp4", ".gif")):
                self.send_error(400, "Invalid file")
                return
            src = os.path.join(PANORAMA2_DIR, name)
            if not os.path.isfile(src):
                self.send_error(404, "Panorama not found")
                return
            # moved rather than deleted outright, so a wrong click is
            # recoverable - just drag it back out of Panoramas2/_removed
            removed_dir = os.path.join(PANORAMA2_DIR, "_removed")
            os.makedirs(removed_dir, exist_ok=True)
            dest = os.path.join(removed_dir, name)
            if os.path.exists(dest):
                dest = os.path.join(removed_dir, f"{track_id(src)}_{name}")
            os.replace(src, dest)
            self._send_json({"ok": True})
            return

        if path == "/api/tracks/delete":
            if self._is_public_request():
                self.send_error(403, "Editing is only available locally")
                return
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                self.send_error(400, "Invalid JSON")
                return
            tid = payload.get("id", "")
            if tid not in _track_index:
                refresh_index()
            track = _track_index.get(tid)
            if not track:
                self.send_error(404, "Track not found")
                return
            # moved (audio + its metadata/karaoke sidecars) into a
            # _deleted folder alongside them rather than unlinked outright,
            # so a wrong click stays recoverable - it just won't show up
            # in future scans (_deleted is a skipped directory name)
            for key in ("_path", "_meta_path", "_karaoke_path"):
                src = track.get(key)
                if not src or not os.path.isfile(src):
                    continue
                trash_dir = os.path.join(os.path.dirname(src), "_deleted")
                os.makedirs(trash_dir, exist_ok=True)
                name = os.path.basename(src)
                dest = os.path.join(trash_dir, name)
                if os.path.exists(dest):
                    dest = os.path.join(trash_dir, f"{track_id(src)}_{name}")
                os.replace(src, dest)
            refresh_index()
            self._send_json({"ok": True})
            return

        if path == "/api/tracks/rename":
            if self._is_public_request():
                self.send_error(403, "Editing is only available locally")
                return
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                self.send_error(400, "Invalid JSON")
                return
            tid = payload.get("id", "")
            new_title = (payload.get("title") or "").strip()
            if not new_title:
                self._send_json({"ok": False, "error": "Title cannot be empty"})
                return
            if tid not in _track_index:
                refresh_index()
            track = _track_index.get(tid)
            if not track:
                self.send_error(404, "Track not found")
                return
            # mirrors the same title-source priority used when scanning
            # (meta json wins if present, karaoke sidecar otherwise) so
            # the rename actually sticks on the next rescan
            meta_path = track.get("_meta_path")
            karaoke_path = track.get("_karaoke_path")
            target_path, key = (meta_path, "title") if meta_path else (karaoke_path, "title")
            if not target_path or not os.path.isfile(target_path):
                self._send_json({"ok": False, "error": "This track has no metadata file to rename"})
                return
            try:
                with open(target_path, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                data[key] = new_title
                with open(target_path, "w", encoding="utf-8") as fh:
                    json.dump(data, fh)
            except (OSError, json.JSONDecodeError) as e:
                self._send_json({"ok": False, "error": str(e)})
                return
            refresh_index()
            self._send_json({"ok": True, "title": new_title})
            return

        if path == "/api/artist/rename":
            if self._is_public_request():
                self.send_error(403, "Editing is only available locally")
                return
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                self.send_error(400, "Invalid JSON")
                return
            folder = payload.get("folder", "")
            new_name = (payload.get("name") or "").strip()
            if not folder or not new_name:
                self._send_json({"ok": False, "error": "Missing folder or name"})
                return
            try:
                with open(SONG_NAMES_PATH, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
            except (OSError, json.JSONDecodeError):
                data = {}
            # folders[] is positional - one renamed display name per real
            # library folder, in the same sorted order load_folder_artist_map
            # zips it against, so the write has to land at that same index
            # for every track under this folder to pick up the new name
            folder_names = sorted({s["folder"] for s in data.get("songs", []) if s.get("folder")})
            if folder not in folder_names:
                self._send_json({"ok": False, "error": "Unknown artist folder"})
                return
            idx = folder_names.index(folder)
            folders_list = list(data.get("folders") or [])
            while len(folders_list) <= idx:
                folders_list.append("")
            folders_list[idx] = new_name
            data["folders"] = folders_list
            try:
                with open(SONG_NAMES_PATH, "w", encoding="utf-8") as fh:
                    json.dump(data, fh)
            except OSError as e:
                self._send_json({"ok": False, "error": str(e)})
                return
            refresh_index()
            self._send_json({"ok": True, "name": new_name})
            return

        if path == "/api/track/relocate":
            # moves a single song's files (audio + its .json metadata + any
            # .karaoke.json sidecar) into a different top-level library
            # folder - "artist" is just which folder a song's files live
            # in, so this is the only way to genuinely move one song to a
            # different artist without also renaming/merging every other
            # song that artist has
            if self._is_public_request():
                self.send_error(403, "Editing is only available locally")
                return
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                self.send_error(400, "Invalid JSON")
                return
            track_id_val = payload.get("id", "")
            target_folder = (payload.get("targetFolder") or "").strip()
            if not track_id_val or not target_folder:
                self._send_json({"ok": False, "error": "Missing id or targetFolder"})
                return
            tracks = scan_library()
            track = next((t for t in tracks if t["id"] == track_id_val), None)
            if not track:
                self._send_json({"ok": False, "error": "Unknown track"})
                return
            folder_set = {t["folder"] for t in tracks}
            if target_folder not in folder_set:
                self._send_json({"ok": False, "error": "Unknown target artist folder"})
                return
            if target_folder == track["folder"]:
                self._send_json({"ok": False, "error": "Song is already with that artist"})
                return
            target_dir = os.path.join(LIBRARY_ROOT, target_folder)
            source_paths = [p for p in (track.get("_path"), track.get("_meta_path"), track.get("_karaoke_path")) if p]
            dest_paths = [os.path.join(target_dir, os.path.basename(p)) for p in source_paths]
            collisions = [d for d in dest_paths if os.path.exists(d)]
            if collisions:
                self._send_json({"ok": False, "error": "A file with the same name already exists there"})
                return
            moved = []
            try:
                os.makedirs(target_dir, exist_ok=True)
                for src, dst in zip(source_paths, dest_paths):
                    shutil.move(src, dst)
                    moved.append((src, dst))
            except OSError as e:
                # best-effort rollback of whatever already moved, so a
                # failure partway through doesn't leave the song split
                # across two folders
                for src, dst in moved:
                    try:
                        shutil.move(dst, src)
                    except OSError:
                        pass
                self._send_json({"ok": False, "error": str(e)})
                return
            refresh_index()
            self._send_json({"ok": True, "folder": target_folder})
            return

        self.send_error(404)

    def _serve_audio(self, filepath):
        file_size = os.path.getsize(filepath)
        content_type = mimetypes.guess_type(filepath)[0] or "application/octet-stream"
        range_header = self.headers.get("Range")

        if range_header:
            match = re.match(r"bytes=(\d+)-(\d*)", range_header)
            if match:
                start = int(match.group(1))
                end = int(match.group(2)) if match.group(2) else file_size - 1
                end = min(end, file_size - 1)
                length = end - start + 1

                self.send_response(206)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", str(length))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()

                with open(filepath, "rb") as fh:
                    fh.seek(start)
                    remaining = length
                    chunk_size = 1024 * 256
                    while remaining > 0:
                        chunk = fh.read(min(chunk_size, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
                return

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(file_size))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        with open(filepath, "rb") as fh:
            while True:
                chunk = fh.read(1024 * 256)
                if not chunk:
                    break
                self.wfile.write(chunk)

    def _serve_static(self, path):
        if path == "/":
            path = "/index.html"
        safe_path = os.path.normpath(path).lstrip("/")
        full_path = os.path.join(STATIC_DIR, safe_path)
        if not full_path.startswith(STATIC_DIR) or not os.path.isfile(full_path):
            self.send_error(404, "Not found")
            return
        content_type = mimetypes.guess_type(full_path)[0] or "application/octet-stream"
        with open(full_path, "rb") as fh:
            body = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        port = int(sys.argv[1])
    elif os.environ.get("PORT"):
        port = int(os.environ["PORT"])
    else:
        port = 8420
    refresh_index()
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"AQAI Music player serving on http://127.0.0.1:{port}")
    print(f"Library root: {LIBRARY_ROOT}")
    print(f"Tracks found: {len(_track_index)}")
    server.serve_forever()

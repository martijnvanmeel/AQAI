"""Renders a song into a social-ready video by headlessly recording the
actual player UI (static/export.html, which loads real index.html markup
+ app.js verbatim - see export.js) with Playwright/Chromium, so what gets
recorded is genuinely the live tool (3D creature/panorama scene, waveform,
karaoke, everything), not a re-implementation. The recording has no audio
(screen capture doesn't grab it), so the real track audio is muxed in
afterward with ffmpeg (a static binary from the imageio-ffmpeg package, no
system install needed).

This module does no I/O outside of what it's handed - the caller
(server.py) resolves paths/track data and passes them in.
"""

import hashlib
import os
import re
import subprocess
import time

import imageio_ffmpeg

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

ASPECTS = {
    "vertical": {"w": 1080, "h": 1920},
    "horizontal": {"w": 1920, "h": 1080},
    "square": {"w": 1200, "h": 1200},
    "portrait": {"w": 1080, "h": 1350},
}

# the real player's mobile-compact styling only kicks in at CSS widths
# <=480px (see styles.css's @media(max-width:480px)) - vertical/square/
# portrait all want that compact phone-style layout (not a desktop layout
# squeezed into a tall frame), so each uses a real narrow CSS viewport
# that triggers it, then device_scale_factor upscales to the exact target
# pixels. horizontal is the one aspect wide enough to just use its own
# real desktop layout directly, at 1:1 scale.
CSS_VIEWPORTS = {
    "vertical": {"css_w": 360, "css_h": 640, "scale": 3},    # 360*3=1080, 640*3=1920
    "square": {"css_w": 400, "css_h": 400, "scale": 3},      # 400*3=1200
    "portrait": {"css_w": 360, "css_h": 450, "scale": 3},    # 360*3=1080, 450*3=1350
    "horizontal": {"css_w": 1920, "css_h": 1080, "scale": 1},
}


def pick_background(track_id, panorama_dir):
    """Deterministic per-track pick from the same clip pool the live sphere
    scene draws from, so re-rendering a track reliably gives the same
    background instead of a different random one each time."""
    candidates = sorted(
        f for f in os.listdir(panorama_dir)
        if f.lower().endswith(".mp4") and f.lower() != "gradient.mp4"
    ) if os.path.isdir(panorama_dir) else []
    if not candidates:
        return None
    h = int(hashlib.sha1(track_id.encode("utf-8")).hexdigest(), 16)
    return os.path.join(panorama_dir, candidates[h % len(candidates)])


def _probe_duration(path):
    r = subprocess.run([FFMPEG, "-i", path], capture_output=True, text=True)
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.\d+)", r.stderr)
    if not m:
        return None
    hh, mm, ss = m.groups()
    return int(hh) * 3600 + int(mm) * 60 + float(ss)


def render(track, karaoke_data, aspect, out_path, panorama_dir, static_dir,
           server_port, duration_hint=None, extra_ffmpeg_args=None, progress_cb=None):
    from playwright.sync_api import sync_playwright

    w, h = ASPECTS[aspect]["w"], ASPECTS[aspect]["h"]
    duration = duration_hint or track.get("duration") or _probe_duration(track["_path"]) or 0

    # every aspect records static/export.html - a separate file from
    # index.html, so it can never be affected by (or affect) the real
    # index.html a visitor sees, but it loads the SAME app.js verbatim
    # (see export.js), so the 3D creature/panorama scene and everything
    # else is genuinely the live tool. See CSS_VIEWPORTS above for why
    # each aspect uses the CSS viewport it does.
    # record=1 tells export.js this is the real recording, not a browser-
    # tab preview - it still applies whatever's been saved for this aspect,
    # but never creates the manual X/Y/scale control panel/sliders, which
    # must never show up in the actual output video
    url = f"http://127.0.0.1:{server_port}/export.html?id={track['id']}&aspect={aspect}&record=1"
    vp = CSS_VIEWPORTS[aspect]
    css_w, css_h, scale = vp["css_w"], vp["css_h"], vp["scale"]

    import tempfile
    with tempfile.TemporaryDirectory(prefix="aqai_video_") as tmp:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                args=["--autoplay-policy=no-user-gesture-required"],
            )
            context = browser.new_context(
                viewport={"width": css_w, "height": css_h},
                device_scale_factor=scale,
                record_video_dir=tmp,
                record_video_size={"width": w, "height": h},
            )
            page = context.new_page()
            page.goto(url, wait_until="load")

            # wait for export.js to confirm playback actually started
            deadline = time.time() + 20
            while time.time() < deadline:
                title = page.title()
                if title.startswith("AQAI_EXPORT_PLAYING") or title.startswith("AQAI_EXPORT_DONE"):
                    break
                if title.startswith("AQAI_EXPORT_ERROR"):
                    raise RuntimeError(f"export page failed to load track: {title}")
                time.sleep(0.2)
            else:
                raise RuntimeError("export page never started playback (timed out)")

            # poll actual playback position for real progress, not just a
            # wall-clock guess - also the loop that waits for the song to
            # finish
            done_deadline = time.time() + duration + 30
            while time.time() < done_deadline:
                title = page.title()
                if title.startswith("AQAI_EXPORT_DONE"):
                    break
                if progress_cb and duration:
                    try:
                        cur_t = page.evaluate("document.getElementById('audio').currentTime")
                        progress_cb(min(0.98, (cur_t or 0) / duration))
                    except Exception:
                        pass
                time.sleep(0.5)

            context.close()
            video_path = page.video.path() if page.video else None
            browser.close()

        if not video_path or not os.path.isfile(video_path):
            # fall back to whatever landed in the temp dir
            candidates = [os.path.join(tmp, f) for f in os.listdir(tmp) if f.endswith(".webm")]
            video_path = candidates[0] if candidates else None
        if not video_path:
            raise RuntimeError("Playwright produced no recording")

        cmd = [
            FFMPEG, "-y",
            "-i", video_path,
            "-i", track["_path"],
            "-map", "0:v", "-map", "1:a",
            "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart",
            "-shortest",
        ]
        if extra_ffmpeg_args:
            cmd += extra_ffmpeg_args
        cmd.append(out_path)

        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg mux failed (code {proc.returncode}): {proc.stderr[-2000:]}")
        if progress_cb:
            progress_cb(1.0)
    return out_path

"""High-quality, frame-exact video export.

The realtime recorder in __init__.py captures a live browser: whatever frame rate the machine manages (2-7 fps without a GPU)
at the screencast's low bitrate. This renderer instead runs the real export page (static/export.html, the live player code) on
a VIRTUAL clock and photographs every single frame at full resolution:

  * Playwright's fake clock replaces Date / performance.now / setTimeout / requestAnimationFrame, and is stepped exactly
    1/fps second per frame - the page never runs "in real time", so a slow machine just takes longer, it never drops frames;
  * the music element is replaced (init script below) by a clock-driven stand-in, so the karaoke follows the virtual time;
  * the audio visualiser reads precomputed spectrum / waveform tables (made here from the real audio file with the same maths
    as the browser's AnalyserNode) instead of a live analyser;
  * CSS animations/transitions are paused and set to the virtual time every frame; background <video> clips are seeked to it;
  * every frame is captured as a lossless PNG and piped straight into ffmpeg (x264, high quality) together with the original
    audio, encoded at 320 kbps AAC.

Needs the player server running (it loads export.html from it) and Chrome with a GPU (Metal) - see GPU_ARGS.
"""

import base64
import json
import os
import subprocess
import sys
import time

import numpy as np

from . import ASPECTS, CSS_VIEWPORTS, FFMPEG, pick_background  # noqa: F401  (ASPECTS/CSS_VIEWPORTS: same geometry as the realtime path)

STALL_SECONDS = 240

GPU_ARGS = [
    "--autoplay-policy=no-user-gesture-required",
    "--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu-rasterization",
    "--disable-renderer-backgrounding", "--disable-background-timer-throttling",
]

# runs before any page script: stand-ins for the music element and the analysers, driven by the virtual clock
INIT_JS = r"""
(() => {
  // a fixed random sequence, so every render of a song is identical
  let seed = 0x9E3779B9;
  Math.random = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const R = window.__R = { playing: false, t0: 0, base: 0, go: false, waiter: null, freq: null, td: null, audioEl: null };
  const nowT = () => R.base + (performance.now() - R.t0) / 1000;
  const P = HTMLMediaElement.prototype;
  const dCur = Object.getOwnPropertyDescriptor(P, 'currentTime');
  Object.defineProperty(P, 'currentTime', {
    configurable: true,
    get(){ return this instanceof HTMLAudioElement ? (R.playing ? nowT() : R.base) : dCur.get.call(this); },
    set(v){ if (this instanceof HTMLAudioElement){ R.base = v; R.t0 = performance.now(); } else dCur.set.call(this, v); },
  });
  const dPaused = Object.getOwnPropertyDescriptor(P, 'paused');
  Object.defineProperty(P, 'paused', { configurable: true, get(){ return this instanceof HTMLAudioElement ? !R.playing : dPaused.get.call(this); } });
  const origPlay = P.play, origPause = P.pause;
  P.play = function(){
    if (this instanceof HTMLAudioElement){
      R.audioEl = this;
      return new Promise(res => {
        R.waiter = () => { R.playing = true; R.base = 0; R.t0 = performance.now(); this.dispatchEvent(new Event('playing')); res(); };
        if (R.go) R.waiter();
      });
    }
    return origPlay.call(this);
  };
  P.pause = function(){ if (this instanceof HTMLAudioElement){ R.base = R.playing ? nowT() : R.base; R.playing = false; return; } return origPause.call(this); };
  if (window.AnalyserNode){
    AnalyserNode.prototype.getByteFrequencyData = function(a){ if (R.freq) a.set(R.freq.subarray(0, a.length)); };
    AnalyserNode.prototype.getByteTimeDomainData = function(a){ if (R.td) a.set(R.td.subarray(0, a.length)); else a.fill(128); };
  }
})();
"""


def _decode_mono(path, sr):
    p = subprocess.run([FFMPEG, "-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(sr), "-"],
                       capture_output=True)
    if p.returncode != 0:
        raise RuntimeError("could not decode audio: " + p.stderr.decode("utf-8", "replace")[-400:])
    return np.frombuffer(p.stdout, dtype=np.float32)


def saved_frame(aspect, static_dir):
    """The frame size ({"w","h"} in CSS px) the saved default slider values of this aspect were tuned in."""
    try:
        txt = open(os.path.join(static_dir, "export_defaults.js"), encoding="utf-8").read()
        i = txt.index("window.EXPORT_DEFAULTS = ") + len("window.EXPORT_DEFAULTS = ")
        data = json.loads(txt[i:].rstrip().rstrip(";"))
        fr = (data.get(aspect) or {}).get("frame")
        if fr and fr.get("w") and fr.get("h"):
            return {"w": float(fr["w"]), "h": float(fr["h"])}
    except Exception:
        pass
    return None


class AnalyserTables:
    """What the browser's AnalyserNodes would show at each video frame, computed from the audio file.
    Frequency: fftSize 512, Blackman window, smoothingTimeConstant 0.82, dB -100..-30 mapped to bytes (the page's `analyser`).
    Waveform: the last 2048 samples as bytes (the page's `waveAnalyser`)."""

    SR = 48000

    def __init__(self, audio_path, fps):
        self.fps = fps
        self.x = _decode_mono(audio_path, self.SR)
        n = 512
        k = np.arange(n)
        a = 0.16
        self.win = (0.5 * (1 - a) - 0.5 * np.cos(2 * np.pi * k / n) + 0.5 * a * np.cos(4 * np.pi * k / n)).astype(np.float64)
        self.prev = np.zeros(n // 2)
        self.tau = 0.82
        self.last_i = -1

    def _block(self, end, size):
        s = max(0, end - size)
        b = self.x[s:end]
        if len(b) < size:
            b = np.concatenate([np.zeros(size - len(b), dtype=np.float32), b])
        return b

    def frame(self, i):
        """(freq bytes[256], timedomain bytes[2048]) for video frame i. Frames must be asked for in order (smoothing is stateful)."""
        end = int(round(i / self.fps * self.SR))
        blk = self._block(end, 512).astype(np.float64) * self.win
        mag = np.abs(np.fft.rfft(blk))[:256] / 512.0
        self.prev = self.tau * self.prev + (1 - self.tau) * mag
        db = 20 * np.log10(np.maximum(self.prev, 1e-12))
        f = np.clip(np.floor(255.0 / 70.0 * (db + 100.0)), 0, 255).astype(np.uint8)
        t = np.clip(np.floor(128.0 * (1.0 + self._block(end, 2048))), 0, 255).astype(np.uint8)
        return f, t


SYNC_JS = r"""
async (d) => {
  const R = window.__R;
  const un = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  if (d.freq) R.freq = un(d.freq);
  if (d.td) R.td = un(d.td);
  // background <video> clips are paused and parked on the frame for the virtual time (they loop)
  const jobs = [];
  for (const v of document.querySelectorAll('video')){
    if (!v.duration || !isFinite(v.duration) || v.readyState < 1) continue;
    if (!v.paused) v.pause();
    const want = ((d.t % v.duration) + v.duration) % v.duration;
    if (Math.abs(v.currentTime - want) > 0.0005){
      jobs.push(new Promise(res => { const done = () => { v.removeEventListener('seeked', done); res(); }; v.addEventListener('seeked', done); v.currentTime = want; setTimeout(res, 2000); }));
    }
  }
  await Promise.all(jobs);
}
"""

ANIM_JS = r"""
() => {
  const vt = performance.now();
  for (const a of document.getAnimations()){
    if (a.__t0 === undefined){ a.__t0 = vt - (a.currentTime || 0); try { a.pause(); } catch (e) {} }
    try { a.currentTime = vt - a.__t0; } catch (e) {}
  }
}
"""


def render(track, aspect, out_path, static_dir, server_port, fps=60, seconds=None, start_at=0.0,
           crf=14, preset="slow", progress_cb=None, log=print, shot_format="png", scene=None, maxrate=None, bufsize=None, jpeg_quality=95):
    """Render `track` (a server track dict with 'id' and '_path') in the given aspect to out_path (mp4).
    seconds: only render that many seconds of the song (testing); start_at: first second to render."""
    from playwright.sync_api import sync_playwright

    w, h = ASPECTS[aspect]["w"], ASPECTS[aspect]["h"]
    # WYSIWYG: the page is laid out in the same CSS frame the slider values were tuned in (the "frame" stored with the saved
    # defaults, e.g. 558x992 for 9:16), in a wide window like the preview (so the desktop styling applies exactly as in the
    # preview), and the device pixel ratio is whatever makes that frame come out at the target pixels (1080x1920 ...) -
    # text and the 3D scene are rendered natively at that size, not scaled up afterwards
    fr = saved_frame(aspect, static_dir) or {"w": 992.0 * w / h, "h": 992.0}
    frame_w, frame_h = fr["w"], fr["h"]
    vp = {"css_w": max(1300, int(round(frame_w))), "css_h": int(round(frame_h)), "scale": w / frame_w}
    audio_path = track["_path"]
    tables = AnalyserTables(audio_path, fps)
    total = len(tables.x) / AnalyserTables.SR
    seconds = min(seconds or total, total - start_at)
    n_frames = int(round(seconds * fps))
    step_ms = 1000.0 / fps
    url = f"http://127.0.0.1:{server_port}/export.html?id={track['id']}&aspect={aspect}&record=1"
    if scene:
        url += f"&scene={scene}"

    cmd = [
        FFMPEG, "-y", "-v", "error",
        "-f", "image2pipe", "-framerate", str(fps), "-c:v", "png" if shot_format == "png" else "mjpeg", "-i", "pipe:0",
        "-ss", f"{start_at:.3f}", "-t", f"{seconds:.3f}", "-i", audio_path,
        "-map", "0:v", "-map", "1:a",
        "-vf", f"scale={w}:{h}:flags=lanczos:in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p",
        "-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-profile:v", "high", "-level", "5.2",
        *(["-maxrate", maxrate, "-bufsize", bufsize or maxrate] if maxrate else []),
        "-r", str(fps), "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
        "-c:a", "aac", "-b:a", "320k", "-ar", "48000",
        "-movflags", "+faststart", "-shortest",
        out_path,
    ]
    ff = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    t_begin = time.time()
    # watchdog: if the browser dies or hangs (it happens now and then with several GPU renders at once) nothing raises - the
    # process would just sit there. No new frame for STALL_SECONDS -> kill everything and exit non-zero so the caller can retry.
    import threading
    last_progress = [time.time()]

    def _watchdog():
        while True:
            time.sleep(10)
            if time.time() - last_progress[0] > STALL_SECONDS:
                log(f"[{aspect}] STALLED: no new frame for {STALL_SECONDS}s - aborting")
                try:
                    ff.kill()
                except Exception:
                    pass
                os._exit(4)
    threading.Thread(target=_watchdog, daemon=True).start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="chrome", args=GPU_ARGS)
            context = browser.new_context(viewport={"width": vp["css_w"], "height": vp["css_h"]}, device_scale_factor=vp["scale"])
            context.add_init_script(INIT_JS)
            page = context.new_page()
            cdp = context.new_cdp_session(page)
            # a capture through our own session only sees the right layout if it carries the same device metrics itself
            cdp.send("Emulation.setDeviceMetricsOverride", {"width": vp["css_w"], "height": vp["css_h"], "deviceScaleFactor": vp["scale"], "mobile": False})
            page.clock.install(time=0)
            page.goto(url, wait_until="load", timeout=240000)
            # let everything load while the fake clock runs on its own (3D model, panorama video, fonts, the track)
            page.wait_for_timeout(9000)
            page.evaluate("() => { window.__R.go = false; }")
            # take control: freeze the clock, restart the track from 0 (reset the sweeps / karaoke), then step
            page.clock.pause_at(int(page.evaluate("Date.now()")) + 5)
            page.evaluate("""() => {
                const R = window.__R; R.go = true;
                if (typeof load === 'function' && typeof cur !== 'undefined') load(cur, true);   // play() inside starts the virtual music at 0
            }""")
            page.clock.run_for(50)
            clock_ms = 0
            log('viewport in page:', page.evaluate('[innerWidth, innerHeight, devicePixelRatio, document.querySelector("#app").getBoundingClientRect().width]'))
            prof = [0.0, 0.0, 0.0, 0.0]
            ar = page.evaluate('(() => { const r = document.querySelector("#app").getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()')
            clip = {"x": ar[0], "y": ar[1], "width": ar[2], "height": ar[3], "scale": 1}
            log("frame region (css px):", ar, "device pixel ratio:", round(vp["scale"], 4), "-> output", w, "x", h)
            for i in range(n_frames):
                t = start_at + i / fps
                if start_at and i == 0:
                    page.evaluate("(t) => { const R = window.__R; R.base = t; R.t0 = performance.now(); }", t)
                tm0 = time.time()
                f, td = tables.frame(int(round(t * fps)))
                page.evaluate(SYNC_JS, {"freq": base64.b64encode(f.tobytes()).decode(), "td": base64.b64encode(td.tobytes()).decode(), "t": t})
                tm1 = time.time()
                # the clock takes whole milliseconds: advance to the rounded virtual time of this frame (no drift over the song)
                target_ms = int(round((i + 1) * 1000.0 / fps))
                page.clock.run_for(target_ms - clock_ms)
                clock_ms = target_ms
                tm2 = time.time()
                page.evaluate(ANIM_JS)
                tm3 = time.time()
                # Chrome's own capture call, lossless PNG, optimised for speed (about 3x faster than page.screenshot())
                if shot_format == "png":
                    shot_args = {"format": "png", "optimizeForSpeed": True, "clip": clip}
                else:
                    shot_args = {"format": "jpeg", "quality": jpeg_quality, "optimizeForSpeed": True, "clip": clip}
                png = base64.b64decode(cdp.send("Page.captureScreenshot", shot_args)["data"])
                tm4 = time.time()
                prof[0] += tm1 - tm0; prof[1] += tm2 - tm1; prof[2] += tm3 - tm2; prof[3] += tm4 - tm3
                ff.stdin.write(png)
                last_progress[0] = time.time()
                if progress_cb and i % 30 == 0:
                    progress_cb(i / n_frames)
                if i % 120 == 0:
                    el = time.time() - t_begin
                    log(f"[{aspect}] frame {i}/{n_frames}  ({i / max(el, 1e-6):.2f} fps, {el:.0f}s elapsed)  per-frame ms: sync {prof[0]/(i+1)*1000:.0f} step {prof[1]/(i+1)*1000:.0f} anim {prof[2]/(i+1)*1000:.0f} shot {prof[3]/(i+1)*1000:.0f}")
            browser.close()
    finally:
        try:
            ff.stdin.close()
        except Exception:
            pass
        ff.wait()
    if ff.returncode != 0:
        raise RuntimeError(f"ffmpeg failed ({ff.returncode})")
    return out_path


if __name__ == "__main__":
    import argparse
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    ap = argparse.ArgumentParser(description="frame-exact high quality export of one track in one aspect")
    ap.add_argument("track_id")
    ap.add_argument("aspect", choices=sorted(ASPECTS))
    ap.add_argument("out")
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--crf", type=int, default=13)
    ap.add_argument("--preset", default="slow")
    ap.add_argument("--seconds", type=float, default=None, help="only the first N seconds (testing)")
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--port", type=int, default=8420)
    ap.add_argument("--scene", default=None)
    ap.add_argument("--shot", default="png", choices=["png", "jpeg"])
    ap.add_argument("--maxrate", default=None)
    a = ap.parse_args()
    import server
    trk = next(x for x in server.scan_library() if x["id"] == a.track_id)
    render(trk, a.aspect, a.out, server.STATIC_DIR, a.port, fps=a.fps, seconds=a.seconds, start_at=a.start,
           crf=a.crf, preset=a.preset, scene=a.scene, shot_format=a.shot, maxrate=a.maxrate,
           log=lambda *m: print(*m, flush=True))
    print("DONE", a.out, flush=True)

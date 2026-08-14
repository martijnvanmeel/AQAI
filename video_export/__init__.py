"""Renders a song into a social-ready video: the same panorama background,
karaoke-style word-by-word lyrics, a horizontal audio-reactive waveform, the
artist's photo, the track/artist name, and the AQAI logo - baked into an
actual .mp4 via ffmpeg (a static binary from the imageio-ffmpeg package, no
system install needed).

This module does no I/O outside of what it's handed - the caller (server.py)
resolves paths/track data and passes them in, so this stays independent of
the rest of the app and easy to test on its own.
"""

import hashlib
import math
import os
import re
import subprocess
import tempfile

import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFont

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
HERE = os.path.dirname(os.path.abspath(__file__))
FONTS_DIR = os.path.join(HERE, "fonts")

ASPECTS = {
    "vertical": {"w": 1080, "h": 1920},
    "horizontal": {"w": 1920, "h": 1080},
}


def _font(name, size):
    return ImageFont.truetype(os.path.join(FONTS_DIR, name), size)


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


def _hex_to_rgb(hexcolor):
    hexcolor = (hexcolor or "#7CFF9E").lstrip("#")
    if len(hexcolor) != 6:
        hexcolor = "7CFF9E"
    return tuple(int(hexcolor[i:i + 2], 16) for i in (0, 2, 4))


def _rgb_to_ass_bgr(rgb):
    r, g, b = rgb
    return f"&H{b:02X}{g:02X}{r:02X}&"


def _fit_text(draw, text, font_path, max_size, min_size, max_width):
    size = max_size
    while size > min_size:
        font = _font(font_path, size)
        w = draw.textlength(text, font=font)
        if w <= max_width:
            return font
        size -= 2
    return _font(font_path, min_size)


def build_chrome_image(track, aspect, out_path, static_dir):
    """Everything that isn't the moving background or the burned-in
    lyrics: artist photo, title/artist name, the AQAI logo, and a soft
    bottom-up dark gradient so text stays legible over any background."""
    w, h = ASPECTS[aspect]["w"], ASPECTS[aspect]["h"]
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))

    # gradient darkens roughly the bottom half, matching the live app's
    # own dim-overlay/vignette treatment behind the meta bar
    grad_top = int(h * 0.42)
    for y in range(grad_top, h):
        t = (y - grad_top) / max(1, (h - grad_top))
        alpha = int(190 * (t ** 1.4))
        ImageDraw.Draw(img).line([(0, y), (w, y)], fill=(0, 0, 0, alpha))

    accent = _hex_to_rgb(track.get("artistColor"))
    is_vertical = aspect == "vertical"
    photo_cy = int(h * (0.72 if is_vertical else 0.66))
    photo_cx = w // 2

    # the live player never crops the photo to a circle - it clips through
    # profilepic.png's own silhouette (a wide oval, not a perfect ellipse),
    # via a CSS mask; same mask asset is reused here as the actual alpha
    # channel so the video matches it exactly instead of approximating
    # with a plain circle
    mask_asset_path = os.path.join(static_dir, "assets", "profilepic.png")
    photo_path = None
    if track.get("artistPhoto"):
        cand = os.path.join(static_dir, track["artistPhoto"])
        if os.path.isfile(cand):
            photo_path = cand
    if not photo_path and os.path.isfile(mask_asset_path):
        photo_path = mask_asset_path

    photo_h = int(h * (0.135 if is_vertical else 0.16))
    if photo_path and os.path.isfile(mask_asset_path):
        mask_src = Image.open(mask_asset_path).convert("RGBA")
        oval_aspect = mask_src.width / mask_src.height
        photo_w = int(photo_h * oval_aspect)

        content = Image.open(photo_path).convert("RGBA").resize((photo_w, photo_h), Image.LANCZOS)
        mask_alpha = mask_src.resize((photo_w, photo_h), Image.LANCZOS).split()[-1]

        rim_pad = max(4, photo_h // 22)
        rim_w, rim_h = photo_w + rim_pad * 2, photo_h + rim_pad * 2
        rim_alpha = mask_src.resize((rim_w, rim_h), Image.LANCZOS).split()[-1]
        rim = Image.new("RGBA", (rim_w, rim_h), accent + (255,))
        rim.putalpha(rim_alpha)
        img.alpha_composite(rim, (photo_cx - rim_w // 2, photo_cy - rim_h // 2))

        photo_masked = Image.new("RGBA", (photo_w, photo_h), (0, 0, 0, 0))
        photo_masked.paste(content, (0, 0))
        photo_masked.putalpha(mask_alpha)
        img.alpha_composite(photo_masked, (photo_cx - photo_w // 2, photo_cy - photo_h // 2))
    else:
        photo_w = photo_h

    draw = ImageDraw.Draw(img)
    title = (track.get("title") or "").upper()
    artist = track.get("artist") or ""
    title_size = int(h * (0.032 if is_vertical else 0.05))
    sub_size = int(h * (0.018 if is_vertical else 0.026))
    max_text_w = w * 0.82

    title_font = _fit_text(draw, title, "Brice-Bold-Condensed.ttf", title_size, int(title_size * 0.5), max_text_w)
    title_y = photo_cy + photo_h // 2 + int(h * 0.035)
    tw = draw.textlength(title, font=title_font)
    draw.text((photo_cx - tw / 2, title_y), title, font=title_font, fill=(255, 255, 255, 255))

    sub_font = _font("Brice-Regular.ttf", sub_size)
    sub_text = f"BY {artist.upper()}"
    sw = draw.textlength(sub_text, font=sub_font)
    sub_y = title_y + title_font.size + int(h * 0.012)
    draw.text((photo_cx - sw / 2, sub_y), sub_text, font=sub_font, fill=accent + (255,))

    logo_path = os.path.join(static_dir, "assets", "logo-aqai.png")
    if not os.path.isfile(logo_path):
        logo_path = os.path.join(static_dir, "assets", "logo.png")
    if os.path.isfile(logo_path):
        logo = Image.open(logo_path).convert("RGBA")
        logo_w = int(w * (0.16 if is_vertical else 0.09))
        logo_h = int(logo.height * (logo_w / logo.width))
        logo = logo.resize((logo_w, logo_h), Image.LANCZOS)
        alpha = logo.split()[3].point(lambda a: int(a * 0.82))
        logo.putalpha(alpha)
        margin = int(h * 0.03)
        img.alpha_composite(logo, (w - logo_w - margin, margin))

    img.save(out_path)
    return {"photo_w": photo_w, "photo_h": photo_h, "photo_cy": photo_cy, "grad_top": grad_top}


ASS_HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Lyric,Brice,{fontsize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,{outline},{shadow},8,{marginlr},{marginlr},{marginv},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def _ass_time(t):
    t = max(0, t)
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _ass_escape(text):
    return text.replace("\\", "").replace("{", "(").replace("}", ")")


def build_ass_subtitles(karaoke_data, aspect, out_path, accent_rgb):
    """One line on screen at a time (matches the live app - a sentence
    never shows before the song actually reaches it), each word turning
    from the artist's accent color to white the instant it's sung."""
    w, h = ASPECTS[aspect]["w"], ASPECTS[aspect]["h"]
    is_vertical = aspect == "vertical"
    fontsize = int(h * (0.042 if is_vertical else 0.052))
    sung = "&H00FFFFFF&"
    unsung = _rgb_to_ass_bgr(accent_rgb).replace("&H", "&H00")

    lines_out = []
    for line in (karaoke_data or {}).get("lines", []):
        words = line.get("words") or []
        if not words:
            continue
        for i in range(len(words)):
            start = words[i]["s"]
            end = words[i + 1]["s"] if i + 1 < len(words) else words[i]["e"] + 0.6
            if end <= start:
                continue
            parts = []
            for j, wd in enumerate(words):
                color = sung if j <= i else unsung
                parts.append("{\\c%s}%s" % (color, _ass_escape(wd["w"])))
            text = " ".join(parts)
            lines_out.append(
                f"Dialogue: 0,{_ass_time(start)},{_ass_time(end)},Lyric,,0,0,0,,{text}"
            )

    margin_v = int(h * (0.30 if is_vertical else 0.30))
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(ASS_HEADER.format(
            w=w, h=h, fontsize=fontsize,
            outline=max(2, fontsize // 16), shadow=1,
            marginlr=int(w * 0.06), marginv=margin_v,
        ))
        fh.write("\n".join(lines_out))


def render(track, karaoke_data, aspect, out_path, panorama_dir, static_dir,
           duration_hint=None, extra_ffmpeg_args=None, progress_cb=None):
    w, h = ASPECTS[aspect]["w"], ASPECTS[aspect]["h"]
    bg_path = pick_background(track["id"], panorama_dir)
    if not bg_path:
        raise RuntimeError("No panorama background videos available")

    duration = duration_hint or track.get("duration") or _probe_duration(track["_path"]) or 0

    with tempfile.TemporaryDirectory(prefix="aqai_video_") as tmp:
        chrome_path = os.path.join(tmp, "chrome.png")
        chrome_info = build_chrome_image(track, aspect, chrome_path, static_dir)

        ass_path = os.path.join(tmp, "lyrics.ass")
        accent_rgb = _hex_to_rgb(track.get("artistColor"))
        build_ass_subtitles(karaoke_data, aspect, ass_path, accent_rgb)
        ass_escaped = ass_path.replace("\\", "/").replace(":", "\\:")
        fonts_escaped = FONTS_DIR.replace("\\", "/").replace(":", "\\:")

        # same rectified-baseline look as the live player's own waveform
        # (see drawWaveCanvas in app.js): a single line that only ever
        # bows upward from a resting line, never a symmetric mirrored
        # trace - taking the absolute value of the audio before showwaves
        # is what produces that one-directional shape. Vertically centred
        # on the artist photo, same as it runs behind the photo live.
        vis_h = int(h * 0.16)
        vis_y = chrome_info["photo_cy"] - vis_h // 2
        r, g, b = accent_rgb
        vis_color = f"{r:02x}{g:02x}{b:02x}"

        filter_complex = (
            f"[0:v]scale={w}:{h}:force_original_aspect_ratio=increase,"
            f"crop={w}:{h},eq=brightness=-0.06:saturation=1.05[bg];"
            f"[2:a]pan=mono|c0=0.5*c0+0.5*c1,aeval=exprs=abs(val(0)):channel_layout=mono,"
            f"aformat=channel_layouts=mono,"
            f"showwaves=s={w}x{vis_h}:mode=cline:colors={vis_color}:rate=25,"
            f"format=rgba,colorchannelmixer=aa=0.8[vis];"
            f"[bg][vis]overlay=x=0:y={vis_y}[bg1];"
            f"[bg1][1:v]overlay=x=0:y=0[bg2];"
            f"[bg2]ass=filename='{ass_escaped}':fontsdir='{fonts_escaped}'[outv]"
        )

        cmd = [
            FFMPEG, "-y",
            "-stream_loop", "-1", "-i", bg_path,
            "-loop", "1", "-i", chrome_path,
            "-i", track["_path"],
            "-filter_complex", filter_complex,
            "-map", "[outv]", "-map", "2:a",
            "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart",
            "-shortest",
        ]
        if extra_ffmpeg_args:
            cmd += extra_ffmpeg_args
        cmd.append(out_path)

        proc = subprocess.Popen(cmd, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, text=True)
        for line in proc.stderr:
            if progress_cb and duration:
                m = re.search(r"time=(\d+):(\d+):(\d+\.\d+)", line)
                if m:
                    hh, mm, ss = m.groups()
                    elapsed = int(hh) * 3600 + int(mm) * 60 + float(ss)
                    progress_cb(min(0.99, elapsed / duration))
        proc.wait()
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg failed (code {proc.returncode})")
        if progress_cb:
            progress_cb(1.0)
    return out_path

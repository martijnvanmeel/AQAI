/* Video export page - loads exactly one track (?id=) and drives the SAME
   wave-visualiser and karaoke-lyrics rendering code the live player uses
   (functions below are copied verbatim from app.js, not reimplemented, so
   the video genuinely looks and behaves like the app - see the "why
   duplicated instead of shared" note in video_export/README below).
   video_export/__init__.py records this page headlessly via Playwright,
   then muxes the real audio file back in afterward (screen recording
   can't capture audio on its own).
*/
const $ = s => document.querySelector(s);
const params = new URLSearchParams(location.search);
const TRACK_ID = params.get("id");
const ASPECT = params.get("aspect") === "horizontal" ? "horizontal" : "vertical";
document.body.classList.add(`aspect-${ASPECT}`);

let TRACKS = [];
let cur = 0;
let playing = false;

/* ---------------- wave visualiser (copied from app.js) ---------------- */
const WAVE_N = 25;
const waveCur = new Array(WAVE_N).fill(0);
let wavePhase = 0;
let waveAnalyser = null, waveData = null;
let WAVE_COLOR = "#7CFF9E";

function updateWaveSamples(){
  const isPlaying = !!(waveAnalyser && playing);
  const tgt = new Array(WAVE_N);
  if (isPlaying){
    waveAnalyser.getByteTimeDomainData(waveData);
    const L = waveData.length, step = L / WAVE_N;
    for (let i = 0; i < WAVE_N; i++){
      const a = Math.floor(i * step), b = Math.floor((i + 1) * step);
      let peak = 0;
      for (let j = a; j < b; j++){
        const d = (waveData[j] - 128) / 128;
        if (Math.abs(d) > Math.abs(peak)) peak = d;
      }
      tgt[i] = Math.max(-1, Math.min(1, peak * 2.6));
    }
  } else {
    for (let i = 0; i < WAVE_N; i++) tgt[i] = Math.sin(wavePhase + i * 0.55) * 0.16;
    wavePhase += 0.035;
  }
  const k = isPlaying ? 0.5 : 0.08;
  for (let i = 0; i < WAVE_N; i++) waveCur[i] += (tgt[i] - waveCur[i]) * k;
}
function waveCurveAt(arr, u){
  const n = arr.length;
  const at = k => arr[Math.max(0, Math.min(n - 1, k))];
  const xt = Math.max(0, Math.min(1, u)) * (n - 1);
  const i = Math.floor(xt), f = xt - i;
  const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
  const a0 = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
  const a1 = p0 - 2.5 * p1 + 2.0 * p2 - 0.5 * p3;
  const a2 = -0.5 * p0 + 0.5 * p2;
  const a3 = p1;
  return a0 * f * f * f + a1 * f * f + a2 * f + a3;
}
const WAVE_SEGMENTS = 320;
function mixWithWhite(hex, frac){
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const mix = c => Math.round(c + (255 - c) * frac);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}
function drawWaveCanvas(){
  const canvas = $("#wave-canvas");
  if (!canvas) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  const dctx = canvas.getContext("2d");
  dctx.clearRect(0, 0, canvas.width, canvas.height);
  dctx.save();
  const maskWidth = 108;
  dctx.beginPath();
  dctx.rect(0, 0, w, h);
  dctx.rect(w / 2 - maskWidth / 2, 0, maskWidth, h);
  dctx.clip("evenodd");
  const display = new Array(WAVE_N);
  for (let i = 0; i < WAVE_N; i++){
    const env = 0.1 + 0.9 * (1 - Math.abs(i / (WAVE_N - 1) - 0.5) * 2);
    display[i] = waveCur[i] * env;
  }
  const midY = h * 0.65, ampPx = h * 0.1764;
  dctx.strokeStyle = WAVE_COLOR;
  dctx.fillStyle = WAVE_COLOR;
  dctx.lineCap = "round";
  let prevX = 0, prevY = midY;
  for (let s = 0; s <= WAVE_SEGMENTS; s++){
    const u = s / WAVE_SEGMENTS;
    const val = waveCurveAt(display, u);
    const x = u * w, y = midY - Math.abs(val) * ampPx;
    if (s > 0){
      const intensity = Math.min(1, Math.abs(val) * 1.6);
      dctx.lineWidth = 1 + intensity * 6;
      dctx.globalAlpha = 1;
      dctx.strokeStyle = mixWithWhite(WAVE_COLOR, intensity * 0.6);
      dctx.beginPath();
      dctx.moveTo(prevX, prevY);
      dctx.lineTo(x, y);
      dctx.stroke();
    }
    prevX = x; prevY = y;
  }
  dctx.restore();
}

/* ---------------- karaoke lyric carousel (copied from app.js) ---------------- */
let lyricRowEls = {};
const LYRIC_ROW_GAP = 2;
const LYRIC_ROW_REACH = 2;
const DEPTH_SCALES = [0.755625, 0.3453125];
function rowBaseHeight(row){
  const fs = parseFloat(getComputedStyle(row).fontSize) || 0;
  return fs * 1.4 - 20;
}
function inactiveScaleForDepth(depth){ return DEPTH_SCALES[depth - 1]; }
const LYRIC_LINE_MAX_CHARS = 17;
const LYRIC_GAP_BLANK = 3;
function computeDisplayLines(tr, maxChars){
  if (tr._displayLines && tr._displayLinesMax === maxChars) return tr._displayLines;
  const raw = [];
  tr.lines.forEach(L => {
    let chunk = [];
    let len = 0;
    L.words.forEach(w => {
      const added = chunk.length ? len + 1 + w.w.length : w.w.length;
      if (chunk.length && added > maxChars){
        raw.push(chunk);
        chunk = [w];
        len = w.w.length;
      } else {
        chunk.push(w);
        len = added;
      }
    });
    if (chunk.length) raw.push(chunk);
  });
  const lines = [];
  raw.forEach(words => {
    const start = words[0].t;
    if (lines.length){
      const prev = lines[lines.length - 1];
      const prevLastWord = prev.words[prev.words.length - 1];
      const prevEnd = prevLastWord ? (prevLastWord.e ?? prevLastWord.t) : prev.t0;
      if (start - prevEnd > LYRIC_GAP_BLANK) lines.push({ words: [], t0: prevEnd });
    }
    lines.push({ words, t0: start });
  });
  lines.forEach((L, i) => {
    L.t1 = i < lines.length - 1
      ? lines[i + 1].t0
      : (L.words.length ? L.words[L.words.length - 1].t : L.t0) + 1.2;
  });
  tr._displayLines = lines;
  tr._displayLinesMax = maxChars;
  return lines;
}
const ACTIVE_LINE_SCALE = 1.3;
function prevRealIndex(dl, from){
  for (let i = from - 1; i >= 0; i--) if (dl[i].words.length) return i;
  return -1;
}
function nextRealIndex(dl, from){
  for (let i = from + 1; i < dl.length; i++) if (dl[i].words.length) return i;
  return -1;
}
function realNeighbors(dl, li, reach){
  const before = [];
  for (let idx = li; before.length < reach; ){
    idx = prevRealIndex(dl, idx);
    if (idx === -1) break;
    before.push(idx);
  }
  const after = [];
  for (let idx = li; after.length < reach; ){
    idx = nextRealIndex(dl, idx);
    if (idx === -1) break;
    after.push(idx);
  }
  return { before, after };
}
function layoutLyricRows(li, before, after){
  const activeRow = lyricRowEls[li];
  if (!activeRow) return;
  const activeScale = (activeRow._fitScale || 1) * ACTIVE_LINE_SCALE;
  activeRow.style.transform = `translate(-50%, -50%) scale(${activeScale})`;
  activeRow.classList.add("active-row");
  activeRow.classList.remove("near");
  [[1, after], [-1, before]].forEach(([dir, list]) => {
    let edge = rowBaseHeight(activeRow) * activeScale / 2;
    if (dir === -1) edge += 4;
    list.forEach((idx, i) => {
      const depth = i + 1;
      const row = lyricRowEls[idx];
      if (!row) return;
      const scale = (row._fitScale || 1) * inactiveScaleForDepth(depth);
      const h = rowBaseHeight(row) * scale;
      const y = edge + LYRIC_ROW_GAP + h / 2;
      const shift = -dir * (depth === 2 ? 20 : 15);
      row.style.transform = `translate(-50%, calc(-50% + ${dir * y + shift}px)) scale(${scale})`;
      row.classList.remove("active-row");
      row.classList.toggle("near", depth === 1);
      if (dir === -1){
        row.querySelectorAll(".w").forEach(w => {
          w.style.animation = "none";
          w.style.transform = "";
          w.style.color = "";
        });
      }
      edge = y + h / 2;
    });
  });
}
let dlActiveIdx = -1;
function renderLyricRows(li, dl){
  dlActiveIdx = li;
  const wrap = $("#lyric-rows");
  const { before } = realNeighbors(dl, li, LYRIC_ROW_REACH);
  const after = [];
  const keep = new Set([li, ...before, ...after]);
  Object.keys(lyricRowEls).forEach(k => {
    const idx = +k;
    if (!keep.has(idx)){ lyricRowEls[idx].remove(); delete lyricRowEls[idx]; }
  });
  keep.forEach(idx => {
    if (!lyricRowEls[idx]){
      const row = document.createElement("div");
      row.className = "lyric-row";
      row.innerHTML = dl[idx].words.map(w => `<span class="w">${w.w}</span>`).join("");
      wrap.appendChild(row);
      const avail = wrap.parentElement.clientWidth - 44;
      const maxNaturalWidth = avail / ACTIVE_LINE_SCALE;
      row._fitScale = row.scrollWidth > maxNaturalWidth ? maxNaturalWidth / row.scrollWidth : 1;
      lyricRowEls[idx] = row;
      row.style.transition = "none";
      row.style.transform = "translate(-50%, -50%) scale(0)";
      row.getBoundingClientRect();
      row.style.transition = "";
    }
    lyricRowEls[idx].style.opacity = "";
    lyricRowEls[idx].style.transition = "";
  });
  layoutLyricRows(li, before, after);
}
function fadeOutForGap(dl, dli){
  const row = lyricRowEls[dlActiveIdx];
  if (!row) return;
  const spans = row.querySelectorAll(".w");
  spans.forEach(w => {
    const cur = getComputedStyle(w).color;
    w.style.transition = "none";
    w.style.animation = "none";
    w.style.color = cur;
  });
  row.style.transition = "none";
  row.style.opacity = "1";
  row.getBoundingClientRect();
  row.style.transition = "opacity 2s linear";
  row.style.opacity = "0.5";
}
function startActiveLineFade(dl, li){
  const row = lyricRowEls[li];
  if (!row) return;
  const words = dl[li].words;
  if (!words.length) return;
  const start = words[0].t;
  const next = dl[li + 1];
  const end = next ? next.t0 : words[words.length - 1].t + 1.2;
  const spans = row.querySelectorAll(".w");
  for (let i = 0; i < spans.length; i++){
    spans[i].style.animation = "none";
    spans[i].style.color = "color-mix(in srgb, var(--artist-color, var(--active-green)) 74%, black)";
  }
  row.getBoundingClientRect();
  for (let i = 0; i < spans.length; i++){
    const wordStart = words[i].t - start;
    let wordEndAbs = i < words.length - 1 ? words[i + 1].t : end;
    if (i === words.length - 1 && words[i].e != null) wordEndAbs = Math.max(wordEndAbs, words[i].e);
    const wordEnd = wordEndAbs - start;
    const fadeDuration = Math.max(0.15, wordEnd - wordStart);
    spans[i].style.animation = `wordActiveWhite ${fadeDuration}s linear ${wordStart}s forwards`;
  }
}
const LYRIC_LEAD = 0.12;
let dlLineIdx = -1;
function updateLyrics(t){
  const tr = TRACKS[cur];
  if (!tr || !tr.lines || !tr.lines.length) return;
  const tt = t + LYRIC_LEAD;
  const dl = computeDisplayLines(tr, LYRIC_LINE_MAX_CHARS);
  const dli = dl.findIndex(L => tt >= L.t0 - .3 && tt < L.t1);
  if (dli === -1) return;
  if (dli !== dlLineIdx){
    dlLineIdx = dli;
    if (dl[dli].words.length){
      renderLyricRows(dli, dl);
      startActiveLineFade(dl, dli);
    } else {
      fadeOutForGap(dl, dli);
    }
  }
}

/* ---------------- export-specific boot/driver ---------------- */
// same +12% saturation/+2% lightness boost renderMeta() applies live
// (there via THREE.Color.offsetHSL) - reimplemented standalone here so
// this page doesn't need to pull in all of three.js just for one color nudge
function boostColor(hex){
  const n = parseInt((hex || "7CFF9E").replace("#", ""), 16);
  let r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min){ h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  s = Math.min(1, s + 0.12);
  l = Math.min(1, l + 0.02);
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r2, g2, b2;
  if (s === 0){ r2 = g2 = b2 = l; }
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r2 = hue2rgb(p, q, h + 1 / 3); g2 = hue2rgb(p, q, h); b2 = hue2rgb(p, q, h - 1 / 3);
  }
  const toHex = c => Math.round(c * 255).toString(16).padStart(2, "0");
  return `#${toHex(r2)}${toHex(g2)}${toHex(b2)}`;
}
function renderMeta(tr){
  $("#m-title").textContent = tr.title;
  $("#m-folder").textContent = tr.artist;
  const photo = $("#artist-photo");
  photo.addEventListener("load", positionWaveCanvas, { once: true });
  if (tr.artistPhoto){
    photo.src = tr.artistPhoto;
    photo.classList.add("masked");
  } else {
    photo.src = "assets/profilepic.png";
    photo.classList.remove("masked");
  }
  const artistColor = boostColor(tr.artistColor);
  document.documentElement.style.setProperty("--artist-color", artistColor);
  WAVE_COLOR = artistColor;
}

// aligns the wave canvas's own vertical center with the artist photo's -
// computed from actual layout (like positionBgGradient() does live)
// rather than guessed at in CSS, since the photo's real height depends on
// the loaded image's aspect ratio
function positionWaveCanvas(){
  const canvas = $("#wave-canvas");
  const photoWrap = $(".artist-photo-wrap");
  if (!canvas || !photoWrap) return;
  const rect = photoWrap.getBoundingClientRect();
  const photoCenterY = rect.top + rect.height / 2;
  const canvasH = canvas.clientHeight || parseFloat(getComputedStyle(canvas).height) || 0;
  canvas.style.top = (photoCenterY - canvasH / 2) + "px";
}

async function boot(){
  const tracksRes = await fetch("/api/tracks").then(r => r.json());
  const t = tracksRes.tracks.find(x => x.id === TRACK_ID);
  if (!t) { document.title = "AQAI_EXPORT_ERROR:track not found"; return; }

  const syncData = await fetch(`/api/sync/${TRACK_ID}`).then(r => r.json());
  const tr = {
    id: t.id, title: t.title, artist: t.artist, artistPhoto: t.artistPhoto,
    artistColor: t.artistColor, duration: t.duration,
    lines: (syncData.lines || []).filter(l => (l.words || []).length),
    _displayLines: null,
  };
  TRACKS = [tr];
  cur = 0;
  renderMeta(tr);
  positionWaveCanvas(); // safety net in case the photo loaded from cache (no 'load' event)

  const bgRes = await fetch(`/api/export-background/${TRACK_ID}`).then(r => r.json());
  if (bgRes.file) $("#bg-video").src = `/panorama2/${encodeURIComponent(bgRes.file)}`;

  const audio = $("#audio");
  audio.src = t.audioUrl;

  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  waveAnalyser = ctx.createAnalyser();
  waveAnalyser.fftSize = 2048;
  waveData = new Uint8Array(waveAnalyser.fftSize);
  const src = ctx.createMediaElementSource(audio);
  src.connect(waveAnalyser);
  src.connect(ctx.destination);

  function loop(){
    updateWaveSamples();
    drawWaveCanvas();
    updateLyrics(audio.currentTime);
    if (!audio.ended) requestAnimationFrame(loop);
  }

  audio.addEventListener("ended", () => { document.title = "AQAI_EXPORT_DONE"; });
  audio.addEventListener("canplaythrough", () => {
    if (playing) return;
    playing = true;
    audio.play().catch(() => {});
    requestAnimationFrame(loop);
    document.title = "AQAI_EXPORT_PLAYING";
  }, { once: true });
  audio.load();
}
boot();

/* ================================================================
   AQAI PLAYER — dynamic library edition
   TRACKS are loaded from /api/tracks (no hardcoded song list).
   Word-level lyric timing per track comes from /api/sync/<id>:
     manual tap-sync (Sync Studio) > Whisper-aligned auto timing
   Falls back to a client-side word-count estimate if neither exists.
   ================================================================ */

let TRACKS = [];
const $ = s => document.querySelector(s);
const fmt = s => `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}`;

/* ================================================================
   THEME ENGINE — each track deterministically picks a background /
   3D-object color pair from THEMES, so the palette changes per track
   and stays the same on replay. Text/controls default to white, but
   auto-flip to near-black when a theme's background is too light for
   white to read.
   ================================================================ */
const THEMES = window.AQAI_THEMES;

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luma([r, g, b]) { return (0.299 * r + 0.587 * g + 0.114 * b) / 255; }
function mixHex(hexA, hexB, t) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  const m = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${m[0]},${m[1]},${m[2]})`;
}
function rgba(hex, a) { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; }
function darkenHex(hex, amount) {
  const [r, g, b] = hexToRgb(hex);
  const f = 1 - amount;
  return `rgb(${Math.round(r * f)},${Math.round(g * f)},${Math.round(b * f)})`;
}

let currentThemeIndex = -1;
function themeIndexForTrack(track) {
  return hashString(track.id || track.title || "") % THEMES.length;
}

/* ---- background panorama: one looping clip per track, mapped onto the
   inside of a sphere so the mouse can look around it (see panoVideoEl /
   panoSphere further down, near the 3D visualizer setup) ---- */
let PANORAMAS = [];
// reserved for the intro screen only - excluded from the per-track pick
const INTRO_PANO_FILE = "From Klickpin.com- 68749462254-pin-id-68749462254.mp4";
// test source: Panoramas2 (mix of .mp4 clips and .gif animations), served
// via /api/panoramas2 + /panorama2/ instead of the original panoramas folder
fetch("/api/panoramas2").then(r => r.json()).then(data => {
  PANORAMAS = (data.files || []).filter(f => f !== INTRO_PANO_FILE);
}).catch(() => {});
// every song picks a genuinely random background (not tied to the track's
// own identity) - the plain sphere (no video swap this time) counts as
// one extra equally-weighted outcome alongside each individual clip, so
// there's a 1-in-(N+1) chance the background just stays as it was
function setBgVideoForTrack(track) {
  if (!PANORAMAS.length || typeof panoVideoEl === "undefined") return;
  const idx = Math.floor(Math.random() * (PANORAMAS.length + 1));
  if (idx < PANORAMAS.length) loadPanoFile(PANORAMAS[idx]);
}
function applyTheme(idx) {
  if (idx === currentThemeIndex) return;
  currentThemeIndex = idx;
  const [bg, object] = THEMES[idx];
  const fg = luma(hexToRgb(bg)) > 0.55 ? "#14171A" : "#FFFFFF";
  document.body.classList.toggle("theme-light", fg !== "#FFFFFF");
  const root = document.documentElement.style;
  root.setProperty("--bg", bg);
  root.setProperty("--bg-dark", darkenHex(bg, 0.2));
  root.setProperty("--bg-soft", mixHex(bg, fg, 0.12));
  root.setProperty("--object", object);
  root.setProperty("--fg", fg);
  root.setProperty("--fg-soft", rgba(fg === "#FFFFFF" ? "#FFFFFF" : "#14171A", 0.6));
  root.setProperty("--fg-faint", rgba(fg === "#FFFFFF" ? "#FFFFFF" : "#14171A", 0.32));
  root.setProperty("--line", rgba(fg === "#FFFFFF" ? "#FFFFFF" : "#14171A", 0.18));
  root.setProperty("--wash", rgba(fg === "#FFFFFF" ? "#FFFFFF" : "#14171A", 0.08));
  root.setProperty("--nav-bg", rgba(bg, 0.88));
}

/* ================================================================
   AUDIO ENGINE
   ================================================================ */
const AC = window.AudioContext || window.webkitAudioContext;
let ctx = null, analyser = null, waveAnalyser = null, master = null, freqData = null, waveData = null;
let cur = 0, playing = false;
let masterVolume = 1; // songs start at 100% volume
const audioEls = {};

function initAudio(){
  if (ctx) return;
  ctx = new AC();
  master = ctx.createGain(); master.gain.value = masterVolume;
  analyser = ctx.createAnalyser(); analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.82;
  // a second analyser tapped off the same signal, in time-domain mode -
  // feeds the 2D music-reactive line visualizer (see #wave-canvas)
  waveAnalyser = ctx.createAnalyser(); waveAnalyser.fftSize = 2048;
  // both analysers are fed directly per-source in getAudio() (BEFORE the
  // master gain node), not from master itself - otherwise the visualizers'
  // reactive range would shrink and grow with the playback volume slider
  // instead of tracking the track's own dynamics. master only ever feeds
  // the actual speaker output.
  master.connect(ctx.destination);
  freqData = new Uint8Array(analyser.frequencyBinCount);
  waveData = new Uint8Array(waveAnalyser.fftSize);
}

function getAudio(i){
  if (!audioEls[i]){
    const el = new Audio(TRACKS[i].url);
    // "auto" (not "metadata") so the browser buffers well ahead of the
    // playhead instead of the bare minimum - a thin buffer is what causes
    // the audible stutter/tempo-warble some browsers do to catch back up
    // after a brief network or server hiccup
    el.preload = "auto";
    el.crossOrigin = "anonymous";
    el.addEventListener("ended", () => { if (cur === i) next(); });
    el.addEventListener("loadedmetadata", () => {
      TRACKS[i].duration = el.duration;
      if (cur === i) renderMeta();
      renderList();
    });
    el.addEventListener("error", () => {
      if (cur === i) toast("Could not load audio file");
    });
    initAudio();
    const src = ctx.createMediaElementSource(el);
    src.connect(master); // audible playback, still fully volume-controlled
    src.connect(analyser); // pre-gain tap for the frequency-based visualizers
    src.connect(waveAnalyser); // pre-gain tap for the linear wave visualizer
    audioEls[i] = el;
  }
  return audioEls[i];
}

function elapsed(){ return audioEls[cur] ? audioEls[cur].currentTime : 0; }

function play(){
  initAudio();
  if (ctx.state === "suspended") ctx.resume();
  const el = getAudio(cur);
  el.play().then(() => { playing = true; syncButtons(); })
           .catch(() => toast("Tap play to start audio"));
}
function pause(){
  if (audioEls[cur]) audioEls[cur].pause();
  playing = false; syncButtons();
}
function seek(t){
  const el = getAudio(cur);
  el.currentTime = Math.max(0, Math.min(t, (TRACKS[cur].duration || 0) - 0.05));
  updateUI();
}
/* ---- track loading overlay: shown from the moment a track starts
   loading until its audio can play and its artist photo has finished
   loading - covers the very first song once the intro gate is dismissed,
   and every song switch after that. Nav and the top AQAI logo stay 100%
   visible; everything else dims under a 20%-black scrim. The logo shares
   a toolbar row with the pano/util buttons (which DO need to dim), and it
   lives in a nested stacking context that a single z-index overlay can't
   carve a hole in - so instead three scrim pieces are positioned
   geometrically around the logo's live bounding rect. Nav is simply left
   alone: it's already z-index:50, above this overlay's z-index, so it
   stays visible without any special-casing. */
const loaderMain = document.createElement("div");
loaderMain.id = "track-loader";
const loaderLeft = document.createElement("div");
loaderLeft.className = "track-loader-piece";
const loaderRight = document.createElement("div");
loaderRight.className = "track-loader-piece";
document.body.append(loaderMain, loaderLeft, loaderRight);
function positionLoaderPieces(){
  const logo = document.querySelector(".home-top .logo-text");
  const panoBtns = document.querySelector("#pano-btns");
  const utilBtns = document.querySelector(".util-btns");
  if (!logo || !panoBtns || !utilBtns) return;
  const logoRect = logo.getBoundingClientRect();
  const panoRect = panoBtns.getBoundingClientRect();
  const utilRect = utilBtns.getBoundingClientRect();
  // .home-top's own box collapses to zero height (every child - logo,
  // pano-btns, util-btns - is position:absolute, so flexbox auto-sizing
  // has nothing in-flow to measure) - derive the toolbar band directly
  // from the children's own rects instead
  const bandTop = Math.min(logoRect.top, panoRect.top, utilRect.top);
  const bandBottom = Math.max(logoRect.bottom, panoRect.bottom, utilRect.bottom);
  loaderMain.style.top = bandBottom + "px";
  loaderLeft.style.cssText = `top:${bandTop}px;height:${bandBottom - bandTop}px;left:0;width:${Math.max(0, logoRect.left)}px;right:auto;`;
  loaderRight.style.cssText = `top:${bandTop}px;height:${bandBottom - bandTop}px;left:${logoRect.right}px;right:0;width:auto;`;
}
function showLoader(){
  positionLoaderPieces();
  loaderMain.classList.add("show");
  loaderLeft.classList.add("show");
  loaderRight.classList.add("show");
}
function hideLoader(){
  loaderMain.classList.remove("show");
  loaderLeft.classList.remove("show");
  loaderRight.classList.remove("show");
}
addEventListener("resize", () => { if (loaderMain.classList.contains("show")) positionLoaderPieces(); });
function waitForTrackAssets(el, photo){
  showLoader();
  let audioReady = el.readyState >= 3; // HAVE_FUTURE_DATA - enough buffered to start playing
  let photoReady = photo.complete && photo.naturalWidth > 0;
  const checkDone = () => { if (audioReady && photoReady) hideLoader(); };
  if (!audioReady){
    el.addEventListener("canplay", function onCanPlay(){
      audioReady = true; el.removeEventListener("canplay", onCanPlay); checkDone();
    });
  }
  if (!photoReady){
    photo.addEventListener("load", function onLoad(){
      photoReady = true; photo.removeEventListener("load", onLoad); checkDone();
    });
    photo.addEventListener("error", function onErr(){
      photoReady = true; photo.removeEventListener("error", onErr); checkDone();
    });
  }
  checkDone();
}

function load(i, autoplay = true){
  if (audioEls[cur]) audioEls[cur].pause();
  playing = false;
  cur = (i + TRACKS.length) % TRACKS.length;
  const el = getAudio(cur);
  el.currentTime = 0; el.playbackRate = 1;
  renderMeta(); renderList();
  waitForTrackAssets(el, $("#artist-photo"));
  $("#lyric-rows").innerHTML = "";
  lyricRowEls = {};
  lineIdx = -1;
  ensureLyricsLoaded(cur);
  flBuiltForTrack = -1;
  if (fullLyricsOpen) buildFullLyrics();
  applyTheme(themeIndexForTrack(TRACKS[cur]));
  setBgVideoForTrack(TRACKS[cur]);
  updateArtistBackground(TRACKS[cur]);
  if (autoplay) play(); else syncButtons();
}
function next(){ load(cur + 1); }
function prev(){ if (elapsed() > 3) seek(0); else load(cur - 1); }
function random(){
  if (TRACKS.length < 2) return seek(0);
  let r; do { r = Math.floor(Math.random() * TRACKS.length); } while (r === cur);
  load(r);
}

/* ================================================================
   LYRICS — word-level timing, fetched per track, cached on TRACKS[i]
   ================================================================ */

function estimateWordTimings(lines, duration){
  const lineWordCounts = lines.map(l => l.split(/\s+/).filter(Boolean).length || 1);
  const totalWords = lineWordCounts.reduce((a,b) => a+b, 0) || 1;
  const introPad = Math.min(3, duration * 0.03);
  const outroPad = Math.min(3, duration * 0.03);
  const available = Math.max(0, duration - introPad - outroPad);
  let cum = 0;
  return lines.map((text, i) => {
    const words = text.split(/\s+/).filter(Boolean);
    const t0 = introPad + available * (cum / totalWords);
    cum += lineWordCounts[i];
    const t1 = introPad + available * (cum / totalWords);
    const span = Math.max(0.3, t1 - t0);
    const per = span / words.length;
    return { words: words.map((w, j) => ({ w, t: +(t0 + j*per).toFixed(2) })) };
  });
}

let lyricsFetchInFlight = {};
function ensureLyricsLoaded(i){
  const tr = TRACKS[i];
  if (!tr || tr._lyricsLoaded || lyricsFetchInFlight[i]) return;
  if (!tr.rawLyrics || !tr.rawLyrics.length){ tr._lyricsLoaded = true; return; }
  lyricsFetchInFlight[i] = true;
  fetch(`/api/sync/${tr.id}`).then(r => r.json()).then(data => {
    if (data.lines && data.lines.length && data.lines[0].words){
      tr.lines = data.lines;
    } else {
      tr.lines = estimateWordTimings(tr.rawLyrics, tr.duration || 180);
    }
    tr._lyricsLoaded = true;
    delete lyricsFetchInFlight[i];
    if (cur === i){
      lineIdx = -1;
      if (fullLyricsOpen) buildFullLyrics();
    }
  }).catch(() => {
    tr.lines = estimateWordTimings(tr.rawLyrics, tr.duration || 180);
    tr._lyricsLoaded = true;
    delete lyricsFetchInFlight[i];
    if (cur === i && fullLyricsOpen) buildFullLyrics();
  });
}

let lineIdx = -1;
const LYRIC_LEAD = 0.12;
const LYRIC_MIN_ON = 0.12;
const LYRIC_MAX_ON = 0.75;

function paintWordSpans(row, words, tt){
  const spans = row.children;
  for (let i = 0; i < words.length; i++){
    const start = words[i].t;
    const gap = i === words.length - 1 ? LYRIC_MIN_ON : words[i + 1].t - start;
    const end = start + Math.min(LYRIC_MAX_ON, Math.max(LYRIC_MIN_ON, gap));
    const on = tt >= start && tt < end;
    spans[i].classList.toggle("on", on);
    spans[i].classList.toggle("done", tt >= end);
  }
}

/* ---- Home lyric carousel: 2 previous + active + 2 next lines, 2px gaps,
   each line further from the active one rendered 15% smaller than the
   line before it ---- */
let lyricRowEls = {};
const LYRIC_ROW_GAP = 2;
const LYRIC_ROW_REACH = 2;
// depth 1 = the last-previous / first-next sentence, depth 2 = the one
// beyond that; depth 1 is bigger and less transparent (via the "near"
// class below) than depth 2
const DEPTH_SCALES = [0.755625, 0.3453125]; // depth 1 (immediate prev/next) bumped to 125% of its former 0.6045
function rowBaseHeight(row){
  const fs = parseFloat(getComputedStyle(row).fontSize) || 0;
  return fs * 1.4 - 20;
}
function inactiveScaleForDepth(depth){
  return DEPTH_SCALES[depth - 1];
}
const LYRIC_LINE_MAX_CHARS = 17;
const LYRIC_GAP_BLANK = 3; // silence longer than this gets its own blank sentence
// re-flows each original sentence's words into fresh display lines of
// <=28 characters (incl. spaces), never splitting a word - words that
// overflow a sentence spill onto its own next display line, but a new
// original sentence always starts a fresh display line of its own (never
// shares one with the sentence before it). Wherever the silence to the
// next sentence exceeds LYRIC_GAP_BLANK, an empty sentence is inserted so
// the carousel actually goes blank instead of holding the previous line.
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
      // real end time when we have one (karaoke.json-sourced tracks always
      // do) - using only the last word's START here used to let a silence
      // gap get "detected" while that word was still being sung, which cut
      // its own highlight animation short (see startActiveLineFade)
      const prevLastWord = prev.words[prev.words.length - 1];
      const prevEnd = prevLastWord ? (prevLastWord.e ?? prevLastWord.t) : prev.t0;
      if (start - prevEnd > LYRIC_GAP_BLANK) lines.push({ words: [], t0: prevEnd });
    }
    lines.push({ words, t0: start });
  });
  // each sentence's active window runs from its own start up to the next
  // sentence's start (contiguous, no overlap), so a blank one is reached
  // exactly during its silence instead of getting shadowed by a hold-over
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
// blank (silence) entries never get their own row - the carousel skips
// straight past them to the nearest real sentence on either side, so a
// gap never shows as an empty centered line or an empty preview row
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
    if (dir === -1) edge += 4; // 4px more distance between active and previous sentences
    list.forEach((idx, i) => {
      const depth = i + 1;
      const row = lyricRowEls[idx];
      if (!row) return;
      const scale = (row._fitScale || 1) * inactiveScaleForDepth(depth);
      const h = rowBaseHeight(row) * scale;
      const y = edge + LYRIC_ROW_GAP + h / 2;
      // pull each neighbour toward the active line: 15px for the first
      // sentence out, 20px for the second. Applied symmetrically so the two
      // previous sentences get the same spacing as the two upcoming ones
      // (upcoming sit below → pulled up; previous sit above → pulled down).
      const shift = -dir * (depth === 2 ? 20 : 15);
      row.style.transform = `translate(-50%, calc(-50% + ${dir * y + shift}px)) scale(${scale})`;
      row.classList.remove("active-row");
      row.classList.toggle("near", depth === 1);
      // "before" rows are past sentences that just moved up off center
      // stage (making room for the new active one) - their per-word color
      // fade animation is stopped right away; only the row-level depth
      // scale above should shrink a neighbor. Color is cleared so they
      // revert to the base unsung style, matching the "after" (upcoming)
      // rows exactly - same color and same opacity on both sides.
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
let dlActiveIdx = -1; // last display-line index actually rendered active (see fadeOutForGap)
function renderLyricRows(li, dl){
  dlActiveIdx = li;
  const wrap = $("#lyric-rows");
  // upcoming sentences are never shown ahead of time - a line only ever
  // appears once the song actually reaches it (only past ones stay
  // visible, scrolled up above the active line, for context)
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
      // fit against the ACTIVE size (its biggest use, x1.3), not the
      // natural size - otherwise a row that just barely fit unscaled
      // would still overflow the screen once promoted to active
      const avail = wrap.parentElement.clientWidth - 44;
      const maxNaturalWidth = avail / ACTIVE_LINE_SCALE;
      row._fitScale = row.scrollWidth > maxNaturalWidth ? maxNaturalWidth / row.scrollWidth : 1;
      lyricRowEls[idx] = row;
      row.style.transition = "none";
      row.style.transform = "translate(-50%, -50%) scale(0)";
      row.getBoundingClientRect();
      row.style.transition = "";
    }
    // clears any row-level transition left over from stale state; the
    // per-word color fade from a gap fade-out (see fadeOutForGap) is
    // cleared separately, by layoutLyricRows' "before" row handling below
    lyricRowEls[idx].style.opacity = "";
    lyricRowEls[idx].style.transition = "";
  });
  layoutLyricRows(li, before, after);
}
// during a silent gap between sentences, instead of swapping to an empty
// centered line, leave the just-finished sentence in place and fade its
// color down to a dark blue over the exact span of the silence - tracked
// via dlActiveIdx (the last index actually rendered active) rather than
// dli-1, since a near-zero-length real line right before the gap could
// otherwise get skipped between frames and never actually render
function fadeOutForGap(dl, dli){
  const row = lyricRowEls[dlActiveIdx];
  if (!row) return;
  // fades the whole sentence down to 50% opacity over a fixed 2s, instead
  // of tracking the gap's own (often much longer) duration and only
  // fading each word's color down to a dark blue
  // freeze every word at its CURRENT rendered color (whether that's
  // already-white, mid-fade, or still unsung) before stopping the
  // animation - otherwise stopping it snaps each word back to its
  // pre-animation inactive color first, which then fades in from the
  // wrong place instead of the already-sung words fading out from white
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
/* whole sentence starts blue and fades to white over the exact time it
   stays active, instead of highlighting word-by-word */
function startActiveLineFade(dl, li){
  const row = lyricRowEls[li];
  if (!row) return;
  const words = dl[li].words;
  if (!words.length) return; // blank sentence - nothing to fade
  const start = words[0].t;
  const next = dl[li + 1];
  const end = next ? next.t0 : words[words.length - 1].t + 1.2;
  const spans = row.querySelectorAll(".w");
  for (let i = 0; i < spans.length; i++){
    spans[i].style.animation = "none";
    // start on the artist color, darkened - 50% brighter than before (was
    // 49% artist mixed with black, now 74%)
    spans[i].style.color = "color-mix(in srgb, var(--artist-color, var(--active-green)) 74%, black)";
  }
  row.getBoundingClientRect();
  // each word fades blue -> green -> yellow -> white one by one, on its
  // own turn, so the last word finishes fading right as the next
  // sentence takes over (no scaling - color fade only)
  for (let i = 0; i < spans.length; i++){
    const wordStart = words[i].t - start;
    let wordEndAbs = i < words.length - 1 ? words[i + 1].t : end;
    // the last word's fallback boundary (the next sentence, or the gap
    // placeholder right after it) can land at/before this word's own
    // start once a silence gap follows - floor it at the word's real sung
    // end so it always gets to actually show as active
    if (i === words.length - 1 && words[i].e != null) wordEndAbs = Math.max(wordEndAbs, words[i].e);
    const wordEnd = wordEndAbs - start;
    const fadeDuration = Math.max(0.15, wordEnd - wordStart);
    spans[i].style.animation = `wordActiveWhite ${fadeDuration}s linear ${wordStart}s forwards`;
  }
}

/* ---- full lyrics overlay ---- */
let fullLyricsOpen = false;
let flRowEls = [];
let flBuiltForTrack = -1;
function buildFullLyrics(){
  const tr = TRACKS[cur];
  const list = $("#lf-list");
  list.innerHTML = "";
  flRowEls = [];
  flBuiltForTrack = cur;
  if (!tr) return;
  $("#lf-title").textContent = tr.title;
  $("#lf-folder").textContent = tr.artist;
  if (!tr.lines || !tr.lines.length) return;

  // the stored lines are Suno-style hard-wrapped fragments (a single
  // sentence can be split across rows, and one row can hold the tail of one
  // sentence plus the head of the next). Rebuild whole sentences by
  // streaming every word and starting a fresh sentence at each capitalised
  // word (that's where an original lyric line began) - except "I" and its
  // contractions (I'm/I've/I'll/I'd), which are always capitalised. Kept as
  // the full {w,t} objects (not just the text) so an edit can reuse the
  // original per-word timestamps - see beginEditLyricRow().
  const allWords = [];
  tr.lines.forEach(L => (L.words || []).forEach(w => allWords.push(w)));
  const sentences = [];
  allWords.forEach((w, i) => {
    const startsNewSentence = i > 0 && /^[A-Z]/.test(w.w) && !/^I(?:'|$)/.test(w.w);
    if (startsNewSentence || !sentences.length) sentences.push([]);
    sentences[sentences.length - 1].push(w);
  });
  sentences.forEach(words => {
    const row = document.createElement("div");
    row.className = "lf-row";
    row.innerHTML = words.map(w => `<span class="w">${w.w}</span>`).join("");
    row._words = words;
    row.addEventListener("click", () => beginEditLyricRow(row));
    list.appendChild(row);
    flRowEls.push(row);
  });

  resizeLyricsFullCard();
}
// the card is sized off the widest sentence instead of a fixed percentage,
// so every line renders in full on one line at its natural size - but never
// wider than the viewport minus a 10px margin on each side (#lyrics-full is
// centered via left:50%/translateX(-50%), so capping the width alone keeps
// that 10px gap symmetric). A sentence wider than that available space
// wraps onto extra lines within its own row instead (see .lf-row's
// white-space:normal) rather than overflowing past the screen edge.
// Re-run after an edit too, since the edited row's own width can change.
function resizeLyricsFullCard(){
  const overlay = $("#lyrics-full");
  let maxWidth = 0;
  flRowEls.forEach(row => { maxWidth = Math.max(maxWidth, row.scrollWidth); });
  const listPaddingX = 46; // #lf-list's own left+right padding (38 left + 8 right) - as tight as the 38px-left/close-button constraints allow
  const scrollbarW = 35.7; // custom scrollbar channel width (see #lf-list::-webkit-scrollbar)
  const viewportCap = window.innerWidth - 20; // 10px clear on each side, always
  overlay.style.width = Math.min(maxWidth + listPaddingX + scrollbarW, viewportCap) + "px";
}
/* click-to-edit a sentence (local-only, see EDITABLE/#lf-list.editable):
   swaps the row's word spans for a plain input pre-filled with its text;
   blur/Enter saves, Escape cancels back to the original. If the edited
   word count matches the original, every word keeps its own original
   timestamp (a typo fix stays perfectly in sync); otherwise the new words
   are spread evenly across the sentence's own original time span. */
let lyricRowEditCancelled = false;
let lyricRowSaveInFlight = false;
function beginEditLyricRow(row){
  if (!$("#lf-list").classList.contains("editable") || lyricRowSaveInFlight) return;
  if (row.querySelector("input")) return;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "lf-row-edit-input";
  input.value = row._words.map(w => w.w).join(" ");
  row.textContent = "";
  row.appendChild(input);
  input.focus();
  input.select();
  input.addEventListener("blur", () => commitEditLyricRow(row, input));
  input.addEventListener("keydown", e => {
    if (e.key === "Enter"){ e.preventDefault(); e.target.blur(); }
    else if (e.key === "Escape"){ lyricRowEditCancelled = true; e.target.blur(); }
  });
}
function renderLyricRowWords(row){
  row.innerHTML = row._words.map(w => `<span class="w">${w.w}</span>`).join("");
}
function commitEditLyricRow(row, input){
  const cancelled = lyricRowEditCancelled;
  lyricRowEditCancelled = false;
  const newText = input.value.trim();
  const originalText = row._words.map(w => w.w).join(" ");
  if (cancelled || !newText || newText === originalText){
    renderLyricRowWords(row);
    return;
  }
  const newWords = newText.split(/\s+/).filter(Boolean);
  const origWords = row._words;
  if (newWords.length === origWords.length){
    row._words = newWords.map((w, i) => ({ w, t: origWords[i].t }));
  } else {
    const rowIdx = flRowEls.indexOf(row);
    const nextRow = flRowEls[rowIdx + 1];
    const start = origWords[0].t;
    const end = nextRow ? nextRow._words[0].t : origWords[origWords.length - 1].t + 1.5;
    const per = Math.max(0.3, end - start) / newWords.length;
    row._words = newWords.map((w, i) => ({ w, t: +(start + i * per).toFixed(2) }));
  }
  renderLyricRowWords(row);
  resizeLyricsFullCard();
  saveEditedLyrics();
}
function saveEditedLyrics(){
  const tr = TRACKS[cur];
  if (!tr) return;
  const lines = flRowEls.map(row => ({ words: row._words }));
  tr.lines = lines;
  tr._displayLines = null; // force computeDisplayLines() to re-wrap from the edited words
  lyricRowSaveInFlight = true;
  fetch(`/api/sync/${tr.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lines }),
  }).then(() => toast("Lyrics saved"))
    .catch(() => toast("Could not save lyrics"))
    .finally(() => { lyricRowSaveInFlight = false; });
}
function updateFullLyrics(li, tt, tr){
  // the full-lyrics overlay shows plain text only - no active-line
  // highlight or per-word karaoke colouring here (the list still
  // scroll-follows the song, handled by the caller)
}
function positionBgGradient(){
  const photo = $("#artist-photo");
  const grad = $("#bg-gradient");
  if (!photo || !grad) return;
  const photoBottom = photo.getBoundingClientRect().bottom;
  grad.style.top = photoBottom + "px";
}
function positionLyricsFull(){
  const logo = document.querySelector(".home-top .logo-text");
  const player = document.querySelector(".player");
  const overlay = $("#lyrics-full");
  if (!logo || !player) return;
  // taller card: span from 15% of the viewport height down from the top
  // to 15% up from the bottom (was anchored between the logo and player)
  overlay.style.top = (window.innerHeight * 0.15) + "px";
  overlay.style.bottom = (window.innerHeight * 0.15) + "px";
  // close button stays pinned to the top-right corner via CSS (right/top:20px)
  // guarantee a 15px gap between the close button and the scrollbar/list
  // below it, whatever the title's rendered height ends up being
  const closeBtn = $("#lf-close");
  const list = $("#lf-list");
  if (closeBtn && list){
    list.style.marginTop = "0px";
    const gap = list.getBoundingClientRect().top - closeBtn.getBoundingClientRect().bottom;
    list.style.marginTop = Math.max(0, 15 - gap) + "px";
  }
}
function openFullLyrics(){
  fullLyricsOpen = true;
  // the card must already be visible (display:flex) before
  // buildFullLyrics() measures each line's natural width below
  $("#lyrics-full").classList.add("open");
  $("#lyrics-full-backdrop").classList.add("open");
  if (flBuiltForTrack !== cur) buildFullLyrics();
  $("#lyrics").style.visibility = "hidden";
  positionLyricsFull();
  // open at the top and leave it there - no jump to the current line
  $("#lf-list").scrollTop = 0;
}
function closeFullLyrics(){
  fullLyricsOpen = false;
  $("#lyrics-full").classList.remove("open");
  $("#lyrics-full-backdrop").classList.remove("open");
  $("#lyrics").style.visibility = "";
}
addEventListener("resize", () => { if (fullLyricsOpen){ resizeLyricsFullCard(); positionLyricsFull(); } positionBgGradient(); });
$("#btn-fulllyrics").onclick = () => fullLyricsOpen ? closeFullLyrics() : openFullLyrics();
$("#lf-close").onclick = closeFullLyrics;
// reveal the lyrics scrollbar only while the user is actively scrolling
// (it's also shown on hover via CSS); fades back out ~0.8s after they stop
(() => {
  const list = $("#lf-list");
  if (!list) return;
  let hideT = null;
  list.addEventListener("scroll", () => {
    list.classList.add("scrolling");
    clearTimeout(hideT);
    hideT = setTimeout(() => list.classList.remove("scrolling"), 800);
  });
})();

let dlLineIdx = -1;
function updateLyrics(t){
  const tr = TRACKS[cur];
  if (!tr || !tr.lines || !tr.lines.length){
    if (Object.keys(lyricRowEls).length){ $("#lyric-rows").innerHTML = ""; lyricRowEls = {}; }
    lineIdx = -1;
    dlLineIdx = -1;
    return;
  }
  const tt = t + LYRIC_LEAD;

  // full lyrics overlay tracks the original (unmerged) lines
  const li = tr.lines.findIndex(L => tt >= L.words[0].t - .3 && tt < L.words[L.words.length-1].t + 1.2);
  if (li !== -1 && li !== lineIdx){
    lineIdx = li;
    // the full-lyrics overlay no longer scroll-follows the song - it just
    // shows the text statically and the user scrolls it themselves
  }

  // home carousel tracks the re-flowed <=33-char display lines (each
  // sentence's window is contiguous with the next, incl. blank ones)
  const dl = computeDisplayLines(tr, LYRIC_LINE_MAX_CHARS);
  const dli = dl.findIndex(L => tt >= L.t0 - .3 && tt < L.t1);
  if (dli === -1) return; // before the first sentence or after the last
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

/* ================================================================
   UI
   ================================================================ */

function renderMeta(){
  const tr = TRACKS[cur];
  $("#m-title").textContent = tr.title;
  $("#m-folder").textContent = tr.artist;
  $("#t-tot").textContent = fmt(tr.duration || 0);
  document.title = `${tr.title} — AQAI`;
  // each artist's own photo (artist_1.png etc) is masked into
  // profilepic.png's shape; artists without one just show profilepic.png
  // directly (it's already pre-shaped, no mask needed)
  const photo = $("#artist-photo");
  if (tr.artistPhoto){
    photo.src = tr.artistPhoto;
    photo.classList.add("masked");
  } else {
    photo.src = "assets/profilepic.png";
    photo.classList.remove("masked");
  }
  // --artist-color drives the logo fill, the title/artist color-cycle
  // animation, and the background overlay tint (see styles.css); the
  // wave visualizer reads it separately into WAVE_COLOR below since
  // canvas drawing can't reference a CSS custom property directly.
  // Follows the real per-track artist color again (only the 3D
  // background environment runs the fixed blue scheme now, everything
  // else in the UI - logo, buttons, stroke, etc. - stays per-artist),
  // boosted the same +12% intensity as the 3D scene palette
  const artistColor = "#" + new THREE.Color(tr.artistColor || "#7CFF9E").offsetHSL(0, 0.12, 0.02).getHexString();
  document.documentElement.style.setProperty("--artist-color", artistColor);
  WAVE_COLOR = artistColor;
  positionBgGradient();
  updateFlagLyricsButton();
}

// per-track "flag this song's lyrics for re-syncing" toggle (owner-only,
// see #btn-flag-lyrics/OWNER_ONLY_SELECTORS) - just records intent server-side
// (see /api/lyrics-flag) so it shows up in the Info tab's Lyrics QA list;
// actually re-running Whisper on it is still a manual step from there
let lyricsFlagIds = new Set();
function updateFlagLyricsButton(){
  const btn = $("#btn-flag-lyrics");
  const tr = TRACKS[cur];
  if (!btn || !tr) return;
  btn.setAttribute("aria-pressed", lyricsFlagIds.has(tr.id) ? "true" : "false");
}
function initLyricsFlagging(){
  const btn = $("#btn-flag-lyrics");
  if (!btn) return;
  fetch("/api/lyrics-flags").then(r => r.json()).then(data => {
    lyricsFlagIds = new Set(Object.keys(data.flags || {}));
    updateFlagLyricsButton();
  }).catch(() => {});
  btn.onclick = async () => {
    const tr = TRACKS[cur];
    if (!tr) return;
    btn.disabled = true;
    try {
      const res = await fetch("/api/lyrics-flag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: tr.id }),
      });
      const data = await res.json();
      if (data.flagged) lyricsFlagIds.add(tr.id); else lyricsFlagIds.delete(tr.id);
      updateFlagLyricsButton();
      toast(data.flagged ? "Flagged this song's lyrics for re-syncing" : "Unflagged");
    } catch (e){
      toast("Could not flag this song");
    }
    btn.disabled = false;
  };
}

// per-track "make a video" button (owner-only, see #btn-make-video/
// OWNER_ONLY_SELECTORS) - kicks off a server-side ffmpeg render (the
// karaoke lyrics, background, photo, waveform and logo baked into an
// actual .mp4, see player/video_export/) for both a 9:16 and a 16:9 cut,
// then polls for progress until each is ready to download
let videoExportPollTimer = null;
function stopVideoExportPoll(){
  if (videoExportPollTimer){ clearTimeout(videoExportPollTimer); videoExportPollTimer = null; }
}
function renderVideoExportJob(job){
  const panel = $("#video-export-panel");
  if (!panel) return;
  panel.classList.add("show");
  panel.querySelectorAll(".video-export-row").forEach(row => {
    const aspect = row.dataset.aspect;
    const info = (job || {})[aspect] || {};
    row.classList.remove("done", "error");
    const fill = row.querySelector(".video-export-fill");
    const link = row.querySelector(".video-export-link");
    if (info.status === "done"){
      row.classList.add("done");
      link.href = info.url;
      link.download = "";
    } else if (info.status === "error"){
      row.classList.add("error");
      fill.style.width = "0%";
    } else {
      fill.style.width = `${Math.round((info.progress || 0) * 100)}%`;
    }
  });
}
function initVideoExport(){
  const btn = $("#btn-make-video");
  if (!btn) return;
  btn.onclick = async () => {
    const tr = TRACKS[cur];
    if (!tr) return;
    stopVideoExportPoll();
    const panel = $("#video-export-panel");
    if (panel){
      panel.classList.add("show");
      panel.querySelectorAll(".video-export-row").forEach(row => {
        row.classList.remove("done", "error");
        row.querySelector(".video-export-fill").style.width = "0%";
      });
    }
    try {
      await fetch("/api/make-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: tr.id }),
      });
    } catch (e){
      toast("Could not start the video render");
      return;
    }
    const poll = async () => {
      try {
        const res = await fetch(`/api/video-status/${tr.id}`);
        const data = await res.json();
        renderVideoExportJob(data.job);
        const statuses = Object.values(data.job || {}).map(j => j.status);
        const stillGoing = statuses.some(s => s === "running") || statuses.length < 2;
        if (stillGoing) videoExportPollTimer = setTimeout(poll, 1500);
        else toast("Video render finished");
      } catch (e){
        videoExportPollTimer = setTimeout(poll, 3000);
      }
    };
    poll();
  };
}

const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
const SOUND_ON_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 8a5 5 0 0 1 0 8"/><path d="M17.7 5a9 9 0 0 1 0 14"/><path d="M6 15H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h2l3.5-4.5A.8.8 0 0 1 11 5v14a.8.8 0 0 1-1.5.5z"/></svg>';
const SOUND_OFF_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>';
function syncButtons(){
  const btn = $("#c-play");
  btn.classList.toggle("on", playing);
  btn.setAttribute("aria-label", playing ? "Pause" : "Play");
  btn.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
  renderList();
}

let listFilter = "";
function renderList(){
  const el = $("#tracklist"); el.innerHTML = "";
  const q = listFilter.trim().toLowerCase();
  const indices = TRACKS.map((_, i) => i).filter(i => {
    if (!q) return true;
    const tr = TRACKS[i];
    return tr.title.toLowerCase().includes(q) || tr.folder.toLowerCase().includes(q) || tr.artist.toLowerCase().includes(q) || (tr.tags||"").toLowerCase().includes(q);
  });
  $("#list-count").textContent = `${indices.length} / ${TRACKS.length} tracks`;

  let lastFolder = null;
  indices.forEach((i) => {
    const tr = TRACKS[i];
    if (tr.folder !== lastFolder){
      lastFolder = tr.folder;
      const h = document.createElement("div");
      h.className = "group-header";
      h.textContent = tr.artist;
      if (tr.artistColor) h.style.setProperty("--row-color", tr.artistColor);
      el.appendChild(h);
    }
    const b = document.createElement("button");
    b.className = "track" + (i === cur ? " playing" : "");
    if (tr.artistColor) b.style.setProperty("--row-color", tr.artistColor);
    b.innerHTML = `
      <span class="idx">${String(i+1).padStart(3,"0")}</span>
      <span class="t-meta">
        <span class="t-title"></span>
      </span>
      <span class="eq"><i></i><i></i><i></i></span>
      <span class="t-len">${fmt(tr.duration||0)}</span>`;
    b.querySelector(".t-title").textContent = tr.title;
    b.onclick = () => { load(i); showView("home"); };
    el.appendChild(b);
  });
}
$("#list-search").addEventListener("input", e => { listFilter = e.target.value; renderList(); });

/* progress bar (drag + tap) */
const bar = $("#bar");
let dragging = false;
function barSeek(e){
  const r = bar.getBoundingClientRect();
  const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
  seek(Math.max(0, Math.min(1, x / r.width)) * (TRACKS[cur].duration || 0));
}
bar.addEventListener("pointerdown", e => { dragging = true; bar.setPointerCapture(e.pointerId); barSeek(e); });
bar.addEventListener("pointermove", e => { if (dragging) barSeek(e); });
bar.addEventListener("pointerup",   () => dragging = false);

function updateUI(){
  const tr = TRACKS[cur], t = Math.min(elapsed(), tr.duration || 1);
  const pct = tr.duration ? (t / tr.duration) * 100 : 0;
  $("#bar-fill").style.width = pct + "%";
  $("#bar-knob").style.left = pct + "%";
  bar.setAttribute("aria-valuenow", Math.round(pct));
  $("#t-cur").textContent = fmt(t);
  updateLyrics(t);
}

/* views */
function showView(name){
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + name));
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.view === name));
}
document.querySelectorAll(".nav-btn").forEach(b => b.onclick = () => showView(b.dataset.view));

/* controls */
$("#c-play").onclick = () => playing ? pause() : play();
$("#c-prev").onclick = prev;
$("#c-next").onclick = next;
$("#c-random").onclick = random;

/* toast */
let toastT;
function toast(msg){
  const el = $("#toast"); el.textContent = msg; el.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), 2200);
}

/* download + share */
$("#btn-download").onclick = () => {
  const tr = TRACKS[cur];
  const a = document.createElement("a");
  a.href = tr.url; a.download = tr.downloadName || (tr.title + ".mp3"); a.click();
};
$("#btn-share").onclick = async () => {
  const tr = TRACKS[cur];
  // "?t=<id>" is read back at boot (see the fetch("/api/tracks") handler)
  // to start the player on this exact track instead of the default first one
  const url = `${location.origin}${location.pathname}?t=${encodeURIComponent(tr.id)}`;
  const data = { title: `${tr.title} — ${tr.artist} · AQAI`, text: `Listening to "${tr.title}" by ${tr.artist}`, url };
  if (navigator.share){ try { await navigator.share(data); } catch(e){} }
  else if (navigator.clipboard){ await navigator.clipboard.writeText(url); toast("Link copied"); }
};

/* delete this song - moved server-side into a _deleted folder next to
   its own files (not unlinked outright) so a wrong click stays
   recoverable, matching the panorama-remove pattern */
let deleteSongInFlight = false;
function reindexAudioElsAfterDelete(removedIdx){
  Object.keys(audioEls).map(Number).sort((a, b) => a - b).forEach(k => {
    if (k === removedIdx){
      audioEls[k].pause();
      delete audioEls[k];
    } else if (k > removedIdx){
      audioEls[k - 1] = audioEls[k];
      delete audioEls[k];
    }
  });
}
function deleteCurrentSong(){
  if (deleteSongInFlight || !TRACKS.length) return;
  const tr = TRACKS[cur];
  if (!tr) return;
  deleteSongInFlight = true;
  fetch("/api/tracks/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: tr.id })
  }).then(r => r.json()).then(data => {
    if (!data.ok){ toast("Could not delete song"); return; }
    const idx = cur;
    reindexAudioElsAfterDelete(idx);
    TRACKS.splice(idx, 1);
    toast("Song deleted");
    $("#info-count").textContent = TRACKS.length;
    if (!TRACKS.length){
      playing = false;
      renderList(); syncButtons();
      return;
    }
    load(Math.min(idx, TRACKS.length - 1));
    renderList();
  }).catch(() => toast("Could not delete song"))
    .finally(() => { deleteSongInFlight = false; });
}
$("#btn-delete").onclick = deleteCurrentSong;

/* rename - clicking a pencil opens an inline text field in place of the
   title/artist; closing it (blur, or pressing Enter which just blurs)
   saves whatever's typed, Escape cancels back to the original text */
let renameInFlight = false;
async function saveTitle(tr, title){
  renameInFlight = true;
  try {
    const res = await fetch("/api/tracks/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: tr.id, title })
    });
    const data = await res.json();
    if (data.ok){
      tr.title = title;
      renderMeta();
      renderList();
      if (fullLyricsOpen) $("#lf-title").textContent = title;
      toast("Song renamed");
    } else {
      toast(data.error || "Could not rename song");
    }
  } catch (e){
    toast("Could not rename song");
  } finally {
    renameInFlight = false;
  }
}
function beginEditTitle(){
  const tr = TRACKS[cur];
  if (!tr || renameInFlight) return;
  const input = $("#m-title-input");
  input.value = tr.title;
  $(".meta").classList.add("editing-title");
  input.focus();
  input.select();
}
let titleEditCancelled = false;
function commitEditTitle(){
  $(".meta").classList.remove("editing-title");
  if (titleEditCancelled){ titleEditCancelled = false; return; }
  const tr = TRACKS[cur];
  const title = $("#m-title-input").value.trim();
  if (!tr || !title || title === tr.title) return;
  saveTitle(tr, title);
}
$("#btn-edit-title").onclick = beginEditTitle;
$("#m-title-input").addEventListener("blur", commitEditTitle);
$("#m-title-input").addEventListener("keydown", e => {
  if (e.key === "Enter"){ e.preventDefault(); e.target.blur(); }
  else if (e.key === "Escape"){ titleEditCancelled = true; e.target.blur(); }
});

/* artist rename - same inline-edit pattern as the title, but the change
   applies to every track under that artist's folder (both server-side,
   via /api/artist/rename, and client-side across the whole TRACKS array)
   since the artist name is shared by the whole folder, not per-track */
async function saveArtist(tr, name){
  renameInFlight = true;
  try {
    const res = await fetch("/api/artist/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder: tr.folder, name })
    });
    const data = await res.json();
    if (data.ok){
      TRACKS.forEach(t => { if (t.folder === tr.folder) t.artist = name; });
      renderMeta();
      renderList();
      if (fullLyricsOpen) $("#lf-folder").textContent = name;
      toast("Artist renamed");
    } else {
      toast(data.error || "Could not rename artist");
    }
  } catch (e){
    toast("Could not rename artist");
  } finally {
    renameInFlight = false;
  }
}
function beginEditArtist(){
  const tr = TRACKS[cur];
  if (!tr || renameInFlight) return;
  const input = $("#m-folder-input");
  input.value = tr.artist;
  $(".meta").classList.add("editing-artist");
  input.focus();
  input.select();
}
let artistEditCancelled = false;
function commitEditArtist(){
  $(".meta").classList.remove("editing-artist");
  if (artistEditCancelled){ artistEditCancelled = false; return; }
  const tr = TRACKS[cur];
  const name = $("#m-folder-input").value.trim();
  if (!tr || !name || name === tr.artist) return;
  saveArtist(tr, name);
}
$("#btn-edit-artist").onclick = beginEditArtist;
$("#m-folder-input").addEventListener("blur", commitEditArtist);
$("#m-folder-input").addEventListener("keydown", e => {
  if (e.key === "Enter"){ e.preventDefault(); e.target.blur(); }
  else if (e.key === "Escape"){ artistEditCancelled = true; e.target.blur(); }
});

/* same rename pattern again, but on the lyrics-full overlay's own header -
   the main .meta row sits behind the overlay's backdrop while it's open, so
   its pencils/input aren't usable from in here; these are a separate pair
   of pencils/inputs wired to the exact same saveTitle()/saveArtist() calls
   so the two views never drift out of sync */
function lfBeginEditTitle(){
  const tr = TRACKS[cur];
  if (!tr || renameInFlight) return;
  const input = $("#lf-title-input");
  input.value = tr.title;
  $(".lf-meta").classList.add("editing-title");
  input.focus();
  input.select();
}
let lfTitleEditCancelled = false;
function lfCommitEditTitle(){
  $(".lf-meta").classList.remove("editing-title");
  if (lfTitleEditCancelled){ lfTitleEditCancelled = false; return; }
  const tr = TRACKS[cur];
  const title = $("#lf-title-input").value.trim();
  if (!tr || !title || title === tr.title) return;
  saveTitle(tr, title);
}
$("#lf-btn-edit-title").onclick = lfBeginEditTitle;
$("#lf-title-input").addEventListener("blur", lfCommitEditTitle);
$("#lf-title-input").addEventListener("keydown", e => {
  if (e.key === "Enter"){ e.preventDefault(); e.target.blur(); }
  else if (e.key === "Escape"){ lfTitleEditCancelled = true; e.target.blur(); }
});
function lfBeginEditArtist(){
  const tr = TRACKS[cur];
  if (!tr || renameInFlight) return;
  const input = $("#lf-folder-input");
  input.value = tr.artist;
  $(".lf-meta").classList.add("editing-artist");
  input.focus();
  input.select();
}
let lfArtistEditCancelled = false;
function lfCommitEditArtist(){
  $(".lf-meta").classList.remove("editing-artist");
  if (lfArtistEditCancelled){ lfArtistEditCancelled = false; return; }
  const tr = TRACKS[cur];
  const name = $("#lf-folder-input").value.trim();
  if (!tr || !name || name === tr.artist) return;
  saveArtist(tr, name);
}
$("#lf-btn-edit-artist").onclick = lfBeginEditArtist;
$("#lf-folder-input").addEventListener("blur", lfCommitEditArtist);
$("#lf-folder-input").addEventListener("keydown", e => {
  if (e.key === "Enter"){ e.preventDefault(); e.target.blur(); }
  else if (e.key === "Escape"){ lfArtistEditCancelled = true; e.target.blur(); }
});
$("#lf-btn-delete").onclick = () => { closeFullLyrics(); deleteCurrentSong(); };

/* edit-lyrics affordance toggle - sentences are already click-to-edit
   whenever EDITABLE is on (see updateEditControlsVisibility), this just
   makes that discoverable with a dashed outline + a pressed button state.
   Two entry points (the main player screen's #btn-edit-lyrics and the
   full-lyrics overlay's own #lf-btn-edit-lyrics) share the same on/off
   state and stay in sync with each other. */
function setLyricsEditing(on){
  $("#lyrics-full").classList.toggle("lf-editing-lyrics", on);
  $("#btn-edit-lyrics").setAttribute("aria-pressed", on ? "true" : "false");
  $("#lf-btn-edit-lyrics").setAttribute("aria-pressed", on ? "true" : "false");
}
$("#lf-btn-edit-lyrics").onclick = () => {
  setLyricsEditing(!$("#lyrics-full").classList.contains("lf-editing-lyrics"));
};
// the main-screen button also opens the full lyrics overlay, since
// editing only makes sense once it's visible
$("#btn-edit-lyrics").onclick = () => {
  if (!fullLyricsOpen) openFullLyrics();
  setLyricsEditing(!$("#lyrics-full").classList.contains("lf-editing-lyrics"));
};

/* move this song to a different existing artist - moves its audio +
   metadata + karaoke files into that artist's own library folder
   server-side (see /api/track/relocate) */
async function relocateTrackToArtist(tr, targetFolder){
  try {
    const res = await fetch("/api/track/relocate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: tr.id, targetFolder })
    });
    const data = await res.json();
    if (data.ok){
      toast("Song moved");
      const res2 = await fetch("/api/tracks");
      const data2 = await res2.json();
      TRACKS = data2.tracks.map(t => ({
        id: t.id, title: t.title, artist: t.artist, folder: t.folder,
        artistPhoto: t.artistPhoto || null, artistColor: t.artistColor || null,
        duration: t.duration || 0, tags: t.tags || "", url: t.audioUrl,
        downloadName: t.downloadName, rawLyrics: t.lyrics || [],
        sectionBreaks: t.sectionBreaks || [], lines: [], _lyricsLoaded: false,
      }));
      const newIdx = TRACKS.findIndex(t => t.folder === data.folder && t.title === tr.title);
      cur = newIdx !== -1 ? newIdx : Math.min(cur, TRACKS.length - 1);
      renderMeta(); renderList(); syncButtons();
      ensureLyricsLoaded(cur);
      if (fullLyricsOpen) buildFullLyrics();
    } else {
      toast(data.error || "Could not move song");
    }
  } catch (e){
    toast("Could not move song");
  }
}
function closeArtistPicker(){
  $("#artist-picker").classList.remove("open");
}
$("#btn-relocate-artist").onclick = e => {
  e.stopPropagation();
  const picker = $("#artist-picker");
  if (picker.classList.contains("open")){ closeArtistPicker(); return; }
  const tr = TRACKS[cur];
  if (!tr) return;
  const others = [...new Map(TRACKS.filter(t => t.folder !== tr.folder).map(t => [t.folder, t.artist])).entries()];
  picker.innerHTML = others.length
    ? others.map(([folder, artist]) => `<button data-folder="${folder.replace(/"/g, "&quot;")}">${artist}</button>`).join("")
    : `<button disabled style="opacity:.5;cursor:default">No other artists</button>`;
  picker.querySelectorAll("button[data-folder]").forEach(b => {
    b.onclick = () => { closeArtistPicker(); relocateTrackToArtist(TRACKS[cur], b.dataset.folder); };
  });
  picker.classList.add("open");
};
document.addEventListener("click", e => {
  const picker = $("#artist-picker");
  if (picker && picker.classList.contains("open") && !picker.contains(e.target) && e.target.id !== "btn-relocate-artist"){
    closeArtistPicker();
  }
});

/* mute */

/* volume */
function paintVolumeFill(el){
  const pct = (el.value - el.min) / (el.max - el.min) * 100;
  el.style.setProperty("--vol-pct", pct + "%");
}
$("#c-volume").oninput = e => {
  masterVolume = +e.target.value;
  if (master) master.gain.value = masterVolume;
  paintVolumeFill(e.target);
};
paintVolumeFill($("#c-volume"));

/* mobile "more" menu (Lyrics/Download/Share collapse under 600px) */
$("#btn-more").onclick = () => $("#side-btns").classList.toggle("open");

/* ================================================================
   SYNC STUDIO — tap once per word (or per line), exports word-timed lines
   Visible only when the URL contains #sync
   ================================================================ */
let syncSel = 0, tapMode = "line", tapUnits = [], tapIdx = 0, tapTimer = null;
let syncFilter = "";

/* split any line >5 words into balanced chunks (7 → 4+3, not 5+2) */
function chunk5(lines){
  const out = [];
  lines.forEach(L => {
    const k = Math.ceil(L.length / 5), base = Math.floor(L.length / k);
    let rem = L.length - base * k, i = 0;
    for (let c = 0; c < k; c++){
      const size = base + (rem-- > 0 ? 1 : 0);
      out.push(L.slice(i, i + size)); i += size;
    }
  });
  return out;
}
function fillLyrics(){
  const tr = TRACKS[syncSel];
  $("#sync-lyrics").value = (tr && tr.rawLyrics) ? tr.rawLyrics.join("\n") : "";
}
function renderSyncTracks(){
  const box = $("#sync-tracks"); box.innerHTML = "";
  const q = syncFilter.trim().toLowerCase();
  TRACKS.forEach((tr, i) => {
    if (!tr.rawLyrics || !tr.rawLyrics.length) return;
    if (q && !tr.title.toLowerCase().includes(q) && !tr.folder.toLowerCase().includes(q) && !tr.artist.toLowerCase().includes(q)) return;
    const b = document.createElement("button");
    b.className = "sync-track" + (i === syncSel ? " sel" : "");
    b.textContent = `${tr.title} — ${tr.artist}`;
    b.onclick = () => { syncSel = i; renderSyncTracks(); fillLyrics(); };
    box.appendChild(b);
  });
}
$("#sync-search").addEventListener("input", e => { syncFilter = e.target.value; renderSyncTracks(); });
document.querySelectorAll("#sync-mode .sync-track").forEach(b => {
  b.onclick = () => {
    tapMode = b.dataset.mode;
    document.querySelectorAll("#sync-mode .sync-track").forEach(x => x.classList.toggle("sel", x === b));
  };
});
const unitText = u => tapMode === "line" ? u.words.join(" ") : u.w;
function tapPaint(){
  $("#tap-prev").textContent = tapIdx > 0 ? unitText(tapUnits[tapIdx-1]) : "";
  $("#tap-word").textContent = tapIdx < tapUnits.length ? unitText(tapUnits[tapIdx]) : "✓ done";
  $("#tap-word").style.fontSize = tapMode === "line" ? "clamp(20px,5.6vw,34px)" : "";
  $("#tap-next").textContent = tapIdx+1 < tapUnits.length
    ? tapUnits.slice(tapIdx+1, tapIdx + (tapMode === "line" ? 2 : 4)).map(unitText).join("  ·  ") : "";
  $("#tap-count").textContent = Math.min(tapIdx, tapUnits.length) + " / " + tapUnits.length + (tapMode === "line" ? " lines" : " words");
}
function startTapping(){
  const raw = $("#sync-lyrics").value.trim();
  if (!raw){ toast("This track has no lyrics"); return; }
  const lineArrs = chunk5(raw.split(/\n+/).map(l => l.trim().split(/\s+/).filter(Boolean)).filter(l => l.length));
  if (tapMode === "line"){
    tapUnits = lineArrs.map((L, li) => ({ words: L, line: li, t: 0 }));
    $("#tap-zone").textContent = "TAP AT THE START OF EVERY LINE";
  } else {
    tapUnits = [];
    lineArrs.forEach((L, li) => L.forEach(w => tapUnits.push({ w, line: li, t: 0 })));
    $("#tap-zone").textContent = "TAP HERE ON EVERY WORD";
  }
  tapIdx = 0;
  load(syncSel, false);
  const el = getAudio(syncSel);
  el.currentTime = 0;
  $("#tap-title").textContent = TRACKS[syncSel].title;
  $("#tap-ui").classList.add("on");
  tapPaint();
  el.play(); playing = true; syncButtons();
  tapTimer = setInterval(() => $("#tap-time").textContent = fmt(el.currentTime), 200);
}
function buildLines(){
  const lines = [];
  if (tapMode === "line"){
    tapUnits.forEach((u, i) => {
      const t0 = u.t;
      const nextT = i+1 < tapUnits.length ? tapUnits[i+1].t : t0 + Math.min(4, u.words.length * 0.45) + 0.4;
      const span = Math.max(0.6, (nextT - t0) - 0.35);
      const per = Math.min(span / u.words.length, 0.8);
      lines.push({ words: u.words.map((w, j) => ({ w, t: +(t0 + j * per).toFixed(2) })) });
    });
  } else {
    tapUnits.forEach(u => {
      if (!lines[u.line]) lines[u.line] = { words: [] };
      lines[u.line].words.push({ w: u.w, t: +u.t.toFixed(2) });
    });
  }
  return lines.filter(Boolean);
}
function finishTapping(apply){
  clearInterval(tapTimer);
  $("#tap-ui").classList.remove("on");
  pause();
  const el = getAudio(syncSel); el.playbackRate = 1;
  if (!apply) return;
  const clean = buildLines();
  TRACKS[syncSel].lines = clean;
  TRACKS[syncSel]._lyricsLoaded = true;
  const out = $("#sync-out");
  out.style.display = "block";
  out.value = '"lines": ' + JSON.stringify(clean);
  $("#sync-export").disabled = false;

  fetch(`/api/sync/${TRACKS[syncSel].id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lines: clean }),
  }).then(() => toast("Synced! Saved & previewing on Home"));

  showView("home");
  load(syncSel, true);
}
$("#sync-start").onclick = startTapping;
$("#sync-export").onclick = () => {
  const blob = new Blob([$("#sync-out").value], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = TRACKS[syncSel].title.replace(/\s+/g, "_") + "_lyrics.json";
  a.click();
  if (navigator.clipboard) navigator.clipboard.writeText($("#sync-out").value).then(()=>toast("Also copied to clipboard"));
};
$("#tap-zone").addEventListener("pointerdown", e => {
  e.preventDefault();
  if (tapIdx >= tapUnits.length) return finishTapping(true);
  tapUnits[tapIdx].t = getAudio(syncSel).currentTime;
  tapIdx++;
  tapPaint();
  if (tapIdx >= tapUnits.length) setTimeout(() => finishTapping(true), 400);
});
$("#tap-back").onclick = () => {
  if (tapIdx === 0) return;
  tapIdx--;
  const backTo = Math.max(0, (tapIdx > 0 ? tapUnits[tapIdx-1].t : 0) - 1);
  getAudio(syncSel).currentTime = backTo;
  tapPaint();
};
$("#tap-slow").onclick = e => {
  const el = getAudio(syncSel);
  el.playbackRate = el.playbackRate === 1 ? 0.75 : 1;
  e.target.textContent = el.playbackRate === 1 ? "0.75×" : "1×";
};
$("#tap-quit").onclick = () => finishTapping(false);

if (location.hash.includes("sync")){
  $("#nav-sync").classList.remove("hidden");
}

/* ================================================================
   VU METER — 10-bar equalizer strip, glowing, reacts to the same
   frequency data driving the 3D visualizer
   ================================================================ */
const VU_BARS = 10;
const vuMeterEl = $("#vu-meter");
const vuBarEls = Array.from({ length: VU_BARS }, () => {
  const s = document.createElement("span");
  s.style.height = "0px";
  vuMeterEl.appendChild(s);
  return s;
});
function updateVuMeter(hasAudio){
  // bars swing from a flat 0px up to the meter's own height (matched to
  // the home icon's height in CSS), so silence reads as fully flat
  const maxH = vuMeterEl.clientHeight || 20;
  for (let i = 0; i < VU_BARS; i++){
    if (!hasAudio){ vuBarEls[i].style.height = "0px"; continue; }
    const start = 2 + i * 10;
    let sum = 0;
    for (let j = 0; j < 8; j++) sum += freqData[start + j] || 0;
    const raw = sum / 8 / 255;
    const v = Math.min(1, Math.pow(raw, 0.7) * 1.3);
    vuBarEls[i].style.height = `${v * maxH}px`;
  }
}

/* ================================================================
   3D VISUALIZER (three.js — audio-reactive icosahedron, forest on mint)
   ================================================================ */
const stage = $("#stage");
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
// soft shadow maps - only the TILES scene casts/receives (its directional
// light is the lone shadow-casting light), so other scenes pay nothing
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// wider FOV than a typical 50deg lens - the curved sphere/pano patch reads
// with noticeably more depth/perspective as a result (affects the intro
// tunnel too, since they share this one camera)
const camera = new THREE.PerspectiveCamera(68, 1, 0.1, 900);
camera.position.z = 8.0;
// in the scene graph (rather than the usual standalone camera) so any
// future camera-child objects (lights, HUD meshes) get collected by the
// renderer's per-scene pass; currently nothing rides it, and it's harmless
scene.add(camera);
// lowered while the intro tunnel is up - a lower viewpoint makes the nearby
// tunnel walls sweep past faster in the visual field, reading as more speed.
// Kept well under the tunnel's minimum wall radius (see TUNNEL_RADIUS_BASE's
// Math.max(1.8, ...) clamp below) so the camera always stays inside it.
// Also pushed deeper into the tube (z -8 instead of the music screen's 8)
// so the rock walls fully surround the view; both restored on gate exit.
camera.position.y = document.body.classList.contains("gate-active") ? -1.1 : 0;
camera.position.z = document.body.classList.contains("gate-active") ? -8 : 8;
// tighter intro lens from the very first frame (updateArtistBackground
// re-derives the per-scene zoom on every track/gate change after this)
camera.zoom = document.body.classList.contains("gate-active") ? 1.3 : 1;

/* ---------- background panorama: the selected clip mapped onto a curved
   patch centered in front of the camera - sized to the video's own aspect
   ratio so it fills the screen height without stretching/zooming, and the
   camera (see mouse-look below) rotates to look around it ---------- */
const panoVideoEl = document.createElement("video");
panoVideoEl.muted = true; panoVideoEl.loop = true; panoVideoEl.playsInline = true;
panoVideoEl.crossOrigin = "anonymous";
const panoTexture = new THREE.VideoTexture(panoVideoEl);

// .gif entries aren't decodable as a <video>, so they're played back by
// letting the browser animate a hidden <img> and continuously re-drawing
// its current frame onto a canvas, which then feeds a CanvasTexture — kept
// off-screen via opacity (not display:none, which pauses gif animation)
const panoGifImg = document.createElement("img");
panoGifImg.crossOrigin = "anonymous";
panoGifImg.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;";
document.body.appendChild(panoGifImg);
const panoGifCanvas = document.createElement("canvas");
const panoGifCtx = panoGifCanvas.getContext("2d");
const panoGifTexture = new THREE.CanvasTexture(panoGifCanvas);
let currentPanoKind = "video"; // "video" | "gif" — tracks which texture panoMat.map currently is
// intro-logo reflection: the panorama is drawn into one shared canvas each
// frame, then copied onto every extruded layer (masked to the AQAI shape) so
// all faces/sides of the 3D logo reflect the sphere. A moving specular streak
// is composited on top for a polished-chrome shine.
let logoLayers = [], logoReflCanvas = null, logoReflCtx = null;
const LOGO_REFL_W = 480, LOGO_REFL_H = 180;

// music-reactive line visualizer - a flat 2D canvas (#wave-canvas, sits
// between the logo and the lyrics viewer; see positionWaveCanvas()/
// drawWaveCanvas() near the UI code below), not part of the 3D sphere.
// 25 points sampled from the live audio waveform (time-domain, not
// frequency spectrum - a spectrum settles into one fixed descending
// shape, a waveform makes every point genuinely dance), smoothed and
// tapered (full swing at the center, 10% at the edges) each frame, then
// drawn as a Catmull-Rom spline so the line reads as one smooth curve
// rather than sharp linear-interpolation kinks between sparse points
const WAVE_N = 25;
const waveCur = new Array(WAVE_N).fill(0);
let wavePhase = 0;
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
    // gentle idle wave when nothing's playing
    for (let i = 0; i < WAVE_N; i++) tgt[i] = Math.sin(wavePhase + i * 0.55) * 0.16;
    wavePhase += 0.035;
  }
  const k = isPlaying ? 0.5 : 0.08;
  for (let i = 0; i < WAVE_N; i++) waveCur[i] += (tgt[i] - waveCur[i]) * k;
}
// Catmull-Rom spline through the WAVE_N smoothed samples so the drawn
// curve is smooth rather than a sharp linear zigzag between few points
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
let WAVE_COLOR = "#7CFF9E"; // updated per-track to the artist's color in renderMeta()
// mixes a hex color toward white by `frac` (0 = unchanged, 1 = white) -
// same math as the CSS color-mix(..., white) used for the logo/pill cycle
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
  // masks out a fixed 108px-wide gap centered on the canvas's own
  // horizontal middle, so nothing draws behind whatever sits there (the
  // logo) - unlike before, this is a fixed width, not tied to the logo's
  // own measured size
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
  // baseline sits below the canvas's own vertical center (not h/2 anymore),
  // giving the upward-only waveform more headroom above its resting line
  const midY = h * 0.65, ampPx = h * 0.1764;
  // same artist-color <-> 20%-brighter cycle as the logo and the
  // song-title pill, 4s ease-in-out (cosine), looping
  const cyclePhase = (1 - Math.cos(performance.now() / 4000 * 2 * Math.PI)) / 2;
  dctx.strokeStyle = WAVE_COLOR;
  dctx.fillStyle = WAVE_COLOR;
  dctx.lineCap = "round";
  let prevX = 0, prevY = midY;
  for (let s = 0; s <= WAVE_SEGMENTS; s++){
    const u = s / WAVE_SEGMENTS;
    const val = waveCurveAt(display, u);
    // rectified: rests on the midY baseline and only ever moves up from
    // it (never dips below), instead of swinging both above and below
    const x = u * w, y = midY - Math.abs(val) * ampPx;
    if (s > 0){
      const intensity = Math.min(1, Math.abs(val) * 1.6);
      dctx.lineWidth = 1 + intensity * 6; // 1px quiet -> ~7px loud, thickness tracks loudness
      dctx.globalAlpha = 1; // opaque
      // artist colour, brightened toward white on the most intense/tallest
      // parts of the line
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
// returns the linear wave visualiser's own intensity (0..1) at a given
// normalized x position (0..1 across its width) - same calc drawWaveCanvas
// uses for its line thickness, factored out so the profile-photo bars
// below can react in lockstep with the matching x-position on that line
function waveIntensityAtU(u){
  const display = new Array(WAVE_N);
  for (let i = 0; i < WAVE_N; i++){
    const env = 0.1 + 0.9 * (1 - Math.abs(i / (WAVE_N - 1) - 0.5) * 2);
    display[i] = waveCur[i] * env;
  }
  return Math.min(1, Math.abs(waveCurveAt(display, u)) * 1.6);
}
// 8 vertical bars along the top of the photo's edge (a stroke divided into
// bars rather than the previous full ring). Each sits at its own
// x-position on the photo, fixed thickness, and its LENGTH (10px resting,
// 20px max) tracks the linear wave visualiser's intensity at that same
// x-position, converted from this local SVG space to the page and back to
// the wave canvas's own normalized coordinate each frame.
const BAR_COUNT = 24;
const BAR_MIN_LEN = 8, BAR_MAX_LEN = 15; // viewBox units = css px
const RING_CX = 94.53125, RING_CY = 76.0706; // ellipse centre (viewBox units = css px)
const RING_RX = 83.53125, RING_RY = 65.0706; // photo's own edge
const artistBarEls = [];
(function buildArtistBars(){
  const g = $("#artist-bars");
  if (!g) return;
  for (let i = 0; i < BAR_COUNT; i++){
    const xFrac = (i + 0.5) / BAR_COUNT; // 0..1 across the photo's width, centred within 8 equal slices
    const xOffset = (xFrac - 0.5) * 2 * RING_RX;
    const baseX = RING_CX + xOffset;
    const baseY = RING_CY - RING_RY * Math.sqrt(Math.max(0, 1 - (xOffset / RING_RX) ** 2));
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("class", "artist-bar");
    line.setAttribute("x1", baseX.toFixed(2));
    line.setAttribute("y1", baseY.toFixed(2));
    line.setAttribute("x2", baseX.toFixed(2));
    line.setAttribute("y2", (baseY - BAR_MIN_LEN).toFixed(2));
    line.setAttribute("stroke-width", "3");
    g.appendChild(line);
    artistBarEls.push({ el: line, baseX, baseY });
  }
})();
function updateArtistRingVisualiser(){
  if (!artistBarEls.length) return;
  const svg = $("#artist-photo-ring");
  const canvas = $("#wave-canvas");
  if (!svg || !canvas) return;
  if (!freqData || !playing){
    artistBarEls.forEach(b => b.el.setAttribute("y2", (b.baseY - BAR_MIN_LEN).toFixed(2)));
    return;
  }
  const svgRect = svg.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  if (!svgRect.width || !canvasRect.width) return;
  const viewBoxW = 189.0625;
  artistBarEls.forEach(b => {
    const absoluteX = svgRect.left + (b.baseX / viewBoxW) * svgRect.width;
    const u = (absoluteX - canvasRect.left) / canvasRect.width;
    const intensity = waveIntensityAtU(u);
    const len = BAR_MIN_LEN + intensity * (BAR_MAX_LEN - BAR_MIN_LEN);
    b.el.setAttribute("y2", (b.baseY - len).toFixed(2));
  });
}
function positionLogo(){
  const logo = document.querySelector(".home-top .logo-text");
  const homeTop = document.querySelector(".home-top");
  if (!logo || !homeTop) return;
  const homeTopRect = homeTop.getBoundingClientRect();
  // this used to be derived from the visualizer's own on-screen center,
  // back when the visualizer sat near the top of the screen too - now
  // that the visualizer has moved down to align with the artist photo,
  // the logo stays put by using that same original viewport-relative
  // anchor directly (15% down, -30) instead of tracking the canvas
  const targetCenterY = window.innerHeight * 0.15 - 30 - 12 + 8 - 20;
  logo.style.top = (targetCenterY - homeTopRect.top) + "px";
}
function positionArtistPhoto(){
  const photo = document.querySelector(".artist-photo-wrap");
  const controlsRow = document.querySelector(".controls-row");
  if (!photo || !controlsRow) return;
  // reset to the natural (un-offset) position first so the measurement
  // below reflects normal flow, not last frame's applied offset
  photo.style.top = "0px";
  const photoRect = photo.getBoundingClientRect();
  const controlsTop = controlsRow.getBoundingClientRect().top;
  // "full song device" (photo + wave visualiser + title pill, which all
  // anchor off this photo position) moved 40px up as one group
  const desiredBottom = controlsTop - 50;
  photo.style.top = (desiredBottom - photoRect.bottom) + "px";
}
function positionWaveCanvas(){
  const lyrics = $("#lyrics");
  const canvas = $("#wave-canvas");
  const metaRow = document.querySelector(".meta-row");
  const photo = document.querySelector(".artist-photo-wrap");
  if (!lyrics || !canvas || !metaRow || !photo) return;
  positionLogo();
  // photo has to be positioned first (60px above the controls row) -
  // the visualizer and the title pill both anchor to its live center
  positionArtistPhoto();
  const lyricsTop = lyrics.getBoundingClientRect().top;
  const baseHeight = Math.max(40, Math.min(80, lyricsTop * 0.5)) + 40;
  // the visualizer runs at 600% vertical size on every scene, but 800% on
  // the sphere screen specifically - the canvas grows but keeps its
  // resting baseline (at 65% of its height, see drawWaveCanvas) pinned to
  // the exact same on-screen spot, so all the extra swing extends upward
  const heightMul = document.body.classList.contains("scene-sphere") ? 8 : 6;
  const height = baseHeight * heightMul;
  const photoRect = photo.getBoundingClientRect();
  const centerY = photoRect.top + photoRect.height / 2;
  const canvasCenterY = centerY + 40 - 15 + 5 + 10 - 22 + 20; // visualiser (only) net 20px down from that
  const baselineY = (canvasCenterY - baseHeight / 2) + baseHeight * 0.65;
  const top = baselineY - height * 0.65;
  canvas.style.top = top + "px";
  canvas.style.height = height + "px";
  // net effect: title pill sits 30px lower than before, independent of
  // however far the photo (and centerY along with it) has moved
  metaRow.style.top = (centerY + 50) + "px"; // +20 more than before
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
}

const panoMat = new THREE.MeshBasicMaterial({ map: panoTexture, transparent: true, opacity: 1.0 });
// music-reactive glow: the patch surface farthest from the camera brightens
// toward white as the track gets louder, while the nearer surfaces around it
// dim slightly in response — uMinDist/uMaxDist are the real min/max vertex
// distance to the (fixed-position) camera, computed once per geometry build
const panoUniforms = {
  uIntensity: { value: 0 },
  uMinDist: { value: 0 },
  uMaxDist: { value: 1 },
  // 1 while the intro gate is up (starts on gate-active), 0 once dismissed;
  // neutralizes every post-effect below so the intro sphere shows raw
  uGate: { value: 1 },
};
panoMat.onBeforeCompile = shader => {
  shader.uniforms.uIntensity = panoUniforms.uIntensity;
  shader.uniforms.uMinDist = panoUniforms.uMinDist;
  shader.uniforms.uMaxDist = panoUniforms.uMaxDist;
  shader.uniforms.uGate = panoUniforms.uGate;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vPanoWorldPos;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPanoWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vPanoWorldPos;\nuniform float uIntensity;\nuniform float uMinDist;\nuniform float uMaxDist;\nuniform float uGate;')
    // option B: counter-warp the video's UVs before sampling, pulling the
    // pre-bulged edges back toward the center (a radial pincushion
    // correction) so the patch reads closer to the undistorted footage
    .replace('#include <map_fragment>', `
      vec2 aqaiUv = vUv - 0.5;
      float aqaiR2 = dot(aqaiUv, aqaiUv);
      aqaiUv *= (1.0 - 0.35 * aqaiR2);
      aqaiUv += 0.5;
      vec4 sampledDiffuseColor = texture2D( map, aqaiUv );
      diffuseColor *= sampledDiffuseColor;`)
    .replace('#include <dithering_fragment>', `#include <dithering_fragment>
      float panoDist = distance(vPanoWorldPos, cameraPosition);
      float panoFar = clamp((panoDist - uMinDist) / max(uMaxDist - uMinDist, 0.0001), 0.0, 1.0);
      float panoGlow = panoFar * uIntensity * 0.3;
      float panoDim = (1.0 - panoFar) * uIntensity * 0.15;
      // uFx = 1 on the music screen, 0 during the intro gate - every
      // post-effect below is lerped toward its no-op so the intro sphere
      // renders raw (no glow, dim, scanlines, vignette or darkening)
      float uFx = 1.0 - uGate;
      gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0), panoGlow * uFx);
      gl_FragColor.rgb *= (1.0 - panoDim * uFx);
      // VCR scanlines baked onto the curved surface itself (driven by the
      // patch's own UV, not screen space) so they bend with the curve —
      // vertical lines (driven by vUv.x, not vUv.y), tight spacing (high
      // frequency), a hard step edge for a crisp line; 75% more
      // transparent than fully-black (lets 75% of the original brightness
      // through instead of 0%)
      float aqaiScan = step(0.5, fract(vUv.x * 900.0));
      gl_FragColor.rgb *= mix(0.75, 1.0, aqaiScan); // scanlines apply on the intro sphere too
      // vignette baked into the video layer itself: a smooth, continuous
      // blend starting from full brightness at dead center all the way
      // out to the corners (aqaiR2 already holds the squared UV distance
      // from center, 0 at the middle up to ~0.5 at a corner)
      float aqaiVignette = clamp(1.0 - smoothstep(0.0, 0.5, aqaiR2) * 0.984375, 0.0, 1.0);
      gl_FragColor.rgb *= mix(aqaiVignette, 1.0, uGate);
      // overall sphere/background brightness on the music screen - less
      // heavily dimmed than before (was 0.49) so the video reads clearly
      // instead of muddy; the intro sphere is unused now (see tunnelGroup)
      // but its 0.2 dim is kept as-is in case uGate is ever driven again
      gl_FragColor.rgb *= mix(0.78, 0.2, uGate);`);
};
// a gently curved patch (not flat): a flat rectangle sized to the
// camera's native FOV crops during mouse-look (revealing an edge), and
// sized to the full look-around range instead feels zoomed in. Curving
// it keeps the surface facing the camera as it rotates, so the video
// always fills every edge at a natural scale without either problem.
const PANO_DISTANCE = 400; // radius of the curve, in front of the camera
const PANO_YAW_CENTER = Math.PI / 2; // rotates the patch to face the default camera direction
let panoMesh = null;
function computePanoDistRange(mesh){
  mesh.updateMatrixWorld(true);
  const pos = mesh.geometry.attributes.position;
  const v = new THREE.Vector3();
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < pos.count; i++){
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    const d = v.distanceTo(camera.position);
    if (d < min) min = d;
    if (d > max) max = d;
  }
  panoUniforms.uMinDist.value = min;
  panoUniforms.uMaxDist.value = max;
}
function buildPanoGeometry(aspect){
  // cover the camera's full look-around range (its own FOV plus the max
  // mouse-driven yaw/pitch, with a margin) so every edge stays filled at
  // any rotation, while keeping the video's own aspect ratio so it's
  // never stretched
  const vFovHalf = camera.fov * Math.PI / 360;
  const hFovHalf = Math.atan(Math.tan(vFovHalf) * camera.aspect);
  const margin = 0.15;
  const minPhi = (hFovHalf + 0.5 + margin) * 2;
  const minTheta = (vFovHalf + 0.35 + margin) * 2;
  let thetaLength = minTheta, phiLength = thetaLength * aspect;
  if (phiLength < minPhi){ phiLength = minPhi; thetaLength = phiLength / aspect; }
  phiLength = Math.min(phiLength, Math.PI * 1.9);
  thetaLength = Math.min(thetaLength, Math.PI * 0.95);
  // symmetric about the equator again - no more floor to cut it off at
  const geo = new THREE.SphereGeometry(
    PANO_DISTANCE, 60, 40,
    -phiLength / 2, phiLength,
    (Math.PI - thetaLength) / 2, thetaLength
  );
  geo.scale(-1, 1, 1);
  return geo;
}
// rotation applied to portrait clips/gifs, counter-clockwise — verified
// against the raw source footage with a side-by-side canvas.rotate() test
// (negative texture.rotation renders as counter-clockwise)
const PANO_PORTRAIT_ROTATION = -Math.PI / 2;
function rebuildPanoMesh(){
  const vw = currentPanoKind === "gif" ? panoGifImg.naturalWidth : panoVideoEl.videoWidth;
  const vh = currentPanoKind === "gif" ? panoGifImg.naturalHeight : panoVideoEl.videoHeight;
  const isPortrait = vw && vh && vh > vw;
  // portrait clips get spun 90° (via the texture's own UV rotation, no
  // re-encoding needed) so they read right-side-up; the patch itself is
  // then sized to the ROTATED (now-landscape) aspect so the rotated
  // footage fills it without stretching
  const tex = panoMat.map;
  tex.center.set(0.5, 0.5);
  tex.rotation = isPortrait ? PANO_PORTRAIT_ROTATION : 0;
  const aspect = vw && vh ? (isPortrait ? vh / vw : vw / vh) : 16 / 9;
  if (panoMesh){ scene.remove(panoMesh); panoMesh.geometry.dispose(); }
  panoMesh = new THREE.Mesh(buildPanoGeometry(aspect), panoMat);
  panoMesh.rotation.y = PANO_YAW_CENTER;
  // the sphere is reserved for the music screen - the intro shows the rock
  // tunnel instead (see tunnelGroup below), and the per-artist 3D worlds
  // (road/mist/maze - anything that sets body.scene-3d) replace it too,
  // so a video finishing its async load must never re-show it over them
  panoMesh.visible = !document.body.classList.contains("gate-active")
    && !document.body.classList.contains("scene-3d");
  scene.add(panoMesh);
  computePanoDistRange(panoMesh);
}

/* ---------- intro-only rock tunnel: replaces the sphere while the gate is
   up. A sequence of irregular ("rock") polygon rings extruded along -Z,
   with a black filled surface plus a wireframe overlay drawn from the
   geometry's real edges. Built from ONE randomized chunk of rings repeated
   back-to-back, so scrolling the whole group forward by exactly one
   chunk-length loops seamlessly without regenerating geometry every frame -
   see the tunnelGroup.position.z update in animate(). ---------- */
const TUNNEL_SIDES = 12;          // vertices per ring
const TUNNEL_CHUNK_RINGS = 18;    // rings in the one randomized, repeatable chunk
const TUNNEL_REPEATS = 3;         // how many times that chunk is tiled
const TUNNEL_RING_SPACING = 5;    // world units between rings
const TUNNEL_RADIUS_BASE = 4.5;
const TUNNEL_CHUNK_LENGTH = TUNNEL_CHUNK_RINGS * TUNNEL_RING_SPACING;
const TUNNEL_SPEED = -5.5; // world units/sec scrolled toward the camera ("flying backwards" through it) - reversed
// view-distance of the traveling light pulse that occasionally sweeps the
// tunnel from the far end toward the camera (driven in animate(); parked
// far negative = no pulse visible)
const tunnelPulseUniform = { value: -100 };
const TUNNEL_COLOR_CYCLE_RINGS = 9; // divides TUNNEL_CHUNK_RINGS evenly so the color band pattern loops seamlessly too
// white -> every artist accent color (mirrors ARTIST_COLORS in server.py) ->
// the app's default green -> back to white, so the wireframe cycles through
// "white to all the artist colors and also the green and white"
const TUNNEL_PALETTE = [
  "#FFFFFF", "#7ED957", "#FF8A73", "#FF8FDB", "#7FD6FF", "#FFC27A", "#9B72FF",
  "#1E90FF", "#FF7F27", "#8C6FFF", "#52C41A", "#FFD700", "#CBA378", "#AAAAAA",
  "#7CFF9E", "#FFFFFF",
].map((hex) => new THREE.Color(hex));
function tunnelColorForRing(ring, out){
  const u = (ring % TUNNEL_COLOR_CYCLE_RINGS) / TUNNEL_COLOR_CYCLE_RINGS;
  const scaled = u * (TUNNEL_PALETTE.length - 1);
  const i0 = Math.floor(scaled), i1 = Math.min(i0 + 1, TUNNEL_PALETTE.length - 1);
  return out.copy(TUNNEL_PALETTE[i0]).lerp(TUNNEL_PALETTE[i1], scaled - i0);
}
// same palette, dimmed down (was 0.14 - near-black; now a genuinely
// intense tinted surface) so the walls read as saturated color instead of
// almost-black, while the point light (see tunnelLight) standing in for
// the AQAI logo still has plenty of contrast to glint off of
function tunnelSurfaceColorForRing(ring, out){
  return tunnelColorForRing(ring, out).multiplyScalar(0.34);
}
// (re)colors any tunnel-derived geometry purely from each vertex's own z -
// every ring sits at an exact, recoverable z = -ring * TUNNEL_RING_SPACING,
// so this works even on geometries (EdgesGeometry, clones) that lost the
// original per-ring vertex order
function recolorTunnelGeometryByZ(geo, colorFn){
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const tmpColor = new THREE.Color();
  for (let i = 0; i < pos.count; i++){
    const ring = Math.round(-pos.getZ(i) / TUNNEL_RING_SPACING);
    colorFn(ring, tmpColor);
    colors[i * 3] = tmpColor.r; colors[i * 3 + 1] = tmpColor.g; colors[i * 3 + 2] = tmpColor.b;
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
}
// screen-space "fat line" mesh: turns each EdgesGeometry segment into a
// camera-facing ribbon quad of uLineWidth pixels wide, since plain
// THREE.LineBasicMaterial ignores its linewidth on virtually every modern
// GPU driver. uResolution is kept live via tunnelLineResolution (updated in
// resize()) so the pixel width stays correct across window sizes.
const tunnelLineResolution = new THREE.Vector2(1, 1);
function buildTunnelFatLineGeometry(edgesGeo){
  const src = edgesGeo.attributes.position;
  const segCount = src.count / 2;
  const positions = new Float32Array(segCount * 4 * 3);
  const others = new Float32Array(segCount * 4 * 3);
  const sides = new Float32Array(segCount * 4);
  const colors = new Float32Array(segCount * 4 * 3);
  const indices = [];
  const tmpColor = new THREE.Color();
  const put = (vi, px, py, pz, ox, oy, oz, side) => {
    positions[vi * 3] = px; positions[vi * 3 + 1] = py; positions[vi * 3 + 2] = pz;
    others[vi * 3] = ox; others[vi * 3 + 1] = oy; others[vi * 3 + 2] = oz;
    sides[vi] = side;
    tunnelColorForRing(Math.round(-pz / TUNNEL_RING_SPACING), tmpColor);
    colors[vi * 3] = tmpColor.r; colors[vi * 3 + 1] = tmpColor.g; colors[vi * 3 + 2] = tmpColor.b;
  };
  for (let s = 0; s < segCount; s++){
    const ax = src.getX(s * 2), ay = src.getY(s * 2), az = src.getZ(s * 2);
    const bx = src.getX(s * 2 + 1), by = src.getY(s * 2 + 1), bz = src.getZ(s * 2 + 1);
    const base = s * 4;
    put(base, ax, ay, az, bx, by, bz, -1);
    put(base + 1, ax, ay, az, bx, by, bz, 1);
    put(base + 2, bx, by, bz, ax, ay, az, -1);
    put(base + 3, bx, by, bz, ax, ay, az, 1);
    indices.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("aOther", new THREE.Float32BufferAttribute(others, 3));
  geo.setAttribute("aSide", new THREE.Float32BufferAttribute(sides, 1));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  return geo;
}
function buildTunnelFatLineMaterial(){
  return new THREE.ShaderMaterial({
    uniforms: { uResolution: { value: tunnelLineResolution }, uLineWidth: { value: 3.2 }, uTunnelPulse: tunnelPulseUniform },
    side: THREE.DoubleSide,
    vertexShader: `
      attribute vec3 aOther;
      attribute float aSide;
      attribute vec3 color;
      uniform vec2 uResolution;
      uniform float uLineWidth;
      varying vec3 vColor;
      varying float vTunnelFadeDist;
      // identical proximity-grow math to applyTunnelProximityGrow() below,
      // kept in sync by hand since this material isn't a built-in one
      vec3 tunnelGrow( vec3 p, vec4 mv ){
        float dist = -mv.z;
        float amt = smoothstep( 42.0, 3.0, dist ) * 0.28;
        p.xy *= ( 1.0 + amt );
        return p;
      }
      void main(){
        vColor = color;
        vec4 mvSelf = modelViewMatrix * vec4( position, 1.0 );
        vTunnelFadeDist = -mvSelf.z;
        vec4 mvOther = modelViewMatrix * vec4( aOther, 1.0 );
        vec4 clipSelf = projectionMatrix * modelViewMatrix * vec4( tunnelGrow( position, mvSelf ), 1.0 );
        vec4 clipOther = projectionMatrix * modelViewMatrix * vec4( tunnelGrow( aOther, mvOther ), 1.0 );
        vec2 screenSelf = clipSelf.xy / clipSelf.w * uResolution;
        vec2 screenOther = clipOther.xy / clipOther.w * uResolution;
        vec2 dir = normalize( screenOther - screenSelf + 1e-4 );
        vec2 normal = vec2( -dir.y, dir.x );
        vec2 offsetPx = normal * ( uLineWidth * 0.5 ) * aSide;
        clipSelf.xy += ( offsetPx / uResolution ) * clipSelf.w;
        gl_Position = clipSelf;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vTunnelFadeDist;
      uniform float uTunnelPulse;
      void main(){
        // same distance fade as applyTunnelProximityGrow(): the deeper
        // into the tunnel, the darker AND more transparent it gets
        float tunnelFade = 1.0 - smoothstep( 35.0, 130.0, vTunnelFadeDist );
        // and the same traveling back-to-front light pulse
        float tunnelPulseGlow = exp( -pow( ( vTunnelFadeDist - uTunnelPulse ) * 0.09, 2.0 ) );
        gl_FragColor = vec4( vColor * tunnelFade * ( 1.0 + tunnelPulseGlow * 1.5 ),
          min( 1.0, tunnelFade * ( 1.0 + tunnelPulseGlow ) ) );
      }
    `,
    transparent: true,
  });
}
// grows the tunnel walls (and, via the same injection on the line/point
// materials, the wireframe + connection dots) outward the closer they get
// to the camera, and fades everything out with depth - the further down
// the tunnel a fragment sits, the darker and more transparent it renders,
// so the far end dissolves into the dark. Purely a function of the live
// modelViewMatrix, so it tracks the scroll/rotation already applied to
// tunnelGroup with no extra per-frame JS work needed
function applyTunnelProximityGrow(material){
  material.transparent = true;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTunnelPulse = tunnelPulseUniform;
    shader.vertexShader = "varying float vTunnelFadeDist;\n" + shader.vertexShader
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vec4 tGrowMv = modelViewMatrix * vec4( transformed, 1.0 );
        float tGrowDist = -tGrowMv.z;
        vTunnelFadeDist = tGrowDist;
        float tGrowAmt = smoothstep( 42.0, 3.0, tGrowDist ) * 0.28;
        transformed.xy *= ( 1.0 + tGrowAmt );`
      );
    shader.fragmentShader = "varying float vTunnelFadeDist;\nuniform float uTunnelPulse;\n" + shader.fragmentShader
      .replace(
        "#include <fog_fragment>",
        `#include <fog_fragment>
        float tunnelFade = 1.0 - smoothstep( 35.0, 130.0, vTunnelFadeDist );
        // traveling light band: fragments near the pulse's current
        // distance flash up as it sweeps from the deep end to the camera
        float tunnelPulseGlow = exp( -pow( ( vTunnelFadeDist - uTunnelPulse ) * 0.09, 2.0 ) );
        gl_FragColor.rgb *= tunnelFade * ( 1.0 + tunnelPulseGlow * 1.5 );
        gl_FragColor.a *= min( 1.0, tunnelFade * ( 1.0 + tunnelPulseGlow ) );`
      );
  };
}
function buildTunnelGeometry(){
  const totalRings = TUNNEL_CHUNK_RINGS * TUNNEL_REPEATS;
  // one chunk's per-ring, per-vertex radii: a slow sinusoidal bulge/pinch
  // along the chunk's length, plus per-vertex jagged noise (varying
  // independently per angular direction v) for the "rock" irregularity -
  // the cross-section is uneven in every direction without the tube's own
  // axis ever drifting off it. The axis is intentionally kept pinned to
  // x=0,y=0 - the AQAI logo's own axis - the whole tunnel stays centered on
  // it (and therefore on the camera) rather than carrying its own x/y
  // position, so the camera never ends up outside the tunnel wall.
  const chunkRadii = [];
  for (let r = 0; r < TUNNEL_CHUNK_RINGS; r++){
    const wobble = Math.sin(r * 0.55) * 1.6 + Math.sin(r * 1.3 + 1) * 0.7;
    const radii = [];
    for (let v = 0; v < TUNNEL_SIDES; v++){
      const jag = Math.sin(r * 2.1 + v * 1.7) * 0.6 + (Math.random() - 0.5) * 1.1;
      radii.push(Math.max(1.8, TUNNEL_RADIUS_BASE + wobble + jag));
    }
    chunkRadii.push(radii);
  }
  const positions = [];
  const colors = [];
  const tmpColor = new THREE.Color();
  for (let ring = 0; ring < totalRings; ring++){
    const radii = chunkRadii[ring % TUNNEL_CHUNK_RINGS];
    const z = -ring * TUNNEL_RING_SPACING;
    tunnelColorForRing(ring, tmpColor);
    for (let v = 0; v < TUNNEL_SIDES; v++){
      const theta = (v / TUNNEL_SIDES) * Math.PI * 2;
      positions.push(Math.cos(theta) * radii[v], Math.sin(theta) * radii[v], z);
      colors.push(tmpColor.r, tmpColor.g, tmpColor.b);
    }
  }
  const indices = [];
  for (let ring = 0; ring < totalRings - 1; ring++){
    for (let v = 0; v < TUNNEL_SIDES; v++){
      const a = ring * TUNNEL_SIDES + v;
      const b = ring * TUNNEL_SIDES + (v + 1) % TUNNEL_SIDES;
      const c = (ring + 1) * TUNNEL_SIDES + v;
      const d = (ring + 1) * TUNNEL_SIDES + (v + 1) % TUNNEL_SIDES;
      indices.push(a, b, c, b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}
const tunnelGroup = new THREE.Group();
{
  const tunnelGeo = buildTunnelGeometry();

  // surface: dark, artist-color-tinted, specular/reflective so the light
  // standing in for the AQAI logo (see tunnelLight below) glints off it
  const surfaceGeo = tunnelGeo.clone();
  recolorTunnelGeometryByZ(surfaceGeo, tunnelSurfaceColorForRing);
  const tunnelSurfMat = new THREE.MeshPhongMaterial({
    color: 0xffffff, vertexColors: true,
    // dim grey specular + low shininess = a broad, diffuse sheen across the
    // rock faces instead of hard white glints
    specular: 0x555555, shininess: 12, flatShading: true, side: THREE.DoubleSide,
  });
  applyTunnelProximityGrow(tunnelSurfMat);
  tunnelGroup.add(new THREE.Mesh(surfaceGeo, tunnelSurfMat));

  // wireframe: thick, camera-facing colored ribbons (see buildTunnelFatLineMaterial)
  const tunnelEdgesGeo = new THREE.EdgesGeometry(tunnelGeo, 8);
  const tunnelLineGeo = buildTunnelFatLineGeometry(tunnelEdgesGeo);
  tunnelEdgesGeo.dispose();
  tunnelGroup.add(new THREE.Mesh(tunnelLineGeo, buildTunnelFatLineMaterial()));

  // little dots marking every point where the wireframe lines/surfaces meet
  const tunnelDotsGeo = new THREE.BufferGeometry();
  tunnelDotsGeo.setAttribute("position", tunnelGeo.getAttribute("position").clone());
  tunnelDotsGeo.setAttribute("color", tunnelGeo.getAttribute("color").clone());
  const tunnelDotsMat = new THREE.PointsMaterial({ size: 0.16, vertexColors: true, sizeAttenuation: true });
  applyTunnelProximityGrow(tunnelDotsMat);
  tunnelGroup.add(new THREE.Points(tunnelDotsGeo, tunnelDotsMat));
}
tunnelGroup.visible = document.body.classList.contains("gate-active");
scene.add(tunnelGroup);
// stands in for "the AQAI logo is the lightsource" - parked at the camera/
// logo's shared position (not inside tunnelGroup, so it doesn't spin with
// the tunnel), close enough that its falloff still reads as darkness further
// down the tunnel
const tunnelLight = new THREE.PointLight(0xffffff, 2.4, 70, 2);
tunnelLight.position.set(0, 0, 7.5);
tunnelLight.visible = document.body.classList.contains("gate-active");
scene.add(tunnelLight);

/* ---------- Polaroid-only outrun world: replaces the sphere (never the
   intro tunnel, which always wins during the gate) whenever the current
   track's artist is ROAD_ARTIST_NAME. A deep-purple night: wireframe
   terrain ridges with glowing 1-3px node dots on both sides of a valley,
   a narrow solid road (no line markings) that rolls over hills and bends
   left/right through the valley, circular stars streaming from the back
   of the scene toward the camera, and a drone camera that follows the
   road while sweeping left/right/up/down and rotating into every curve.
   Terrain+road scroll toward the camera with the same seamless
   chunk-tiling trick as the tunnel. ---------- */
const ROAD_ARTIST_NAME = "Polaroid";
const ROAD_CHUNK_LENGTH = 220;  // world units of one seamlessly-tiling terrain strip
const ROAD_REPEATS = 3;
const ROAD_SPEED = 9;
const ROAD_HALF_WIDTH = 2.5;    // road corridor half-width (50% of the old road)
const ROAD_CAM_HEIGHT = 4.6;    // comfortably above the road at all times
const ROAD_COLS = 18;           // terrain grid resolution across (x) - deliberately coarse
const ROAD_ROWS = 22;           // terrain grid rows per chunk (z) - deliberately coarse
const ROAD_STRIP_ROWS = 88;     // the road ribbon itself stays 2x-detailed (its own row count)
// palette lifted from the reference art
const ROAD_TEAL = new THREE.Color(0x35e0c8);
const ROAD_PURPLE = new THREE.Color(0x8a4fff);
// the road's centerline: bends left/right (x) and rolls over hills (y).
// Integer multiples of the chunk period, so every repeat tiles seamlessly
// and it can be sampled continuously for the drone camera in animate()
function roadCenterAt(dist){
  const a = (dist / ROAD_CHUNK_LENGTH) * Math.PI * 2;
  return {
    x: Math.sin(a * 2) * 7 + Math.sin(a * 5 + 1) * 2.5,
    y: Math.sin(a * 3) * 3.2 + Math.sin(a + 2) * 4.5,
  };
}
const ROAD_SEG = ROAD_CHUNK_LENGTH / ROAD_ROWS;
const ROAD_STRIP_SEG = ROAD_CHUNK_LENGTH / ROAD_STRIP_ROWS;
// deterministic per-vertex jitter, periodic across chunk repeats because
// it's keyed on (col, row-within-chunk) rather than absolute position
function roadHash(ix, iz){
  const s = Math.sin(ix * 127.1 + (iz % ROAD_ROWS) * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
// terrain height above the road's own rolling baseline: flat through the
// corridor around the (curving) centerline, ridges building up outside it
function roadTerrainHeight(xFromCenter, iz){
  const corridor = Math.max(0, Math.abs(xFromCenter) - ROAD_HALF_WIDTH - 2.5);
  if (corridor === 0) return 0;
  const a = ((iz % ROAD_ROWS) / ROAD_ROWS) * Math.PI * 2;
  const ridge = 0.75
    + Math.sin(a * 3 + xFromCenter * 0.11) * 0.3
    + Math.sin(a * 7 + xFromCenter * 0.05) * 0.18
    + roadHash(Math.round(xFromCenter * 2), iz) * 0.45;
  return Math.min(30, corridor * 0.62 * ridge);
}
// soft round sprite shared by every glowing dot/star, so points render as
// circles instead of the default hard squares
const roadDotTexture = (() => {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 64;
  const cx = cv.getContext("2d");
  const g = cx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.45, "rgba(255,255,255,0.7)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  cx.fillStyle = g;
  cx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
})();
// wireframe terrain: a dark solid surface (occludes lines behind ridges),
// glowing grid lines over it, and a glowing 1-3px node dot at every
// vertex; the whole grid is displaced to follow the road's curving,
// rolling centerline so the valley always hugs the road
function buildRoadTerrain(group){
  const totalRows = ROAD_ROWS * ROAD_REPEATS;
  const xAt = c => (c / (ROAD_COLS - 1) - 0.5) * 170;
  const vertRel = [], vertPos = [];
  for (let r = 0; r <= totalRows; r++){
    const center = roadCenterAt(r * ROAD_SEG);
    for (let c = 0; c < ROAD_COLS; c++){
      const xRel = xAt(c);
      const h = roadTerrainHeight(xRel, r);
      vertRel.push(h);
      vertPos.push(center.x + xRel, center.y - 0.35 + h, -r * ROAD_SEG);
    }
  }
  const vi = (r, c) => r * ROAD_COLS + c;
  // solid underlay
  const solidIdx = [];
  for (let r = 0; r < totalRows; r++){
    for (let c = 0; c < ROAD_COLS - 1; c++){
      const a = vi(r, c), b = vi(r, c + 1), d = vi(r + 1, c), e = vi(r + 1, c + 1);
      solidIdx.push(a, d, b, b, d, e);
    }
  }
  const solidGeo = new THREE.BufferGeometry();
  solidGeo.setAttribute("position", new THREE.Float32BufferAttribute(vertPos, 3));
  solidGeo.setIndex(solidIdx);
  group.add(new THREE.Mesh(solidGeo, new THREE.MeshBasicMaterial({ color: 0x140823, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })));
  // grid lines, colored teal on the heights fading toward purple low
  const linePos = [], lineCol = [];
  const tmpColor = new THREE.Color();
  const pushVert = (r, c) => {
    const i = vi(r, c);
    linePos.push(vertPos[i * 3], vertPos[i * 3 + 1], vertPos[i * 3 + 2]);
    tmpColor.copy(ROAD_PURPLE).lerp(ROAD_TEAL, Math.min(1, vertRel[i] / 14));
    lineCol.push(tmpColor.r, tmpColor.g, tmpColor.b);
  };
  for (let r = 0; r <= totalRows; r++) for (let c = 0; c < ROAD_COLS - 1; c++){ pushVert(r, c); pushVert(r, c + 1); }
  for (let c = 0; c < ROAD_COLS; c++) for (let r = 0; r < totalRows; r++){ pushVert(r, c); pushVert(r + 1, c); }
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute("position", new THREE.Float32BufferAttribute(linePos, 3));
  lineGeo.setAttribute("color", new THREE.Float32BufferAttribute(lineCol, 3));
  group.add(new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.65 })));
  // glowing node dots: every vertex hashed into a 1px/2px/3px bucket
  // (sizeAttenuation off = true screen pixels), additive round sprites
  const dotBuckets = [[], [], []];
  for (let i = 0; i < vertPos.length / 3; i++){
    dotBuckets[Math.floor(roadHash(i, i * 7) * 3) % 3].push(vertPos[i * 3], vertPos[i * 3 + 1], vertPos[i * 3 + 2]);
  }
  dotBuckets.forEach((positions, bi) => {
    if (!positions.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    group.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xeafffa, size: bi + 1, sizeAttenuation: false,
      map: roadDotTexture, transparent: true, opacity: 0.72, blending: THREE.AdditiveBlending, depthWrite: false })));
  });
}
// the road itself: a narrow solid ribbon (no line markings at all) that
// follows the same curving/rolling centerline as the terrain valley. Its
// color sweeps artist-color -> blue -> artist-color along the length (one
// full cycle per chunk, so the gradient loops seamlessly with the
// scroll); retintRoadStrip() rewrites the vertex colors once the current
// track's real artistColor is known
let roadStripGeo = null;
let roadStripMat = null;
function retintRoadStrip(artistColor){
  if (!roadStripGeo) return;
  const totalRows = ROAD_STRIP_ROWS * ROAD_REPEATS;
  // darker, moodier ends of the sweep (whole-scene darkening pass)
  const cA = new THREE.Color(artistColor || "#7ED957").multiplyScalar(0.42);
  const cB = new THREE.Color(0x2d5bd8).multiplyScalar(0.55);
  const attr = roadStripGeo.attributes.color;
  const tmpColor = new THREE.Color();
  for (let r = 0; r <= totalRows; r++){
    const a = ((r % ROAD_STRIP_ROWS) / ROAD_STRIP_ROWS) * Math.PI * 2;
    tmpColor.copy(cA).lerp(cB, (Math.sin(a) + 1) / 2);
    attr.setXYZ(r * 2, tmpColor.r, tmpColor.g, tmpColor.b);
    attr.setXYZ(r * 2 + 1, tmpColor.r, tmpColor.g, tmpColor.b);
  }
  attr.needsUpdate = true;
}
function buildRoadStrip(group){
  // the ribbon keeps its own fine row resolution, independent of the
  // (much coarser) terrain grid
  const totalRows = ROAD_STRIP_ROWS * ROAD_REPEATS;
  const positions = [];
  for (let r = 0; r <= totalRows; r++){
    const center = roadCenterAt(r * ROAD_STRIP_SEG);
    const z = -r * ROAD_STRIP_SEG;
    positions.push(center.x - ROAD_HALF_WIDTH, center.y, z, center.x + ROAD_HALF_WIDTH, center.y, z);
  }
  const indices = [];
  for (let r = 0; r < totalRows; r++){
    const a = r * 2, b = r * 2 + 1, c = (r + 1) * 2, d = (r + 1) * 2 + 1;
    indices.push(a, c, b, b, c, d);
  }
  roadStripGeo = new THREE.BufferGeometry();
  roadStripGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  roadStripGeo.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array((totalRows + 1) * 6), 3));
  roadStripGeo.setIndex(indices);
  // material kept as a named ref: its color multiplies the vertex-color
  // gradient, and animate() drives it 1.0 -> 1.25 with the music level
  roadStripMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  group.add(new THREE.Mesh(roadStripGeo, roadStripMat));
  retintRoadStrip("#7ED957"); // sensible default until a track is active
}
// little glowing red balls hovering over the road edge, each "casting"
// light as an additive radial pool on the road surface beneath it (the
// road is unlit MeshBasic, so the pool fakes the light falloff). Placed
// per chunk and tiled, so they scroll and wrap with the road seamlessly.
const roadPoolTexture = (() => {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 128;
  const cx = cv.getContext("2d");
  // soft, diffuse pool - low peak alpha and a long falloff so it reads as
  // cast light spreading over the road, not a hot spot
  const g = cx.createRadialGradient(64, 64, 2, 64, 64, 62);
  g.addColorStop(0, "rgba(255,80,66,0.5)");
  g.addColorStop(0.35, "rgba(255,60,52,0.22)");
  g.addColorStop(0.7, "rgba(255,55,50,0.08)");
  g.addColorStop(1, "rgba(255,50,50,0)");
  cx.fillStyle = g;
  cx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(cv);
})();
const roadBallPulses = []; // {ball, pool, phase} - gentle pulse in animate()
const roadBallMat = new THREE.MeshBasicMaterial({ color: 0xff4038 }); // always red
function buildRoadBalls(group){
  const ballGeo = new THREE.SphereGeometry(0.26, 12, 10);
  const ballMat = roadBallMat;
  const poolMat = new THREE.MeshBasicMaterial({ map: roadPoolTexture, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false });
  const poolGeo = new THREE.PlaneGeometry(9, 9);
  poolGeo.rotateX(-Math.PI / 2);
  const PER_CHUNK = 9;
  for (let rep = 0; rep < ROAD_REPEATS; rep++){
    for (let i = 0; i < PER_CHUNK; i++){
      const d = roadHash(i * 13, i * 29) * ROAD_CHUNK_LENGTH;
      const center = roadCenterAt(d);
      const side = (i % 2 === 0 ? 1 : -1) * (ROAD_HALF_WIDTH - 0.6);
      const z = -(d + rep * ROAD_CHUNK_LENGTH);
      const ball = new THREE.Mesh(ballGeo, ballMat);
      ball.position.set(center.x + side, center.y + 1.1, z);
      // stay rendered until genuinely behind the camera, instead of
      // popping out the moment the bounding sphere leaves the frustum
      ball.frustumCulled = false;
      group.add(ball);
      const pool = new THREE.Mesh(poolGeo, poolMat);
      pool.position.set(center.x + side, center.y + 0.04, z);
      pool.frustumCulled = false;
      group.add(pool);
      roadBallPulses.push({ ball, pool, phase: roadHash(i * 7, i * 3) * Math.PI * 2 });
    }
  }
}
// starfield of round glowing dots streaming from the far back toward the
// camera: two identical tiles deep, scrolled forward and wrapped by one
// tile length in animate() so the stream never shows a seam
const ROAD_STAR_DEPTH = 400;
const ROAD_STAR_SPEED = 16;
function buildRoadStars(){
  const blues = [0x66c8ff, 0xffffff, 0x9be8ff, 0xffd2e8].map(c => new THREE.Color(c));
  const group = new THREE.Group();
  [1.5, 2.5, 4].forEach((size, si) => {
    const positions = [], colors = [];
    const perTile = si === 2 ? 14 : 170;
    for (let tile = 0; tile < 2; tile++){
      for (let i = 0; i < perTile; i++){
        // one template per tile index, so tile 2 is an exact copy of tile
        // 1 shifted a tile deeper - required for the seamless scroll wrap
        const h1 = roadHash(i * 3 + si * 97, i), h2 = roadHash(i * 5 + si * 31, i * 2), h3 = roadHash(i * 7 + si * 53, i * 3);
        positions.push((h1 - 0.5) * 700, h2 * 300 - 20, -(h3 * ROAD_STAR_DEPTH) - tile * ROAD_STAR_DEPTH);
        const c = blues[i % blues.length];
        colors.push(c.r, c.g, c.b);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({ size, vertexColors: true, sizeAttenuation: false, map: roadDotTexture,
      transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
    mat.fog = false;
    group.add(new THREE.Points(geo, mat));
  });
  return group;
}
// slow-bobbing translucent spheres drifting above the valley - purely
// atmospheric; their y animates in the road branch of animate()
const roadFloaters = [];
function buildRoadFloaters(group){
  const sphereGeo = new THREE.SphereGeometry(1, 16, 12);
  // outline-only spheres: the inner mesh writes depth but no color (an
  // invisible occluder), so the slightly-larger back-face shell shows as
  // just a thin silhouette ring in the ball's color - no fill at all
  const rgb = [0xff4455, 0x3fe07a, 0x3f7aff];
  const occluderMat = new THREE.MeshBasicMaterial({ colorWrite: false });
  const outlineMats = rgb.map(c => new THREE.MeshBasicMaterial({ color: c,
    side: THREE.BackSide, transparent: true, opacity: 0.95, depthWrite: false }));
  const PER_CHUNK = 10;
  for (let rep = 0; rep < ROAD_REPEATS; rep++){
    for (let i = 0; i < PER_CHUNK; i++){
      const d = roadHash(i * 17, i * 41) * ROAD_CHUNK_LENGTH;
      const center = roadCenterAt(d);
      // anywhere from hugging the road edge to far out over the terrain
      const side = (i % 2 === 0 ? 1 : -1) * (3 + roadHash(i, 3) * 30);
      const s = new THREE.Mesh(sphereGeo, occluderMat);
      // per-sphere clone so each one can fade in/out independently
      const outline = new THREE.Mesh(sphereGeo, outlineMats[i % 3].clone());
      outline.scale.setScalar(1.025); // thin shell = ~1px rim at typical distance
      s.add(outline);
      s.scale.setScalar(0.5 + roadHash(i, 5) * 2.8); // wide size spread
      // start ABOVE the local terrain surface (the ridges rise well over
      // the road level away from the corridor), never buried inside it
      const groundY = center.y - 0.35 + roadTerrainHeight(side, Math.round(d / ROAD_SEG));
      s.position.set(center.x + side, groundY + 1.2, -(d + rep * ROAD_CHUNK_LENGTH));
      // rises from just above the field, easing in (slow lift-off, then
      // accelerating upward); fades in at the bottom and out at the top of
      // each cycle so it never pops - see the roadFloaters update in animate()
      s.userData.outlineMat = outline.material;
      s.userData.startY = groundY + 1.2;
      s.userData.rise = 12 + roadHash(i, 7) * 8;    // taller travel: visibly climbing while on screen
      s.userData.period = 10 + roadHash(i, 9) * 8;  // seconds per full rise - brisk enough to read as motion
      s.userData.phase = roadHash(i, 11);
      s.frustumCulled = false;
      group.add(s);
      roadFloaters.push(s);
    }
  }
}
const roadGroup = new THREE.Group();
buildRoadTerrain(roadGroup);
buildRoadStrip(roadGroup);
buildRoadBalls(roadGroup);
buildRoadFloaters(roadGroup);
roadGroup.visible = false; // only ever shown post-gate, and only for ROAD_ARTIST_NAME - see updateArtistBackground()
scene.add(roadGroup);
// the streaming star sky lives outside roadGroup: it scrolls on its own
// (different speed/wrap length than the terrain)
const roadScenery = new THREE.Group();
const roadStars = buildRoadStars();
roadScenery.add(roadStars);
roadScenery.visible = false;
scene.add(roadScenery);
// gentle purple haze melting the far terrain into the night
const roadFog = new THREE.FogExp2(0x101334, 0.00416); // 20% less dense (less dark)
const roadClearColor = new THREE.Color();
// trailing-follow state for the drone camera - everything lerps toward
// freshly-sampled road targets, so the flight reads as elegant sweeps
// rather than a rigid rail ride
let roadCamX = 0, roadCamY = ROAD_CAM_HEIGHT, roadCamYaw = 0, roadCamPitch = 0, roadCamBank = 0;

/* ---------- Aveluna-only cloud world: a slow, endless drone flight over
   a field of dreamlike clouds, modeled on the reference art - puffy coral/
   pink masses with warm orange-yellow glowing cores, mint and periwinkle
   undersides, all under a deep indigo night sky. Each cloud is a cluster
   of soft round billboard sprites (radial-gradient canvas texture); the
   field is generated once per chunk and tiled, then scrolled and wrapped
   exactly like the road/tunnel so the flight loops forever without a
   seam. ---------- */
const MIST_ARTIST_NAME = "Aveluna";
const MIST_CHUNK_LENGTH = 240;
const MIST_REPEATS = 3;
const MIST_SPEED = 16; // brisk - clouds stream visibly past the camera
const MIST_SKY = new THREE.Color(0x241d5c); // the reference's deep indigo
// soft round puff - the one texture every cloud sprite shares
const mistPuffTexture = (() => {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 128;
  const cx = cv.getContext("2d");
  // a readable transparent DISC (near-flat alpha with a short soft rim),
  // not a fuzzy blob - the cloud field reads as overlapping circles
  const g = cx.createRadialGradient(64, 64, 6, 64, 64, 62);
  g.addColorStop(0, "rgba(255,255,255,0.95)");
  g.addColorStop(0.72, "rgba(255,255,255,0.88)");
  g.addColorStop(0.88, "rgba(255,255,255,0.3)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  cx.fillStyle = g;
  cx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(cv);
})();
// reference palette: coral/pink tops, warm glowing cores, cool undersides.
// Dimmed hard, because the puffs blend additively and stack up toward
// bright - these read as a dark, moody glow rather than pastel
// (dimmed very hard: the huge puffs overlap massively, and additive
// stacking would otherwise blow out to pure white)
const MIST_TOPS = [0xff9a8a, 0xffa8c0, 0xf5a087].map(c => new THREE.Color(c).multiplyScalar(0.065));
const MIST_CORES = [0xffc25e, 0xffdd7a, 0xff9a5e].map(c => new THREE.Color(c).multiplyScalar(0.075));
const MIST_UNDER = [0x7de8c8, 0x9aa8ff, 0x86c8f0, 0xb49aff].map(c => new THREE.Color(c).multiplyScalar(0.055));
const mistGroup = new THREE.Group();
const mistReactiveMats = []; // ball-flock materials that pulse with the music
const mistAllMats = []; // every flock material, reactive or not - see the scene-entry fade-in in animate()
let mistFadeStartMs = 0;
const mistOrbitPoints = []; // Points objects whose circles orbit their flock's center - see animate()
{
  // hash-driven template (no Math.random) so every tile is an exact copy -
  // that's what makes the scroll wrap invisible and the flight endless.
  // The scene is a starfield we fly through (small round Points in two
  // pixel-size classes - the proven pipeline) plus a field of translucent
  // balls (real spheres at 0.4 opacity) in the same palette.
  const h = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
  // stars, tiled per chunk so they stream and wrap with the scene. Tiles
  // run from +1 chunk BEHIND the camera (rep -1) through the far distance,
  // so the slow gaze-wander can look fully backward and still find sky -
  // the field never visibly resets or runs out in any direction
  const starPalette = [0xffffff, 0x9be8ff, 0xffd2e8, 0xc9b8ff].map(c => new THREE.Color(c));
  const whiteOnly = [new THREE.Color(0xffffff)];
  // third class: a dense pure-white population (4x the white stars)
  [[320, 1.5, starPalette], [48, 3.5, starPalette], [960, 1.6, whiteOnly]].forEach(([count, size, palette], si) => {
    const positions = [], colors = [];
    for (let rep = -1; rep < MIST_REPEATS; rep++){
      for (let i = 0; i < count; i++){
        positions.push((h(i * 3 + si * 97, i) - 0.5) * 700, (h(i * 5 + si * 31, i * 2) - 0.5) * 300,
          -h(i * 7 + si * 53, i * 3) * MIST_CHUNK_LENGTH - rep * MIST_CHUNK_LENGTH);
        const c = palette[i % palette.length];
        colors.push(c.r, c.g, c.b);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({ size, vertexColors: true, sizeAttenuation: false, map: roadDotTexture,
      transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
    mat.fog = false;
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    mistGroup.add(points);
  });
  // the ball field: soft BLURRED balls (wide-falloff radial sprite via
  // Points, world-sized) gathered into little flocks - each flock a
  // handful of balls in mixed sizes and colors
  const mistBallTexture = (() => {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 128;
    const cx = cv.getContext("2d");
    // soft but with a firmer core - blurred only at the rim
    const g = cx.createRadialGradient(64, 64, 2, 64, 64, 62);
    g.addColorStop(0, "rgba(255,255,255,0.9)");
    g.addColorStop(0.55, "rgba(255,255,255,0.68)");
    g.addColorStop(0.85, "rgba(255,255,255,0.2)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    cx.fillStyle = g;
    cx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(cv);
  })();
  const flockPalette = [0xff9a8a, 0xffa8c0, 0x7de8c8, 0x9aa8ff, 0x86c8f0, 0xffc25e]
    .map(c => new THREE.Color(c).multiplyScalar(0.55)); // dimmed against additive stacking
  // two parallel bucket sets: normal flocks, and "reactive" flocks whose
  // size/brightness pulse with the music (see the mist branch in animate())
  const mkBuckets = () => [
    { size: 3, positions: [], colors: [], cx: [], cy: [], cz: [], r: [], phase: [], speed: [] },
    { size: 6, positions: [], colors: [], cx: [], cy: [], cz: [], r: [], phase: [], speed: [] },
    { size: 10, positions: [], colors: [], cx: [], cy: [], cz: [], r: [], phase: [], speed: [] },
    { size: 16, positions: [], colors: [], cx: [], cy: [], cz: [], r: [], phase: [], speed: [] },
    { size: 48, positions: [], colors: [], cx: [], cy: [], cz: [], r: [], phase: [], speed: [] }, // the occasional 3x jumbo circle
  ];
  const ballBuckets = mkBuckets(), reactiveBuckets = mkBuckets();
  const FLOCKS = 88; // 4x more
  for (let rep = -1; rep < MIST_REPEATS; rep++){ // rep -1: coverage behind the camera too
    for (let fi = 0; fi < FLOCKS; fi++){
      const fx = (h(fi, 1) - 0.5) * 500;
      const fy = (h(fi, 2) - 0.5) * 180;
      const fz = -h(fi, 3) * MIST_CHUNK_LENGTH - rep * MIST_CHUNK_LENGTH;
      const count = 16 + Math.floor(h(fi, 4) * 18);
      const reactive = h(fi, 9) < 0.25; // about a quarter of the flocks follow the music
      const set = reactive ? reactiveBuckets : ballBuckets;
      for (let bi = 0; bi < count; bi++){
        const pick = h(fi * 41 + bi, 5);
        // ~7% of a flock's circles are the 3x jumbos
        const bucket = pick < 0.07 ? set[4] : set[Math.floor(pick * 4) % 4];
        // tight grouping - the flock reads as one huddled cluster. Each
        // circle's own starting offset from the flock center becomes its
        // orbit radius/phase, so it now slowly circles that same center
        // (see animate()) instead of sitting frozen in place
        const dx = (h(fi * 41 + bi, 6) - 0.5) * 14;
        const dy = (h(fi * 41 + bi, 7) - 0.5) * 11;
        const dz = (h(fi * 41 + bi, 8) - 0.5) * 14;
        bucket.positions.push(fx + dx, fy + dy, fz + dz);
        bucket.cx.push(fx); bucket.cy.push(fy + dy); bucket.cz.push(fz);
        bucket.r.push(Math.hypot(dx, dz));
        bucket.phase.push(Math.atan2(dz, dx));
        // slow, and varied per circle - different circles in the same
        // flock drift around the center at different (still slow) speeds -
        // 3x slower again per request
        bucket.speed.push((0.025 + h(fi * 41 + bi, 17) * 0.05) / 3);
        const c = flockPalette[(fi + bi) % flockPalette.length];
        bucket.colors.push(c.r, c.g, c.b);
      }
    }
  }
  const buildBucketPoints = (b, reactive) => {
    if (!b.positions.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(b.positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(b.colors, 3));
    const mat = new THREE.PointsMaterial({ size: b.size, sizeAttenuation: true,
      map: mistBallTexture, vertexColors: true, transparent: true, opacity: 0.45,
      blending: THREE.AdditiveBlending, depthWrite: false });
    mat.userData.baseOpacity = 0.45; // reactive mats overwrite this every frame; both get multiplied by the scene-entry fade-in
    if (reactive){
      mat.userData.baseSize = b.size;
      mistReactiveMats.push(mat);
    }
    mistAllMats.push(mat);
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.userData.orbitCX = new Float32Array(b.cx);
    points.userData.orbitCY = new Float32Array(b.cy);
    points.userData.orbitCZ = new Float32Array(b.cz);
    points.userData.orbitR = new Float32Array(b.r);
    points.userData.orbitPhase = new Float32Array(b.phase);
    points.userData.orbitSpeed = new Float32Array(b.speed);
    mistGroup.add(points);
    mistOrbitPoints.push(points);
  };
  ballBuckets.forEach(b => buildBucketPoints(b, false));
  reactiveBuckets.forEach(b => buildBucketPoints(b, true));
}
mistGroup.visible = false;
scene.add(mistGroup);
// indigo haze so the far clouds sink into the night sky
const mistFog = new THREE.FogExp2(0x241d5c, 0.006);
const mistColor = new THREE.Color();
// invisible flight path through the cloud field - same integer-multiple
// periodic construction as roadCenterAt(), so the drone camera can follow
// and bank into it exactly like the Polaroid scene's flight
function mistPathAt(dist){
  const a = (dist / MIST_CHUNK_LENGTH) * Math.PI * 2;
  return {
    x: Math.sin(a * 2) * 10 + Math.sin(a * 5 + 1) * 4,
    y: Math.sin(a * 3) * 1.6 + Math.sin(a + 2) * 2.2,
  };
}
// trailing-follow state for the cloud drone (mirrors roadCam*)
let mistCamX = 0, mistCamY = 5, mistCamYaw = 0, mistCamPitch = 0, mistCamBank = 0;

/* ---------- Downtown-only block maze: an endless flight through a huge
   geometric corridor built from stacked rectangular slabs and beams
   jutting in from every wall - modeled on the reference art's wooden
   maze-tunnel - but in deep warm tones (umber, rust, amber, walnut)
   instead of greyscale. A warm light near the camera falls off down the
   corridor so the far end sinks into darkness, exactly like the
   reference's vanishing point. Same chunk-tiling scroll as the other
   worlds; the camera drifts and rotates through the open middle. ---------- */
const DT_ARTIST_NAME = "Downtown";
const DT_SCALE = 6;    // the whole world is 6x the original corridor
const DT_CHUNK_LENGTH = 90 * DT_SCALE;
const DT_REPEATS = 3;
const DT_SPEED = 13;   // brisker to match the bigger space, still a glide
const DT_HALF_W = 14 * DT_SCALE;  // corridor half-width - boxes pushed far out left/right
const DT_HALF_H = 10 * DT_SCALE;  // corridor half-height - and far out above/below
// warm base palette, deliberately kept mid-to-dark ("not too light");
// tinted toward the artist's own color on activation - see dtMats below
const DT_BASE_COLORS = [0x6e4420, 0x8a5a2c, 0x9c6428, 0x4a2f18, 0x7a3c1e, 0x5c3a22].map(c => new THREE.Color(c));
// fully solid boxes, with a bright wireframe edge overlay
// (dtEdgeMat, tinted with the artist color on activation)
const dtMats = DT_BASE_COLORS.map(color => new THREE.MeshPhongMaterial({ color: color.clone(), specular: 0x2a1c10, shininess: 8 }));
const dtEdgeMat = new THREE.LineBasicMaterial({ color: 0xd8b088, transparent: true, opacity: 0.55 });
const dtEdgeBaseColor = new THREE.Color(0xd8b088); // the edges' own tint, before the music-reactive white flash lerps over it
// one single line (not every edge) reacts to the music - a real
// screen-space "fat line" mesh (same technique as the intro tunnel's
// buildTunnelFatLineGeometry/Material) so its width can actually grow
// with the music, not just a LineBasicMaterial (WebGL caps line width
// at 1px on almost every platform/driver)
function buildFatLineGeometry(edgesGeo){
  const src = edgesGeo.attributes.position;
  const segCount = src.count / 2;
  const positions = new Float32Array(segCount * 4 * 3);
  const others = new Float32Array(segCount * 4 * 3);
  const sides = new Float32Array(segCount * 4);
  const indices = [];
  const put = (vi, px, py, pz, ox, oy, oz, side) => {
    positions[vi * 3] = px; positions[vi * 3 + 1] = py; positions[vi * 3 + 2] = pz;
    others[vi * 3] = ox; others[vi * 3 + 1] = oy; others[vi * 3 + 2] = oz;
    sides[vi] = side;
  };
  for (let s = 0; s < segCount; s++){
    const ax = src.getX(s * 2), ay = src.getY(s * 2), az = src.getZ(s * 2);
    const bx = src.getX(s * 2 + 1), by = src.getY(s * 2 + 1), bz = src.getZ(s * 2 + 1);
    const base = s * 4;
    put(base, ax, ay, az, bx, by, bz, -1);
    put(base + 1, ax, ay, az, bx, by, bz, 1);
    put(base + 2, bx, by, bz, ax, ay, az, -1);
    put(base + 3, bx, by, bz, ax, ay, az, 1);
    indices.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("aOther", new THREE.Float32BufferAttribute(others, 3));
  geo.setAttribute("aSide", new THREE.Float32BufferAttribute(sides, 1));
  geo.setIndex(indices);
  return geo;
}
function buildFatLineMaterial(){
  return new THREE.ShaderMaterial({
    uniforms: { uResolution: { value: tunnelLineResolution }, uLineWidth: { value: 2 },
      uColor: { value: new THREE.Color(0xd8b088) }, uOpacity: { value: 0.85 } },
    side: THREE.DoubleSide,
    transparent: true,
    vertexShader: `
      attribute vec3 aOther;
      attribute float aSide;
      uniform vec2 uResolution;
      uniform float uLineWidth;
      void main(){
        vec4 mvSelf = modelViewMatrix * vec4( position, 1.0 );
        vec4 mvOther = modelViewMatrix * vec4( aOther, 1.0 );
        vec4 clipSelf = projectionMatrix * mvSelf;
        vec4 clipOther = projectionMatrix * mvOther;
        vec2 screenSelf = clipSelf.xy / clipSelf.w * uResolution;
        vec2 screenOther = clipOther.xy / clipOther.w * uResolution;
        vec2 dir = normalize( screenOther - screenSelf + 1e-4 );
        vec2 normal = vec2( -dir.y, dir.x );
        vec2 offsetPx = normal * ( uLineWidth * 0.5 ) * aSide;
        clipSelf.xy += ( offsetPx / uResolution ) * clipSelf.w;
        gl_Position = clipSelf;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      void main(){
        gl_FragColor = vec4( uColor, uOpacity );
      }
    `,
  });
}
const dtHeroBaseColor = new THREE.Color(0xd8b088);
let dtHeroFatMat = null; // built below, once the hero box's fat-line geometry exists
const dtReactiveSlabs = []; // slabs that light up with the music (see animate())
const dtBobSlabs = [];      // every box, corridor and outer - all bob up/down in animate()
const dtLineMats = [];      // every box's vertical-line material - lit by the music
const downtownGroup = new THREE.Group();
{
  const h = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  // one shared unit-box edge geometry: added as a child of each box it
  // inherits that box's scale, drawing the wireframe outline around it
  const dtEdgeGeo = new THREE.EdgesGeometry(boxGeo);
  // the one hero box's fat-line outline - built once, reused as that one
  // box's edge mesh below
  const dtHeroFatGeo = buildFatLineGeometry(dtEdgeGeo);
  dtHeroFatMat = buildFatLineMaterial();
  // one shared vertical-line geometry: a thin line shooting far up and far
  // down through every box, in that box's own color (the line material
  // SHARES the box material's Color instance, so artist retints follow).
  // this is a unit-radius cylinder, not a THREE.Line - WebGL line width is
  // capped at 1px on almost every platform/driver, so a real mesh (scaled
  // per box below) is the only reliable way to get an actual 1-4px range
  const dtLineGeo = new THREE.CylinderGeometry(1, 1, 1800, 6, 1, true);
  const addBoxLine = (box, mat, i) => {
    const lm = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55 });
    lm.color = mat.color; // shared reference, not a copy
    dtLineMats.push(lm);  // opacity pulses with the music in animate()
    const line = new THREE.Mesh(dtLineGeo, lm);
    // radius varies 1-4px-equivalent per box, seeded off its own index so
    // it's stable across frames/retints
    const px = 1 + h(i, 23) * 3;
    const r = px * 0.018;
    line.scale.set(r, 1, r);
    line.position.set(box.position.x, 0, box.position.z);
    line.frustumCulled = false;
    downtownGroup.add(line);
  };
  const registerBob = (slab, i, amp) => {
    slab.userData.baseY = slab.position.y;
    slab.userData.bobPhase = h(i, 20) * Math.PI * 2;
    slab.userData.bobSpeed = 0.1 + h(i, 21) * 0.18;
    slab.userData.bobAmp = amp;
    // no spin, no tilt - every box sits axis-aligned
    slab.rotation.z = 0;
    dtBobSlabs.push(slab);
  };
  // per-chunk template of slabs on all four sides, tiled DT_REPEATS times
  // (no solid shell anymore - the gaps open onto the outer box field below,
  // fading into the fog)
  const SLABS = 46;
  for (let rep = 0; rep < DT_REPEATS; rep++){
    for (let i = 0; i < SLABS; i++){
      const side = Math.floor(h(i, 1) * 4); // 0 left, 1 right, 2 floor, 3 ceiling
      const z = -h(i, 2) * DT_CHUNK_LENGTH - rep * DT_CHUNK_LENGTH;
      const depth = (2 + h(i, 3) * 7) * DT_SCALE;        // how long along the corridor
      const thickness = (0.6 + h(i, 4) * 1.3) * DT_SCALE;
      const protrusion = (1 + h(i, 5) * 5) * DT_SCALE;   // how far it juts into the corridor
      const along = (h(i, 6) - 0.5) * 2;    // position along the wall's free axis
      // roughly one slab in five glows with the music - those get their
      // own material clone so their emissive can pulse independently
      const reactive = h(i, 8) < 0.2;
      const mat = reactive ? dtMats[i % dtMats.length].clone() : dtMats[i % dtMats.length];
      const slab = new THREE.Mesh(boxGeo, mat);
      if (side === 0 || side === 1){
        slab.scale.set(protrusion, thickness, depth);
        slab.position.set((side === 0 ? -1 : 1) * (DT_HALF_W - protrusion / 2), along * (DT_HALF_H - DT_SCALE), z);
      } else {
        slab.scale.set((thickness / DT_SCALE + 2 + h(i, 7) * 5) * DT_SCALE, protrusion, depth);
        slab.position.set(along * (DT_HALF_W - 2 * DT_SCALE), (side === 2 ? -1 : 1) * (DT_HALF_H - protrusion / 2), z);
      }
      if (reactive){
        slab.userData.pulsePhase = h(i, 9) * Math.PI * 2;
        dtReactiveSlabs.push(slab);
      }
      slab.add(new THREE.LineSegments(dtEdgeGeo, dtEdgeMat));
      registerBob(slab, i + rep * 1000, 1.5 + h(i, 22) * 2);
      downtownGroup.add(slab);
      addBoxLine(slab, mat, i);
    }
  }
  // bigger boxes drifting in the open space OUTSIDE the corridor walls,
  // visible through the gaps between the wall slabs
  const OUTER = 14;
  for (let rep = 0; rep < DT_REPEATS; rep++){
    for (let i = 0; i < OUTER; i++){
      const k = i + 100;
      const z = -h(k, 2) * DT_CHUNK_LENGTH - rep * DT_CHUNK_LENGTH;
      const reactive = h(k, 8) < 0.15;
      const mat = reactive ? dtMats[i % dtMats.length].clone() : dtMats[i % dtMats.length];
      const box = new THREE.Mesh(boxGeo, mat);
      box.scale.set(15 + h(k, 3) * 35, 15 + h(k, 4) * 35, 15 + h(k, 5) * 40);
      let px, py;
      if (h(k, 6) < 0.5){ // beyond the left/right walls
        px = (h(k, 7) < 0.5 ? -1 : 1) * (DT_HALF_W + 20 + h(k, 9) * 150);
        py = (h(k, 10) - 0.5) * 2 * DT_HALF_H * 2.2;
      } else {            // beyond the floor/ceiling
        py = (h(k, 7) < 0.5 ? -1 : 1) * (DT_HALF_H + 20 + h(k, 9) * 110);
        px = (h(k, 10) - 0.5) * 2 * DT_HALF_W * 2.2;
      }
      box.position.set(px, py, z);
      if (reactive){
        box.userData.pulsePhase = h(k, 9) * Math.PI * 2;
        dtReactiveSlabs.push(box);
      }
      // the very first outer box of the first repeat carries the one
      // music-reactive line, as a real fat-line mesh so its width can
      // grow with the music; every other box keeps the plain thin shared
      // edge material
      if (rep === 0 && i === 0) box.add(new THREE.Mesh(dtHeroFatGeo, dtHeroFatMat));
      else box.add(new THREE.LineSegments(dtEdgeGeo, dtEdgeMat));
      registerBob(box, k + rep * 1000, 4 + h(k, 11) * 5);
      downtownGroup.add(box);
      addBoxLine(box, mat, k);
    }
  }
}
// tint the maze into the artist's own color range (called on activation,
// when the current track - and so its artistColor - is known), with
// dedicated red, green and blue slab variants scattered through the scene
const dtTintColor = new THREE.Color();
// matched-intensity accent boxes: dark muted red, blue and yellow
const DT_RGB_VARIANTS = [0xa03028, 0x2830a0, 0xa09428].map(c => new THREE.Color(c));
function applyDowntownTint(artistColor){
  dtTintColor.set(artistColor || "#8a5a2c");
  // complement of the artist color - the scene's contrast accent
  const dtContrast = new THREE.Color(1 - dtTintColor.r, 1 - dtTintColor.g, 1 - dtTintColor.b);
  dtMats.forEach((mat, i) => {
    if (i < 2){
      // two slots: warm base pulled toward the artist color, punched up -
      // less lerp toward the tint (was muddying the hue) and a stronger
      // saturation boost for a more intense color overall
      mat.color.copy(DT_BASE_COLORS[i]).lerp(dtTintColor, 0.35).multiplyScalar(1.3);
    } else if (i === 2){
      // one slot: the artist color's complement, the hardest contrast
      mat.color.copy(dtContrast);
    } else {
      // three slots: matched-intensity red / blue / yellow accents, barely
      // artist-tinted so they read as their own hues, punched up
      mat.color.copy(DT_RGB_VARIANTS[i - 3]).lerp(dtTintColor, 0.06).multiplyScalar(1.3);
    }
    mat.color.offsetHSL(0, 0.15, 0);
  });
  dtReactiveSlabs.forEach(slab => {
    slab.material.color.copy(DT_BASE_COLORS[0]).lerp(dtTintColor, 0.6).multiplyScalar(1.1);
    slab.material.emissive.copy(dtTintColor).multiplyScalar(0.5);
    slab.material.emissiveIntensity = 0;
  });
  // the box wireframe outlines follow the artist color too, brightened
  dtEdgeBaseColor.copy(dtTintColor).lerp(new THREE.Color(0xffffff), 0.45);
  dtEdgeMat.color.copy(dtEdgeBaseColor);
  // the one hero line: same base tint, but its own material so it alone
  // reacts to the music (see animate())
  dtHeroBaseColor.copy(dtEdgeBaseColor);
  dtHeroFatMat.uniforms.uColor.value.copy(dtHeroBaseColor);
}
downtownGroup.visible = false;
scene.add(downtownGroup);
// warm light near the camera - the corridor darkens with distance, like
// the reference's vanishing point; plus a dim warm ambient fill
// parked BELOW the corridor, shining upward - undersides glow, tops fall dark
const downtownLight = new THREE.PointLight(0xffd9a0, 1.0, 70 * DT_SCALE, 1.8); // 20% brighter (was 30% darker)
downtownLight.position.set(0, -DT_HALF_H - 20, 2);
downtownLight.visible = false;
scene.add(downtownLight);
const downtownAmbient = new THREE.AmbientLight(0x2a180c, 0.58); // 20% brighter (was 30% darker)
downtownAmbient.visible = false;
scene.add(downtownAmbient);
const downtownFog = new THREE.FogExp2(0x120a05, (0.02 / DT_SCALE) * 0.8); // 20% less dense (less dark)
// starfield rushing through the maze at 3x the blocks' speed, in four
// pixel-size classes from 1px pinpricks up to 4px flares, fogged like the
// blocks so far stars sit darker and brighten as they rush closer
const dtStars = (() => {
  const h = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
  const pal = [0xffffff, 0xffd9a0, 0xff8a73].map(c => new THREE.Color(c));
  const group = new THREE.Group();
  // sizes now perspective-scaled (was a fixed pixel size) so stars grow
  // as they near the camera, tuned so the closest read at ~5px
  [[100, 0.5], [70, 0.9], [40, 1.3], [20, 1.8]].forEach(([count, size], si) => {
    const positions = [], colors = [];
    for (let rep = -1; rep < DT_REPEATS; rep++){
      for (let i = 0; i < count; i++){
        positions.push((h(i * 3 + si * 97, 1) - 0.5) * DT_HALF_W * 5, (h(i * 5 + si * 31, 2) - 0.5) * DT_HALF_H * 4,
          -h(i * 7 + si * 53, 3) * DT_CHUNK_LENGTH - rep * DT_CHUNK_LENGTH);
        const c = pal[i % pal.length];
        colors.push(c.r, c.g, c.b);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({ size, vertexColors: true, sizeAttenuation: true,
      map: roadDotTexture, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    group.add(points);
  });
  group.visible = false;
  scene.add(group);
  return group;
})();

/* ---------- shared palette rule for the numbered scenes: the current
   artist's color dominates (~50% of surfaces), and the other artists'
   colors fill the rest ---------- */
// the whole app now runs ROADS' own fixed blue palette everywhere,
// regardless of the current track's artist - no longer per-artist at all
const ROADS_BLUE_HEX = "#2e6de0";
const ROADS_BLUE_OTHERS_HEX = ["#0d2a5e", "#4fc3f7", "#1e3c72", "#00c6ff"];
function artistScenePalette(tr){
  const palette = {
    dominant: new THREE.Color(ROADS_BLUE_HEX),
    others: ROADS_BLUE_OTHERS_HEX.map(c => new THREE.Color(c)),
  };
  // punched up more intense, same as every other scene
  palette.dominant.offsetHSL(0, 0.12, 0.02);
  palette.others.forEach(c => c.offsetHSL(0, 0.12, 0.02));
  return palette;
}

// the referenced op-art photo sheet from the Tiles folder - loaded once,
// shared by every scene that tiles real photos across its surfaces
// (TILES walls/cubes, CUBE tunnel/cubes, DOMINO's floor overlay)
const TILE_IMAGE_FILES = [
  "25d73e3fee645d181aef898f84bdb11f.jpg", "3e4212a870ab324c0e6e0a37f95ec471.jpg",
  "541734a5d30bca16f2538329da91e09f.jpg", "5fe2945063fef90830a92ac8d2c470da.jpg",
  "8ad805ea9d0253123e94e4a5e510d0ac.jpg", "a3cafd679965810ebdc39238767b6c62.jpg",
  "b9530e2e2b36aafea2285b5a456031bd.jpg", "cb7d8e39abce16c03920426af5cda7e6.jpg",
  "d947ba314bded280265fa656d34615ac.jpg", "f75986841978c5dea0b3c198a420f51b.jpg",
];
const tileImageLoader = new THREE.TextureLoader();
const tileImageTextures = TILE_IMAGE_FILES.map(f => {
  const tex = tileImageLoader.load("assets/tiles/" + f);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
});
// TILES specifically uses just these three (the rest of the shared sheet
// above is for CUBE/DOMINO)
const TILES_IMAGE_FILES = ["1.jpg", "2.jpg", "3.jpg"];
const tilesImageTextures = TILES_IMAGE_FILES.map(f => {
  const tex = tileImageLoader.load("assets/tiles/" + f);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
});

/* ---------- Scene 1 "TILES": an op-art corridor of big square tiles -
   quarter circles, semicircles, arrows, slats and scallops on charcoal,
   straight from the mod/op-art reference boards. Two walls plus a floor,
   chunk-tiled and scrolled like every other fly-through; tile faces are
   the same photo tile sheet used by CUBE, tinted per artist. ---------- */
const TILES_TILE = 8;
const TILES_DEPTH_TILES = 12;
const TILES_CHUNK_LENGTH = TILES_TILE * TILES_DEPTH_TILES;
const TILES_REPEATS = 3;
const TILES_SPEED = 3.5; // 50% slower still (was 7)
const TILES_HALF_W = 28; // 2x the corridor cross-section
const TILES_HALF_H = 48; // walls run 12 tiles tall (was 6), floor/ceiling at +/-48
const tilesGroup = new THREE.Group();
const tilesMats = [];
const tilesStripeMats = [];     // the cubes' photo-tile coats
const tilesBlocks = []; // floating animated cubes, driven in animate()
{
  const h = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
  // walls/floor/ceiling: TILES' own 3-image set (1.jpg/2.jpg/3.jpg), one
  // image per material, tinted per artist in tilesRetint() below
  for (let i = 0; i < 12; i++){
    const tex = tilesImageTextures[i % tilesImageTextures.length];
    tilesMats.push(new THREE.MeshPhongMaterial({ map: tex, side: THREE.DoubleSide,
      specular: 0x555555, shininess: 22 }));
  }
  for (let i = 0; i < 4; i++){
    const tex = tilesImageTextures[i % tilesImageTextures.length];
    // Phong: the cubes catch a specular sheen from the key light (they
    // already cast and receive the scene's soft shadows)
    tilesStripeMats.push(new THREE.MeshPhongMaterial({ map: tex, specular: 0x999999, shininess: 48 }));
  }
  // merged geometry per material: one draw call each instead of ~600 meshes.
  // Every vertex is offset by the flight path at its own depth, so the
  // whole corridor genuinely bends - corners left/right, climbs and dives -
  // instead of being a straight square bore
  // each surface runs ONE material with grid-aligned UVs, so its
  // self-tileable pattern continues seamlessly from tile to tile - the
  // whole wall/floor/ceiling always reads as one matched image
  const buffers = tilesMats.map(() => ({ pos: [], uv: [], idx: [] }));
  const pushQuad = (mi, corners, u0, v0, uw = 1, vh = 1) => {
    const b = buffers[mi];
    const base = b.pos.length / 3;
    corners.forEach(c => {
      const bend = tilesPathAt(-c[2]);
      b.pos.push(c[0] + bend.x, c[1] + bend.y, c[2]);
    });
    b.uv.push(u0, v0, u0 + uw, v0, u0 + uw, v0 + vh, u0, v0 + vh);
    b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  // second structural layer: on top of a tile's outer (connecting) quad,
  // add a smaller inset panel pushed along the surface's own normal - a
  // real stepped-in/out relief instead of one flat sheet per surface. The
  // outer quad's corners are untouched so every tile still shares an exact
  // edge with its neighbours (nothing fragments), the inset is purely an
  // extra layer riding on top of that connected shell.
  const pushPanel = (mi, corners, normalAxis, sign, u0, v0, jitterSeed) => {
    pushQuad(mi, corners, u0, v0);
    if (h(jitterSeed, 33) > 0.35) return; // only a portion of tiles get the raised layer
    const cx = (corners[0][0] + corners[1][0] + corners[2][0] + corners[3][0]) / 4;
    const cy = (corners[0][1] + corners[1][1] + corners[2][1] + corners[3][1]) / 4;
    const cz = (corners[0][2] + corners[1][2] + corners[2][2] + corners[3][2]) / 4;
    const depth = 0.3 + h(jitterSeed, 34) * 0.35;
    const inset = corners.map(c => {
      const nc = [c[0] * 0.62 + cx * 0.38, c[1] * 0.62 + cy * 0.38, c[2] * 0.62 + cz * 0.38];
      nc[normalAxis] += sign * depth;
      return nc;
    });
    pushQuad(mi, inset, u0 + 0.18, v0 + 0.18, 0.64, 0.64);
  };
  // vertical color zoning: LOW materials (bottom wall rows, floor, low
  // gate bar) always carry the artist color; HIGH materials (upper rows,
  // ceiling, top gate parts) carry the muted grey/blue/green/purple/black
  // variants - see tilesRetint()
  const MAT_WALL_L_LOW = 0, MAT_WALL_L_HIGH = 1, MAT_WALL_R_LOW = 2, MAT_WALL_R_HIGH = 3;
  const MAT_FLOOR = 4, MAT_CEIL = 5, MAT_GATE_LOW = 6, MAT_GATE_HIGH = 7;
  const s = TILES_TILE / 2;
  for (let rep = 0; rep < TILES_REPEATS; rep++){
    for (let zi = 0; zi < TILES_DEPTH_TILES; zi++){
      const z = -(zi + 0.5) * TILES_TILE - rep * TILES_CHUNK_LENGTH;
      // wall relief: the depth offset is defined per z-EDGE (shared by the
      // two tiles meeting there) and is the same for every row, so every
      // facet connects seamlessly to its neighbours - angled, but with no
      // gaps anywhere
      const edgeL = k => (h((k % TILES_DEPTH_TILES) * 3, 6) - 0.5) * 3;
      const edgeR = k => (h((k % TILES_DEPTH_TILES) * 5 + 1, 6) - 0.5) * 3;
      const ln = -TILES_HALF_W + edgeL(zi), lf = -TILES_HALF_W + edgeL(zi + 1);
      const rn = TILES_HALF_W + edgeR(zi), rf = TILES_HALF_W + edgeR(zi + 1);
      for (let yi = 0; yi < 12; yi++){
        const y = (yi - 5.5) * TILES_TILE;
        pushPanel(yi < 4 ? MAT_WALL_L_LOW : MAT_WALL_L_HIGH,
          [[ln, y - s, z + s], [lf, y - s, z - s], [lf, y + s, z - s], [ln, y + s, z + s]],
          0, 1, zi, yi, zi * 12 + yi);
        pushPanel(yi < 4 ? MAT_WALL_R_LOW : MAT_WALL_R_HIGH,
          [[rn, y - s, z + s], [rf, y - s, z - s], [rf, y + s, z - s], [rn, y + s, z + s]],
          0, -1, zi, yi, zi * 12 + yi + 500);
      }
      // floor/ceiling now bow to match the walls' own left/right relief at
      // every z-slab (trapezoidal tiles instead of a fixed-width flat
      // strip) - their outer edges land exactly on the wall's inner edge,
      // so the box reads as one connected shell instead of four
      // independently-fragmented surfaces meeting at a gap
      for (let xi = 0; xi < 7; xi++){
        const t0 = xi / 7, t1 = (xi + 1) / 7;
        const xn0 = ln + t0 * (rn - ln), xn1 = ln + t1 * (rn - ln);
        const xf0 = lf + t0 * (rf - lf), xf1 = lf + t1 * (rf - lf);
        pushPanel(MAT_FLOOR,
          [[xn0, -TILES_HALF_H, z + s], [xn1, -TILES_HALF_H, z + s], [xf1, -TILES_HALF_H, z - s], [xf0, -TILES_HALF_H, z - s]],
          1, 1, xi, zi, zi * 7 + xi + 1000);
        // matching tiled ceiling closes the corridor into a full box
        pushPanel(MAT_CEIL,
          [[xf0, TILES_HALF_H, z - s], [xf1, TILES_HALF_H, z - s], [xn1, TILES_HALF_H, z + s], [xn0, TILES_HALF_H, z + s]],
          1, -1, xi, zi, zi * 7 + xi + 1500);
      }
      // stage gates: every 4th step a tiled frame crosses the corridor -
      // top and bottom bars, plus an occasional side panel that narrows
      // the passage so the weaving flight path has real corners to thread
      if (zi % 4 === 0){
        const gz = z - s;
        pushQuad(MAT_GATE_HIGH,
          [[-TILES_HALF_W, 24, gz], [TILES_HALF_W, 24, gz], [TILES_HALF_W, TILES_HALF_H, gz], [-TILES_HALF_W, TILES_HALF_H, gz]],
          0, 0, 7, 3);
        pushQuad(MAT_GATE_LOW,
          [[-TILES_HALF_W, -TILES_HALF_H, gz], [TILES_HALF_W, -TILES_HALF_H, gz], [TILES_HALF_W, -24, gz], [-TILES_HALF_W, -24, gz]],
          0, 3, 7, 3);
        if (h(zi * 31, 7) < 0.6){
          const sideSign = h(zi * 31, 8) < 0.5 ? -1 : 1;
          pushQuad(MAT_GATE_HIGH,
            [[sideSign * TILES_HALF_W, -24, gz], [sideSign * 10, -24, gz], [sideSign * 10, 24, gz], [sideSign * TILES_HALF_W, 24, gz]],
            0, 0, 2.2, 6);
        }
      }
    }
  }
  buffers.forEach((b, mi) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(b.uv, 2));
    geo.setIndex(b.idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, tilesMats[mi]);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    tilesGroup.add(mesh);
  });
  // floating tile blocks drifting through the corridor - spinning, bobbing
  // cubes wearing the same motif faces (animated in the tiles branch of
  // animate()); they cast real shadows onto the tiled walls
  const blockGeo = new THREE.BoxGeometry(2.8, 2.8, 2.8);
  for (let rep = 0; rep < TILES_REPEATS; rep++){
    for (let i = 0; i < 18; i++){
      const block = new THREE.Mesh(blockGeo, tilesStripeMats[Math.floor(h(i * 41, 10) * 4)]);
      const sideSign = i % 2 === 0 ? -1 : 1;
      const bz = -h(i, 13) * TILES_CHUNK_LENGTH - rep * TILES_CHUNK_LENGTH;
      const bend = tilesPathAt(-bz);
      block.position.set(bend.x + sideSign * (8 + h(i, 11) * 14), bend.y + (h(i, 12) - 0.5) * 70, bz);
      block.userData.baseY = block.position.y;
      block.userData.phase = h(i, 14) * Math.PI * 2;
      block.userData.spin = 0.15 + h(i, 15) * 0.3;
      block.castShadow = true;
      block.receiveShadow = true;
      block.frustumCulled = false;
      tilesBlocks.push(block);
      tilesGroup.add(block);
    }
  }
}
// warm-white key light raking the corridor from high front-left - what
// shades the tile faces and draws the blocks' cast shadows
// the key is split: a shadow-casting 70% part and a shadowless 30% fill
// on the same axis, so cast shadows land at 70% of full depth - and a
// wide PCF radius blurs their edges soft
const tilesDirLight = new THREE.DirectionalLight(0xfff4e8, 0.084); // shadow depth cut to 20% (rest moved to the fill)
tilesDirLight.position.set(30, 55, 20);
tilesDirLight.castShadow = true;
tilesDirLight.shadow.radius = 32.4; // 20% blurrier still on top of the existing 3x fuzz
tilesDirLight.shadow.mapSize.set(512, 512); // lower-res map softens them further
tilesDirLight.shadow.camera.left = -120;
tilesDirLight.shadow.camera.right = 120;
tilesDirLight.shadow.camera.top = 120;
tilesDirLight.shadow.camera.bottom = -120;
tilesDirLight.shadow.camera.near = 1;
tilesDirLight.shadow.camera.far = 220;
tilesDirLight.target.position.set(0, 0, -60);
tilesDirLight.visible = false;
scene.add(tilesDirLight);
scene.add(tilesDirLight.target);
const tilesDirFill = new THREE.DirectionalLight(0xfff4e8, 0.516); // absorbs the intensity moved off the key light, so overall brightness is unchanged
tilesDirFill.position.copy(tilesDirLight.position);
tilesDirFill.target = tilesDirLight.target;
tilesDirFill.visible = false;
scene.add(tilesDirFill);
const tilesAmbient = new THREE.AmbientLight(0xffffff, 0.38); // 30% darker scene
tilesAmbient.visible = false;
scene.add(tilesAmbient);
// the corridor flight path: long, gentle curves left/right AND climbs/
// dives (periodic over the chunk, so the endless wrap stays seamless) -
// the corridor geometry itself is bent along this same path
function tilesPathAt(dist){
  const a = (dist / TILES_CHUNK_LENGTH) * Math.PI * 2;
  return {
    x: Math.sin(a) * 11 + Math.sin(a * 3 + 1) * 4,
    y: Math.sin(a * 2 + 2) * 12 + Math.sin(a * 5) * 3,
  };
}
let tilesCamX = 0, tilesCamY = 0, tilesCamYaw = 0, tilesCamPitch = 0, tilesCamBank = 0;
let tilesFlowPhase = 0; // accumulated rhythmic slide of the stripe textures
tilesGroup.visible = false;
scene.add(tilesGroup);
// black-tinted haze: the corridor's far end reads ~30% darker than the
// area around the camera
const tilesFog = new THREE.FogExp2(0x000000, 0.012); // even denser - fades closer in still
// the geometric motif sheet (from the Bauhaus-poster reference): quarter
// and half circles, donuts, dot + ring grids, clovers, arches, pac-men,
// wings, petals, bowties, fans, domes, rainbows, leaves... shared by the
// TILES scene textures and the sphere screen's giant pattern cube.
// Each drawer paints one motif into an s x s cell (origin = cell's top
// left) using the canvas's current fillStyle.
const MOTIF_COUNT = 20;
function drawMotifCell(g, s, idx, rot){
  g.save();
  g.translate(s / 2, s / 2);
  g.rotate((rot || 0) * Math.PI / 2);
  const r = s / 2;
  const circle = (x, y, rad) => { g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill(); };
  const ring = (x, y, rad, w) => {
    g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2);
    g.arc(x, y, rad - w, 0, Math.PI * 2, true); g.fill();
  };
  const halfRing = (x, y, rad, w) => {
    g.beginPath(); g.arc(x, y, rad, Math.PI, 0);
    g.arc(x, y, rad - w, 0, Math.PI, true); g.closePath(); g.fill();
  };
  switch (((idx % MOTIF_COUNT) + MOTIF_COUNT) % MOTIF_COUNT){
    case 0: // quarter circle anchored in the cell corner
      g.beginPath(); g.moveTo(-r, -r); g.arc(-r, -r, s * 0.92, 0, Math.PI / 2); g.closePath(); g.fill(); break;
    case 1: // half circle resting on the bottom edge
      g.beginPath(); g.arc(0, r * 0.92, s * 0.46, Math.PI, Math.PI * 2); g.closePath(); g.fill(); break;
    case 2: circle(0, 0, s * 0.4); break; // full circle
    case 3: ring(0, 0, s * 0.4, s * 0.14); break; // donut
    case 4: { // 4x4 dot grid
      const step = s / 4;
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++)
        circle(-r + (i + 0.5) * step, -r + (j + 0.5) * step, step * 0.32);
      break;
    }
    case 5: { // 3x3 ring grid
      const step = s / 3;
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
        ring(-r + (i + 0.5) * step, -r + (j + 0.5) * step, step * 0.34, step * 0.15);
      break;
    }
    case 6: // four-circle clover
      circle(0, -s * 0.22, s * 0.2); circle(0, s * 0.22, s * 0.2);
      circle(-s * 0.22, 0, s * 0.2); circle(s * 0.22, 0, s * 0.2); break;
    case 7: // arch: rounded top, hollow middle, legs to the bottom edge
      g.beginPath();
      g.moveTo(-s * 0.36, r); g.lineTo(-s * 0.36, -s * 0.08);
      g.arc(0, -s * 0.08, s * 0.36, Math.PI, 0);
      g.lineTo(s * 0.36, r); g.closePath();
      g.moveTo(-s * 0.15, r); g.lineTo(-s * 0.15, -s * 0.08);
      g.arc(0, -s * 0.08, s * 0.15, Math.PI, 0);
      g.lineTo(s * 0.15, r); g.closePath();
      g.fill("evenodd"); break;
    case 8: // pac-man wedge
      g.beginPath(); g.moveTo(0, 0);
      g.arc(0, 0, s * 0.42, Math.PI * 0.25, Math.PI * 1.75);
      g.closePath(); g.fill(); break;
    case 9: // three stacked wings (half rings descending)
      halfRing(0, -s * 0.2, s * 0.3, s * 0.13);
      halfRing(0, s * 0.04, s * 0.3, s * 0.13);
      halfRing(0, s * 0.28, s * 0.3, s * 0.13); break;
    case 10: // X of four petals
      for (let a = 0; a < 4; a++){
        g.save(); g.rotate(a * Math.PI / 2 + Math.PI / 4);
        g.beginPath(); g.ellipse(0, -s * 0.26, s * 0.11, s * 0.2, 0, 0, Math.PI * 2); g.fill();
        g.restore();
      }
      break;
    case 11: // bowtie: two quarter wedges tip to tip
      g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, s * 0.42, Math.PI * 1.25, Math.PI * 1.75); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, s * 0.42, Math.PI * 0.25, Math.PI * 0.75); g.closePath(); g.fill();
      break;
    case 12: // two stacked circles
      circle(0, -s * 0.22, s * 0.19); circle(0, s * 0.22, s * 0.19); break;
    case 13: // two opposing corner quarter-fans
      g.beginPath(); g.moveTo(-r, -r); g.arc(-r, -r, s * 0.6, 0, Math.PI / 2); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(r, r); g.arc(r, r, s * 0.6, Math.PI, Math.PI * 1.5); g.closePath(); g.fill();
      break;
    case 14: // dome plus floating dot
      g.beginPath(); g.arc(0, s * 0.12, s * 0.34, Math.PI, 0); g.closePath(); g.fill();
      circle(0, -s * 0.28, s * 0.1); break;
    case 15: // concentric rainbow (three half rings on the bottom)
      halfRing(0, r * 0.8, s * 0.44, s * 0.07);
      halfRing(0, r * 0.8, s * 0.3, s * 0.07);
      halfRing(0, r * 0.8, s * 0.16, s * 0.07); break;
    case 16: // triangle
      g.beginPath(); g.moveTo(0, -s * 0.4); g.lineTo(s * 0.38, s * 0.36);
      g.lineTo(-s * 0.38, s * 0.36); g.closePath(); g.fill(); break;
    case 17: // three vertical slats
      for (let i = 0; i < 3; i++)
        g.fillRect(-r + (i * 2 + 0.5) * (s / 6), -s * 0.42, s / 6, s * 0.84);
      break;
    case 18: { // staggered dot rows
      const step = s / 3;
      for (let row = 0; row < 3; row++)
        for (let col = 0; col < 3; col++)
          circle(-r + (col + 0.5 + (row % 2) * 0.5) * step - step * 0.25,
                 -r + (row + 0.5) * step, step * 0.24);
      break;
    }
    default: // leaf / eye
      g.beginPath(); g.moveTo(-s * 0.38, 0);
      g.quadraticCurveTo(0, -s * 0.5, s * 0.38, 0);
      g.quadraticCurveTo(0, s * 0.5, -s * 0.38, 0);
      g.closePath(); g.fill();
  }
  g.restore();
}
// the surfaces' op-art motifs - COMBINED compositions from the shared
// sheet (a quad of four different motifs, a big motif with small ones
// tucked in, or a loose scatter at mixed scales and opacities), wrap-
// drawn at all nine offsets with a small jitter so every face stays
// perfectly tileable. All randomness is rolled BEFORE the wrap pass so
// each of the nine copies is identical - that's what keeps the seams
// invisible.
function drawTileMotif(g, fg, bg){
  g.fillStyle = bg; g.fillRect(0, 0, 256, 256);
  g.fillStyle = fg;
  const jx = (Math.random() - 0.5) * 44;
  const jy = (Math.random() - 0.5) * 44;
  const wrapDraw = draw => {
    for (let ox = -256; ox <= 256; ox += 256){
      for (let oy = -256; oy <= 256; oy += 256){
        g.save(); g.translate(ox + jx, oy + jy); draw(); g.restore();
      }
    }
  };
  const pick = () => ({ idx: Math.floor(Math.random() * MOTIF_COUNT), rot: Math.floor(Math.random() * 4) });
  const layout = Math.floor(Math.random() * 3);
  if (layout === 0){
    // quad: four different motifs side by side
    const cells = [pick(), pick(), pick(), pick()];
    wrapDraw(() => cells.forEach((c, q) => {
      g.save();
      g.translate((q % 2) * 128, Math.floor(q / 2) * 128);
      drawMotifCell(g, 128, c.idx, c.rot);
      g.restore();
    }));
  } else if (layout === 1){
    // one big motif with two half-tone small ones tucked into corners
    const big = pick();
    const small = [0, 1].map(k => ({ ...pick(),
      x: k === 0 ? 8 : 168, y: k === 0 ? 8 : 168, s: 80 }));
    wrapDraw(() => {
      drawMotifCell(g, 256, big.idx, big.rot);
      small.forEach(s => {
        g.save(); g.globalAlpha = 0.55; g.translate(s.x, s.y);
        drawMotifCell(g, s.s, s.idx, s.rot); g.restore();
      });
    });
  } else {
    // loose scatter: three motifs at mixed scales and opacities
    const items = [0, 1, 2].map(() => ({ ...pick(),
      x: Math.random() * 176, y: Math.random() * 176,
      s: 72 + Math.random() * 100, a: 0.5 + Math.random() * 0.5 }));
    wrapDraw(() => items.forEach(s => {
      g.save(); g.globalAlpha = s.a; g.translate(s.x, s.y);
      drawMotifCell(g, s.s, s.idx, s.rot); g.restore();
    }));
  }
}
// the cubes' animated stripe coat: stripes in four orientations and
// varying widths (periods divide 256, perfectly tileable), sometimes with
// a bold solid circle/square embedded - these are the textures the rhythm
// animation slides
function drawTileStripes(g, fg, bg){
  g.fillStyle = bg; g.fillRect(0, 0, 256, 256);
  g.fillStyle = fg;
  const orient = Math.floor(Math.random() * 4); // 0 horiz, 1 vert, 2 diag /, 3 diag \
  const period = [16, 32, 64][Math.floor(Math.random() * 3)];
  const w = period * (0.35 + Math.random() * 0.3);
  if (orient === 0){
    for (let y = 0; y < 256; y += period) g.fillRect(0, y, 256, w);
  } else if (orient === 1){
    for (let x = 0; x < 256; x += period) g.fillRect(x, 0, w, 256);
  } else {
    const sign = orient === 2 ? 1 : -1;
    for (let x = -512; x < 512; x += period){
      g.beginPath();
      g.moveTo(x, 0); g.lineTo(x + w, 0);
      g.lineTo(x + w + sign * 256, 256); g.lineTo(x + sign * 256, 256);
      g.closePath(); g.fill();
    }
  }
}
/* ---------- CUBE, replaced: a winding tunnel of the same op-art block
   motifs as TILES, but bending left/right AND up/down on a tall curve
   (not just side to side) - built as a square tube extruded along a
   winding spine, chunk-tiled and scrolled like every other flythrough.
   Chrome-mirror balls float inside, reflecting the tunnel around them
   live via a shared cube-camera probe. ---------- */
const CUBEW_CHUNK_LENGTH = 200, CUBEW_REPEATS = 3, CUBEW_SPEED = 4, CUBEW_STEP = 8;
const CUBEW_HALF_W = 15, CUBEW_HALF_H = 15;
function cubePathAt(distZ){
  const a = (distZ / CUBEW_CHUNK_LENGTH) * Math.PI * 2;
  return {
    x: Math.sin(a) * 26 + Math.sin(a * 3 + 1) * 9,
    y: Math.sin(a * 2 + 2) * 20 + Math.sin(a * 5) * 7,
  };
}
let cubeCamX = 0, cubeCamY = 0, cubeCamYaw = 0, cubeCamPitch = 0, cubeCamBank = 0;
const donutGroup = new THREE.Group();
// lit like TILES' walls: same soft specular sheen, and the tunnel
// receives the floating cubes' cast shadows - one material per image
const donutMats = tileImageTextures.map(tex => new THREE.MeshPhongMaterial({ map: tex, side: THREE.DoubleSide,
  specular: 0x555555, shininess: 22 }));
{
  const h = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
  const AREA_LEN = 4; // stations per texture "area" before it switches
  const buffers = donutMats.map(() => ({ pos: [], uv: [], idx: [] }));
  const push = (mi, corners, u0, v0) => {
    const b = buffers[mi];
    const base = b.pos.length / 3;
    corners.forEach(c => b.pos.push(c[0], c[1], c[2]));
    // each wall spans exactly one full repeat of the tile image so it
    // reads as a proper seamless tiled surface, not one stretched photo
    b.uv.push(u0, v0, u0 + 1, v0, u0 + 1, v0 + 1, u0, v0 + 1);
    b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const stations = Math.round(CUBEW_CHUNK_LENGTH / CUBEW_STEP);
  const W = CUBEW_HALF_W, H = CUBEW_HALF_H;
  for (let rep = -1; rep < CUBEW_REPEATS; rep++){
    for (let si = 0; si < stations; si++){
      const areaIdx = Math.floor(si / AREA_LEN) + rep * Math.ceil(stations / AREA_LEN);
      const mi = Math.floor(h(areaIdx, 61) * donutMats.length) % donutMats.length;
      const zN = -(si * CUBEW_STEP + rep * CUBEW_CHUNK_LENGTH);
      const zF = -((si + 1) * CUBEW_STEP + rep * CUBEW_CHUNK_LENGTH);
      const pN = cubePathAt(-zN), pF = cubePathAt(-zF);
      push(mi, [[pN.x - W, pN.y - H, zN], [pF.x - W, pF.y - H, zF], [pF.x - W, pF.y + H, zF], [pN.x - W, pN.y + H, zN]], si, 0);
      push(mi, [[pN.x + W, pN.y + H, zN], [pF.x + W, pF.y + H, zF], [pF.x + W, pF.y - H, zF], [pN.x + W, pN.y - H, zN]], si, 1);
      push(mi, [[pN.x - W, pN.y - H, zN], [pN.x + W, pN.y - H, zN], [pF.x + W, pF.y - H, zF], [pF.x - W, pF.y - H, zF]], si, 2);
      push(mi, [[pF.x - W, pF.y + H, zF], [pF.x + W, pF.y + H, zF], [pN.x + W, pN.y + H, zN], [pN.x - W, pN.y + H, zN]], si, 3);
    }
  }
  buffers.forEach((b, mi) => {
    if (!b.pos.length) return;
    const donutGeo = new THREE.BufferGeometry();
    donutGeo.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3));
    donutGeo.setAttribute("uv", new THREE.Float32BufferAttribute(b.uv, 2));
    donutGeo.setIndex(b.idx);
    donutGeo.computeVertexNormals();
    const tunnelMesh = new THREE.Mesh(donutGeo, donutMats[mi]);
    tunnelMesh.frustumCulled = false;
    tunnelMesh.receiveShadow = true;
    donutGroup.add(tunnelMesh);
  });
}
scene.add(donutGroup);
// floating spinning cubes - same photo sheet as the tunnel walls (a
// different image per cube), a brighter specular coat (matching TILES'
// floating blocks), casting/receiving real shadows
const donutCubeMats = tileImageTextures.map(tex => new THREE.MeshPhongMaterial({ map: tex, specular: 0x999999, shininess: 48 }));
const donutCubes = [];
{
  const h = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
  const cubeGeo = new THREE.BoxGeometry(1, 1, 1);
  const stations = Math.round(CUBEW_CHUNK_LENGTH / CUBEW_STEP);
  for (let rep = -1; rep < CUBEW_REPEATS; rep++){
    for (let si = 0; si < stations; si += 2){
      const i = si + rep * stations;
      const cube = new THREE.Mesh(cubeGeo, donutCubeMats[Math.floor(h(i, 61) * donutCubeMats.length) % donutCubeMats.length]);
      const r = 1.6 + h(i, 51) * 2.4;
      cube.scale.setScalar(r);
      const bz = -(si * CUBEW_STEP + rep * CUBEW_CHUNK_LENGTH + h(i, 57) * CUBEW_STEP);
      const bp = cubePathAt(-bz);
      cube.position.set(
        bp.x + (h(i, 53) - 0.5) * (CUBEW_HALF_W * 2 - r * 2 - 3),
        bp.y + (h(i, 54) - 0.5) * (CUBEW_HALF_H * 2 - r * 2 - 3),
        bz);
      cube.userData.baseX = cube.position.x;
      cube.userData.baseY = cube.position.y;
      cube.userData.driftPhase = h(i, 55) * Math.PI * 2;
      cube.userData.driftRate = 0.2 + h(i, 56) * 0.3;
      cube.userData.spin = new THREE.Vector3(h(i, 58) - 0.5, h(i, 59) - 0.5, h(i, 60) - 0.5).multiplyScalar(1.4);
      cube.castShadow = true;
      cube.receiveShadow = true;
      cube.frustumCulled = false;
      donutCubes.push(cube);
      donutGroup.add(cube);
    }
  }
}
donutGroup.visible = false;
// the light rig - same "travels with the camera" pattern as TILES: a
// shadow-casting key plus a shadowless fill on the same axis, and a base
// ambient so the far side of the tunnel never goes fully black
const donutDirLight = new THREE.DirectionalLight(0xfff4e8, 0.084); // shadow depth cut to 20% (rest moved to the fill)
donutDirLight.castShadow = true;
donutDirLight.shadow.radius = 32.4; // 20% blurrier
donutDirLight.shadow.mapSize.set(512, 512);
donutDirLight.shadow.camera.left = -60;
donutDirLight.shadow.camera.right = 60;
donutDirLight.shadow.camera.top = 60;
donutDirLight.shadow.camera.bottom = -60;
donutDirLight.shadow.camera.near = 1;
donutDirLight.shadow.camera.far = 120;
donutDirLight.visible = false;
scene.add(donutDirLight);
scene.add(donutDirLight.target);
const donutDirFill = new THREE.DirectionalLight(0xfff4e8, 0.516); // absorbs the intensity moved off the key light
donutDirFill.target = donutDirLight.target;
donutDirFill.visible = false;
scene.add(donutDirFill);
const donutAmbient = new THREE.AmbientLight(0xffffff, 0.38);
donutAmbient.visible = false;
scene.add(donutAmbient);
// a soft haze standing in for real depth-of-field blur (no post-process
// pipeline in this renderer) - the tunnel reads sharp close around the
// camera, then softens/fades further back instead of staying crisp the
// whole way down
const donutFog = new THREE.FogExp2(0x050505, 0.028);
function donutRetint(tr){
  // the photo tiles carry their own rich color already - just a light
  // per-track wash so the scene still ties into the artist's color
  // without washing out the pattern itself
  const { dominant } = artistScenePalette(tr);
  const tint = new THREE.Color(0xffffff).lerp(dominant, 0.18);
  donutMats.forEach(m => m.color.copy(tint));
  donutCubeMats.forEach(m => m.color.copy(tint));
  // the far haze/backdrop is the artist color (10% darker) instead of
  // fading to black - the renderer's clear color reads straight off this
  // same THREE.Color so the two never visibly seam
  donutFog.color.copy(dominant).multiplyScalar(0.9);
}
let tilesLastPalette = null;
function tilesRetint(tr){
  const { dominant, others } = artistScenePalette(tr);
  tilesLastPalette = { dominant, others };
  // deeper objects fade into the background, which is the artist color
  // 60% darker (40% of full brightness) rather than flat black/charcoal
  tilesFog.color.copy(dominant).multiplyScalar(0.4);
  // vertical zoning: even-index materials tint toward the artist's color,
  // odd-index toward a muted grey/blue/green/purple variant - same split
  // the old procedural pattern used, just tinting the photo tiles now
  // instead of drawing onto them. Lerped toward white so the photo's own
  // detail stays visible under the tint rather than being flattened
  const domVariants = [
    dominant.clone().multiplyScalar(0.85),
    dominant.clone().multiplyScalar(0.6),
    dominant.clone(),
    dominant.clone().lerp(new THREE.Color(0xffffff), 0.15),
  ];
  const muted = [0x8a8a8a, 0x3a5aa8, 0x3f8a5a, 0x7a4fa8, 0x232323].map(c => new THREE.Color(c));
  tilesMats.forEach((m, i) => {
    const base = i % 2 === 0 ? domVariants[(i / 2) % domVariants.length] : muted[i % muted.length];
    m.color.copy(new THREE.Color(0xffffff).lerp(base, 0.55));
  });
  tilesRedrawStripes();
}
function tilesRedrawStripes(){
  if (!tilesLastPalette) return;
  const { dominant, others } = tilesLastPalette;
  tilesStripeMats.forEach((m, i) => {
    const c = i < 2 ? dominant.clone().multiplyScalar(0.6)
      : others[i % others.length].clone().lerp(new THREE.Color(0xffffff), 0.2);
    m.color.copy(new THREE.Color(0xffffff).lerp(c, 0.55));
  });
}
let tilesStripeFlipT = 6; // seconds until the next stripe re-tint refresh

/* ---------- Scene 2 "ROADS": five Polaroid-style road ribbons side by
   side over a glossy black floor. Cubes of different sizes drop in from
   above the frame, bounce with real gravity/restitution, roll to a stop,
   and drift past the camera with the scrolling ground. Cubes are solid
   and specular; the floor "reflects" them via mirrored clones under a
   semi-transparent glossy plane. ---------- */
const BEAMS_CHUNK_LENGTH = 120;
const BEAMS_REPEATS = 3;
const BEAMS_SPEED = 12;
const beamsGroup = new THREE.Group();    // the scrolling ribbons
const beamsScenery = new THREE.Group();  // static: floor, cubes, mirrors
const beamsStripMats = [];
const beamsCubeMats = [];
const beamsMirrorMats = [];
const beamsCubes = [];
const BEAMS_CUBE_COUNT = 36; // bumped up for whole-screen coverage now that cubes are smaller
const beamsCubeBase = []; // per-cube base colors, darkened by depth in animate()
const beamsRipples = []; // floor impact rings (water-drip pulses)
const beamsStreaks = []; // fading front-to-back floor light streaks on impact
let beamsLastSpawn = -10; // global gate: cubes launch one by one, never together
let beamsFloorCanvas = null;
let beamsFloorTex = null;
{
  // glossy floor with a length-wise color gradient (near-black under the
  // camera, warming into the artist color toward the horizon - redrawn in
  // beamsRetint); semi-transparent so the mirrored cube clones beneath
  // read as reflections in a polished surface
  beamsFloorCanvas = document.createElement("canvas");
  beamsFloorCanvas.width = 4; beamsFloorCanvas.height = 256;
  beamsFloorTex = new THREE.CanvasTexture(beamsFloorCanvas);
  // strongly reflective glossy floor, mostly invisible now
  const floorMat = new THREE.MeshPhongMaterial({ map: beamsFloorTex, color: 0xffffff, specular: 0xffffff,
    shininess: 130, transparent: true, opacity: 0.1, side: THREE.DoubleSide });
  // flat ground again - the hills are gone
  const floorGeo = new THREE.PlaneGeometry(240, 460);
  floorGeo.rotateX(-Math.PI / 2);
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.position.set(0, 0, -160);
  floor.receiveShadow = true; // the falling cubes cast onto it
  beamsScenery.add(floor);
  // five parallel ribbons with a soft brightness banding along their length
  const totalRows = 60 * BEAMS_REPEATS;
  for (let si = 0; si < 5; si++){
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
    beamsStripMats.push(mat);
    const positions = [], colors = [], indices = [];
    const xc = (si - 2) * 9;
    for (let r = 0; r <= totalRows; r++){
      const z = -r * 2;
      const shade = 0.62 + 0.38 * (Math.sin(((r % 60) / 60) * Math.PI * 6) * 0.5 + 0.5);
      positions.push(xc - 3, 0.06, z, xc + 3, 0.06, z);
      colors.push(shade, shade, shade, shade, shade, shade);
    }
    for (let r = 0; r < totalRows; r++){
      const a = r * 2, b = r * 2 + 1, c = (r + 1) * 2, d = (r + 1) * 2 + 1;
      indices.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    beamsGroup.add(mesh);
  }
  // impact glows: not a ring but a soft round blurred AREA that lights up
  // the floor where a cube lands
  const rippleCv = document.createElement("canvas");
  rippleCv.width = rippleCv.height = 128;
  const rg = rippleCv.getContext("2d");
  const rgrad = rg.createRadialGradient(64, 64, 4, 64, 64, 62);
  rgrad.addColorStop(0, "rgba(255,255,255,0.85)");
  rgrad.addColorStop(0.45, "rgba(255,255,255,0.4)");
  rgrad.addColorStop(1, "rgba(255,255,255,0)");
  rg.fillStyle = rgrad; rg.fillRect(0, 0, 128, 128);
  const rippleTex = new THREE.CanvasTexture(rippleCv);
  const rippleGeo = new THREE.PlaneGeometry(1, 1);
  rippleGeo.rotateX(-Math.PI / 2);
  for (let i = 0; i < 12; i++){
    const mat = new THREE.MeshBasicMaterial({ map: rippleTex, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false });
    const mesh = new THREE.Mesh(rippleGeo, mat);
    mesh.position.y = 0.08;
    mesh.visible = false;
    mesh.frustumCulled = false;
    beamsScenery.add(mesh);
    beamsRipples.push({ mesh, mat, life: 1, strength: 0 });
  }
  // impact light-streaks: a thin line running the full front-to-back
  // length of the floor through the landing spot, brightest at the
  // impact point and fading out toward both the near and far ends
  const streakCv = document.createElement("canvas");
  streakCv.width = 32; streakCv.height = 256;
  const sg = streakCv.getContext("2d");
  const sgrad = sg.createLinearGradient(0, 0, 0, 256);
  sgrad.addColorStop(0, "rgba(255,255,255,0)");
  sgrad.addColorStop(0.5, "rgba(255,255,255,0.9)");
  sgrad.addColorStop(1, "rgba(255,255,255,0)");
  sg.fillStyle = sgrad; sg.fillRect(0, 0, 32, 256);
  const streakTex = new THREE.CanvasTexture(streakCv);
  const streakGeo = new THREE.PlaneGeometry(0.4, 440);
  streakGeo.rotateX(-Math.PI / 2);
  for (let i = 0; i < 8; i++){
    const mat = new THREE.MeshBasicMaterial({ map: streakTex, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false });
    const mesh = new THREE.Mesh(streakGeo, mat);
    mesh.position.y = 0.07;
    mesh.visible = false;
    mesh.frustumCulled = false;
    beamsScenery.add(mesh);
    beamsStreaks.push({ mesh, mat, life: 1, strength: 0 });
  }
  // solid specular cubes + their mirror clones (the floor reflections) -
  // every cube gets its OWN material, so each carries one unique color
  const cubeGeo = new THREE.BoxGeometry(1, 1, 1);
  for (let i = 0; i < BEAMS_CUBE_COUNT; i++){
    beamsCubeMats.push(new THREE.MeshPhongMaterial({ specular: 0xffffff, shininess: 90 }));
    beamsMirrorMats.push(new THREE.MeshPhongMaterial({ specular: 0x888888, shininess: 90,
      transparent: true, opacity: 0.4 }));
  }
  // little starfield above the horizon - round stars 1px to 5px - with a
  // faint mirrored copy under the glossy floor as its reflection
  {
    const hh = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
    const starPal = [0xffffff, 0xd9e8ff, 0xffe8d2].map(c => new THREE.Color(c));
    [[90, 1], [60, 2], [40, 3], [18, 5]].forEach(([count, size], si) => {
      const positions = [], colors = [];
      for (let i = 0; i < count; i++){
        positions.push((hh(i * 3 + si * 97, 1) - 0.5) * 320, 8 + hh(i * 5 + si * 31, 2) * 85,
          -40 - hh(i * 7 + si * 53, 3) * 280);
        const c = starPal[i % starPal.length];
        colors.push(c.r, c.g, c.b);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      const mkMat = opacity => {
        const m = new THREE.PointsMaterial({ size, vertexColors: true, sizeAttenuation: false,
          map: roadDotTexture, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
        m.fog = false;
        return m;
      };
      const stars = new THREE.Points(geo, mkMat(0.9));
      stars.frustumCulled = false;
      beamsScenery.add(stars);
      // the reflection: same field flipped under the floor, faint
      const mirrorStars = new THREE.Points(geo.clone(), mkMat(0.22));
      mirrorStars.scale.y = -1;
      mirrorStars.frustumCulled = false;
      beamsScenery.add(mirrorStars);
    });
  }
  // soft round diffuse shadow blob under each cube - not a real shadow
  // map (that's TILES-only), just a dark, soft-edged disc pinned to the
  // ground below the cube's own x/z, scaling with cube size
  const cubeShadowGeo = new THREE.PlaneGeometry(1, 1);
  for (let i = 0; i < BEAMS_CUBE_COUNT; i++){
    const mi = i;
    const cube = new THREE.Mesh(cubeGeo, beamsCubeMats[mi]);
    const mirror = new THREE.Mesh(cubeGeo, beamsMirrorMats[mi]);
    cube.castShadow = true; // real shadows onto the glossy floor
    cube.visible = mirror.visible = false;
    cube.frustumCulled = mirror.frustumCulled = false;
    beamsScenery.add(cube);
    beamsScenery.add(mirror);
    const shadowMat = new THREE.MeshBasicMaterial({ map: roadDotTexture, color: 0x000000,
      transparent: true, opacity: 0.4, depthWrite: false });
    const shadow = new THREE.Mesh(cubeShadowGeo, shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.visible = false;
    shadow.frustumCulled = false;
    beamsScenery.add(shadow);
    beamsCubes.push({ mesh: cube, mirror, shadow, size: 1, state: "wait", timer: i * 0.35, vy: 0,
      av: new THREE.Vector3() });
  }
}
beamsGroup.visible = false;
beamsScenery.visible = false;
scene.add(beamsGroup);
scene.add(beamsScenery);
// lighting for the specular cubes and glossy floor
// key from the RIGHT side, very diffuse: modest directional strength with
// a strong ambient fill below, and extra-soft shadows
const beamsLight = new THREE.DirectionalLight(0xffffff, 0.42);
beamsLight.position.set(90, 30, 5);
beamsLight.castShadow = true; // cubes throw soft shadows onto the floor
beamsLight.shadow.radius = 20;
beamsLight.shadow.mapSize.set(512, 512);
beamsLight.shadow.camera.left = -130;
beamsLight.shadow.camera.right = 130;
beamsLight.shadow.camera.top = 130;
beamsLight.shadow.camera.bottom = -130;
beamsLight.shadow.camera.near = 1;
beamsLight.shadow.camera.far = 320;
beamsLight.target.position.set(0, 0, -80);
beamsLight.visible = false;
scene.add(beamsLight);
scene.add(beamsLight.target);
const beamsAmbient = new THREE.AmbientLight(0xffffff, 0.55);
beamsAmbient.visible = false;
scene.add(beamsAmbient);
let beamsPrevFlight = 0;
let beamsLastBigDrop = 0; // clock of the once-per-~5s giant cube
const beamsRotMat = new THREE.Matrix4(); // scratch for cube support-height math
// local cube axes, reused each landing to find which one ends up closest
// to vertical (see the settleQuat snap in animate())
const beamsAxisX = new THREE.Vector3(1, 0, 0);
const beamsAxisY = new THREE.Vector3(0, 1, 0);
const beamsAxisZ = new THREE.Vector3(0, 0, 1);
// flat landing ground (kept as a function so the floor mesh and the
// physics stay in sync if terrain ever comes back)
function beamsGroundY(x, z){
  return 0;
}
const beamsFog = new THREE.FogExp2(0x05050a, 0.0056); // 20% less dense (less dark)
function beamsRetint(tr){
  // fixed blue-tone palette for this scene - no longer tied to the
  // current artist's color, always a spread of blues instead
  const dominant = new THREE.Color(0x2e6de0);
  const others = [new THREE.Color(0x0d2a5e), new THREE.Color(0x4fc3f7),
    new THREE.Color(0x1e3c72), new THREE.Color(0x00c6ff)];
  // punched up more intense across the board - every downstream color
  // (ribbons, cubes, ripples, streaks) derives from these two
  dominant.offsetHSL(0, 0.18, 0.04);
  others.forEach(c => c.offsetHSL(0, 0.18, 0.04));
  // ribbons: dominant on the center and outer lanes, others between
  // (all pulled down 30% for the darker look)
  beamsStripMats.forEach((mat, i) => {
    if (i === 2) mat.color.copy(dominant).multiplyScalar(0.7);
    else if (i % 2 === 0) mat.color.copy(dominant).multiplyScalar(0.5);
    else mat.color.copy(others[i % others.length]).multiplyScalar(0.7);
  });
  // cubes: unique colors - alternating distinct artist shades and the
  // other artists' colors at varied brightness, no two alike. The base
  // colors are stashed so animate() can darken each cube by its depth.
  beamsCubeMats.forEach((mat, i) => {
    const c = i % 2 === 0
      ? dominant.clone().multiplyScalar(1 - (i / BEAMS_CUBE_COUNT) * 0.55)
      : others[Math.floor(i / 2) % others.length].clone().multiplyScalar(0.7 + (i % 5) * 0.09);
    beamsCubeBase[i] = c;
    mat.color.copy(c);
    beamsMirrorMats[i].color.copy(c).multiplyScalar(0.6);
  });
  // impact ripples glow in a bright artist tint
  beamsRipples.forEach(r => { r.mat.color.copy(dominant).lerp(new THREE.Color(0xffffff), 0.5); });
  beamsStreaks.forEach(s => { s.mat.color.copy(dominant).lerp(new THREE.Color(0xffffff), 0.6); });
  // floor gradient: the artist color at 50% brightness right in front of
  // the camera, running away into a deep blue at the far end
  if (beamsFloorCanvas){
    const g = beamsFloorCanvas.getContext("2d");
    const blue = new THREE.Color(0x0d2a5e);
    const nearCss = "#" + dominant.clone().multiplyScalar(0.5).getHexString();
    const midCss = "#" + dominant.clone().multiplyScalar(0.18).lerp(blue, 0.5).getHexString();
    const farCss = "#" + blue.clone().multiplyScalar(0.55).getHexString();
    const grad = g.createLinearGradient(0, 256, 0, 0);
    grad.addColorStop(0, nearCss);
    grad.addColorStop(0.5, midCss);
    grad.addColorStop(1, farCss);
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 256);
    beamsFloorTex.needsUpdate = true;
  }
}

/* ---------- Scene 3 "PRISM": black space filled with curtains of tall
   dark slats whose vertical edges glow neon (the edge-lit grid and wavy
   slat references), drifting past huge soft prism blooms (the rainbow
   caustic references). Additive edge glow in 6 palette slots - half the
   edges carry the artist color, half the other artists'. ---------- */
const PRISM_CHUNK_LENGTH = 110;
const PRISM_REPEATS = 3;
const PRISM_SPEED = 10;
const prismGroup = new THREE.Group();
const prismMats = [];
const prismMoverRimMats = []; // {mat, srcIdx} - movers' own rim material clones, see prismRetint
const prismMovers = []; // slats that breathe toward the camera line and back
// step-and-glide gaze: every ~11s a new rotation target is picked, and the
// camera eases over to it at a slow pace (see the prism branch in animate)
let prismCamYaw = 0, prismCamPitch = 0, prismCamRoll = 0;
{
  const h = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
  // vertical glow-line texture (horizontal feather, tinted per slot)
  const cv = document.createElement("canvas");
  cv.width = 64; cv.height = 16;
  const g = cv.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 64, 0);
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.85)");
  grad.addColorStop(0.5, "rgba(255,255,255,1)");
  grad.addColorStop(0.65, "rgba(255,255,255,0.85)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad; g.fillRect(0, 0, 64, 16);
  const edgeTex = new THREE.CanvasTexture(cv);
  for (let i = 0; i < 6; i++){
    prismMats.push(new THREE.MeshBasicMaterial({ map: edgeTex, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  }
  // Lambert (not Basic): the drifting star lights genuinely illuminate
  // the slat surfaces as they pass
  const panelMat = new THREE.MeshLambertMaterial({ color: 0x1b1b24, side: THREE.DoubleSide });
  const panelBuf = { pos: [], idx: [] };
  const edgeBufs = prismMats.map(() => ({ pos: [], uv: [], idx: [] }));
  const pushPanel = corners => {
    const base = panelBuf.pos.length / 3;
    corners.forEach(c => panelBuf.pos.push(...c));
    panelBuf.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const pushEdge = (mi, corners) => {
    const b = edgeBufs[mi];
    const base = b.pos.length / 3;
    corners.forEach(c => b.pos.push(...c));
    b.uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  // slats stretch from far out of sight above to far below - 3x taller
  // than before (was 150) so their actual top/bottom ends always stay
  // well outside the frame, whatever the camera's current tilt - and
  // every slat and every glow rim gets its own random thickness - rims
  // span roughly 1px hairlines to fat 10px bars on screen
  const SLAT_H = 450, STEP = 3.4, CURVE_SEGS = 8;
  const perChunk = Math.floor(PRISM_CHUNK_LENGTH / STEP);
  for (let rep = 0; rep < PRISM_REPEATS; rep++){
    for (let zi = 0; zi < perChunk; zi++){
      [-1, 1].forEach((sideSign, si) => {
        // slight per-slat x jitter gives the curtain its wavy depth
        const x = sideSign * (16 + h(zi * 3 + si, 1) * 6);
        const z = -(zi + 0.5) * STEP - rep * PRISM_CHUNK_LENGTH;
        const yOff = (h(zi * 5 + si, 2) - 0.5) * 10;
        const slatW = 1 + h(zi * 7 + si, 4) * 3.2;
        // gentle bow: the slat curves toward the corridor at its middle
        const bow = (0.6 + h(zi * 17 + si, 6) * 1.4) * -sideSign;
        const xAt = t => x + bow * Math.sin(Math.PI * t);
        // built as CURVE_SEGS stacked strips so the whole slat (panel and
        // rims alike) bends smoothly instead of standing dead straight
        for (let seg = 0; seg < CURVE_SEGS; seg++){
          const t0 = seg / CURVE_SEGS, t1 = (seg + 1) / CURVE_SEGS;
          const y0 = yOff - SLAT_H / 2 + SLAT_H * t0;
          const y1 = yOff - SLAT_H / 2 + SLAT_H * t1;
          const x0 = xAt(t0), x1 = xAt(t1);
          pushPanel([[x0, y0, z - slatW / 2], [x0, y0, z + slatW / 2],
            [x1, y1, z + slatW / 2], [x1, y1, z - slatW / 2]]);
          // glowing rims on both vertical edges, nudged a hair off the
          // panel's plane toward the corridor so they never sit coplanar
          const xe0 = x0 - sideSign * 0.12, xe1 = x1 - sideSign * 0.12;
          [z - slatW / 2, z + slatW / 2].forEach((ze, ei) => {
            const mi = Math.floor(h(zi * 11 + si * 29 + ei, 3) * 6);
            const edgeW = 0.1 + h(zi * 13 + si * 37 + ei, 5) * 1.1;
            pushEdge(mi, [[xe0, y0, ze - edgeW], [xe0, y0, ze + edgeW],
              [xe1, y1, ze + edgeW], [xe1, y1, ze - edgeW]]);
          });
        }
      });
    }
  }
  // a handful of free slats that breathe inward toward the camera's base
  // line and drift back out again (animated in the prism branch)
  for (let rep = 0; rep < PRISM_REPEATS; rep++){
    for (let i = 0; i < 5; i++){
      const sideSign = i % 2 === 0 ? -1 : 1;
      const baseX = sideSign * (17 + h(i, 6) * 6);
      const z = -h(i, 7) * PRISM_CHUNK_LENGTH - rep * PRISM_CHUNK_LENGTH;
      const slatW = 1 + h(i, 8) * 2.5;
      const mover = new THREE.Group();
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(slatW, SLAT_H), panelMat);
      panel.rotation.y = Math.PI / 2;
      mover.add(panel);
      // each mover's rims are its own material clone (not the shared
      // prismMats instance the static curtain uses), so its opacity can
      // pulse independently - see the prism branch in animate(). Kept
      // color-synced with the shared source material in prismRetint.
      const rimMats = [];
      [-slatW / 2, slatW / 2].forEach((zo, ei) => {
        const edgeW = 0.1 + h(i * 9 + ei, 9) * 1.1;
        const srcIdx = (i + ei) % 6;
        const rimMat = prismMats[srcIdx].clone();
        prismMoverRimMats.push({ mat: rimMat, srcIdx });
        rimMats.push(rimMat);
        const rim = new THREE.Mesh(new THREE.PlaneGeometry(edgeW * 2, SLAT_H), rimMat);
        rim.rotation.y = Math.PI / 2;
        rim.position.set(-sideSign * 0.12, 0, zo);
        mover.add(rim);
      });
      mover.position.set(baseX, 0, z);
      mover.userData.baseX = baseX;
      mover.userData.amp = 6 + h(i, 10) * 7;
      mover.userData.speed = 0.12 + h(i, 11) * 0.15;
      mover.userData.phase = h(i, 12) * Math.PI * 2;
      mover.userData.rimMats = rimMats;
      mover.traverse(o => { o.frustumCulled = false; });
      prismMovers.push(mover);
      prismGroup.add(mover);
    }
  }
  const panelGeo = new THREE.BufferGeometry();
  panelGeo.setAttribute("position", new THREE.Float32BufferAttribute(panelBuf.pos, 3));
  panelGeo.setIndex(panelBuf.idx);
  panelGeo.computeVertexNormals(); // Lambert lighting needs normals
  const panelMesh = new THREE.Mesh(panelGeo, panelMat);
  panelMesh.frustumCulled = false;
  prismGroup.add(panelMesh);
  edgeBufs.forEach((b, mi) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(b.uv, 2));
    geo.setIndex(b.idx);
    const mesh = new THREE.Mesh(geo, prismMats[mi]);
    mesh.frustumCulled = false;
    prismGroup.add(mesh);
  });
}
prismGroup.visible = false;
scene.add(prismGroup);
// two star layers on their own scroll clocks - one drifting at half the
// lines' speed, one rushing past at 1.7x - so the slat curtain sits
// between two parallax depths
const prismStarLayers = [];
// a hard-edged solid disc (not the soft feathered roadDotTexture) so the
// stars read as solid circles rather than soft glow dots
const prismStarSolidTexture = (() => {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 64;
  const g = cv.getContext("2d");
  g.fillStyle = "#fff";
  g.beginPath(); g.arc(32, 32, 28, 0, Math.PI * 2); g.fill();
  return new THREE.CanvasTexture(cv);
})();
// perspective-scaled now (was a fixed pixel size) so a star visibly grows
// as it nears the camera instead of staying one constant screen size -
// world sizes tuned so the closest stars read at roughly 5px
[[0.5, 120, 0.7], [1.7, 80, 1.0]].forEach(([speedMul, count, size], li) => {
  const hh = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
  const positions = [], colors = [];
  const pal = [0xffffff, 0xd9e8ff, 0xffe8d2].map(c => new THREE.Color(c));
  for (let rep = -1; rep < PRISM_REPEATS; rep++){
    for (let i = 0; i < count; i++){
      positions.push((hh(i * 3 + li * 97, 1) - 0.5) * 90, (hh(i * 5 + li * 31, 2) - 0.5) * 120,
        -hh(i * 7 + li * 53, 3) * PRISM_CHUNK_LENGTH - rep * PRISM_CHUNK_LENGTH);
      const c = pal[i % pal.length];
      colors.push(c.r, c.g, c.b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({ size, vertexColors: true, sizeAttenuation: true,
    map: prismStarSolidTexture, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
  mat.fog = false;
  mat.userData.baseOpacity = 0.9;
  mat.userData.pulsePhase = li * Math.PI;
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  const group = new THREE.Group();
  group.add(points);
  group.visible = false;
  group.userData.speedMul = speedMul;
  scene.add(group);
  prismStarLayers.push(group);
});
// three of the stars are true light sources, drifting through the hall
// and genuinely lighting the slat panels as they pass
const prismStarLights = [];
for (let i = 0; i < 3; i++){
  // invisible light sources only - no visible ball, just their glow
  // washing across the slats
  // gentler point contribution + stronger ambient below = one steady
  // overall light level, no light/dark flickering as the lights drift
  const light = new THREE.PointLight(0xffffff, 0.85, 55, 2);
  light.visible = false;
  scene.add(light);
  prismStarLights.push(light);
}
const prismAmbient = new THREE.AmbientLight(0xffffff, 0.58); // steady, lights-free level
prismAmbient.visible = false;
scene.add(prismAmbient);
// denser again (was 0.015, before that 0.006) - newly-visible slats/glow
// lines fade in from transparent (matching the near-black background)
// instead of appearing at near-full opacity
const prismFog = new THREE.FogExp2(0x000000, 0.022);
function prismRetint(tr){
  const { dominant, others } = artistScenePalette(tr);
  // half the slots stay pure artist palette, the other half mix in a
  // fixed yellow/green/red accent for more color variety in the glowing
  // edges instead of everything reading as one tint family - full
  // intensity now (was pulled 40% down)
  const prismAccents = [0xffd400, 0x3ddc73, 0xff4d4d];
  prismMats.forEach((mat, i) => {
    if (i < 3) mat.color.copy(dominant);
    else mat.color.copy(new THREE.Color(prismAccents[i - 3])).lerp(others[i % others.length], 0.35);
  });
  // movers' rim materials are their own clones (see the build block) so
  // their opacity can pulse independently - keep their color synced to
  // the shared source material here
  prismMoverRimMats.forEach(({ mat, srcIdx }) => mat.color.copy(prismMats[srcIdx].color));
  // the three star lights: artist color plus two other artists' hues
  prismStarLights.forEach((light, i) => {
    const c = i === 0 ? dominant.clone() : others[i % others.length].clone();
    light.color.copy(c.lerp(new THREE.Color(0xffffff), 0.35));
  });
}

/* ---------- Scene 4 "RINGS": gates of concentric color-banded rings
   receding into the black (the concentric-rainbow and spirograph
   references) - the flight passes straight through their dark centers,
   with thin halo outlines orbiting the larger gates. Band colors use 8
   slots: four shades of the artist color, four cycling the others. ---------- */
const RINGS_CHUNK_LENGTH = 260; // stretched: much more z-space between gates
const RINGS_REPEATS = 3;
const RINGS_SPEED = 7.2; // 20% faster still (was 6)
const RINGS_GATES_PER_CHUNK = 6;
// the light-up wave's gate-index range - rep runs -1..RINGS_REPEATS-1,
// gi runs 0..RINGS_GATES_PER_CHUNK-1, so gate = gi + rep*GATES_PER_CHUNK
// spans exactly this range (see the build loop below)
const RINGS_GATE_MIN = -RINGS_GATES_PER_CHUNK;
const RINGS_GATE_MAX = RINGS_GATES_PER_CHUNK * RINGS_REPEATS - 1;
// the serpentine spine the ring tunnel bends along - left/right, up/down,
// periodic over the chunk so the endless wrap stays seamless
function ringsPathAt(dist){
  const a = (dist / RINGS_CHUNK_LENGTH) * Math.PI * 2;
  return {
    x: Math.sin(a) * 14 + Math.sin(a * 3 + 1) * 5,
    y: Math.sin(a * 2 + 2) * 12 + Math.sin(a * 5) * 4,
  };
}
let ringsCamX = 0, ringsCamY = 0, ringsCamYaw = 0, ringsCamPitch = 0, ringsCamBank = 0;
const ringsGroup = new THREE.Group();
const ringsScenery = new THREE.Group(); // the light at the end of the tunnel
const ringsGates = []; // per-gate canvas + band layout, redrawn in ringsRetint
let ringsGlowMat = null;
{
  const h = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
  // gate spacing varies 10-30 units along z (normalized so the gaps sum
  // exactly to the chunk length, keeping the endless wrap seamless)
  const gatesPerChunk = RINGS_GATES_PER_CHUNK;
  const rawGaps = [];
  let gapSum = 0;
  for (let gi = 0; gi < gatesPerChunk; gi++){ const g = 10 + h(gi, 13) * 20; rawGaps.push(g); gapSum += g; }
  const gateZ = [];
  let gapAcc = 0;
  for (let gi = 0; gi < gatesPerChunk; gi++){
    const g = rawGaps[gi] * (RINGS_CHUNK_LENGTH / gapSum);
    gateZ.push(-(gapAcc + g / 2));
    gapAcc += g;
  }
  // every band is its own small textured plane (soft 2px-max feathered
  // annulus painted in ringsRetint), and the SMALLER a ring is, the
  // DEEPER it sits behind its gate's plane - each gate becomes a little
  // funnel receding into the distance. Distinct depths per band also
  // means nothing is ever coplanar, so no interference flicker.
  for (let gi = 0; gi < gatesPerChunk; gi++){
    const bandCount = 5 + Math.floor(h(gi, 1) * 3);
    const holeR = 42 + h(gi, 2) * 48;      // 150% scale bore
    const bandStep = 4.5 + h(gi, 3) * 3.6; // ring-to-ring spacing, scaled up too
    const bandW = bandStep * 0.3;          // drawn band is 30% of the step - slim rings, open gaps
    const bands = [];
    let outerR = holeR + bandCount * bandStep;
    if (h(gi, 4) < 0.5){
      const hr = outerR + 2 + h(gi, 5) * 5;
      // halos join as extra thin bands
      bands.push({ r0: hr, r1: hr + 0.35, slot: 8 });
      bands.push({ r0: hr + 1.1, r1: hr + 1.45, slot: 8 });
      outerR = hr + 1.45;
    }
    for (let bi = 0; bi < bandCount; bi++){
      bands.push({ r0: holeR + bi * bandStep, r1: holeR + bi * bandStep + bandW,
        slot: Math.floor(h(gi * 13 + bi, 8) * 8) });
    }
    bands.forEach((band, bi) => {
      // smaller rings recede further behind the gate plane
      band.zOff = (outerR - band.r1) * 0.6;
      // position along the gate's radial sweep, 0 innermost .. 1 outermost -
      // drives the one continuous color gradient in ringsRetint
      band.t = Math.max(0, Math.min(1, (band.r0 - holeR) / Math.max(1, outerR - holeR)));
      // real 3D torus now, not a flat image-textured plane - so every ring
      // reads correctly (round, with actual depth) from any angle instead
      // of looking like a flat cutout off-axis. Built at outer-radius==1
      // so the same baseScale-driven pulse animation below still works
      // exactly as it did for the plane version.
      // tube pumped up 2.2x thicker than the band's own width so every
      // ring unmistakably reads as a real 3D torus, not a thin flat rim -
      // then a per-band multiplier (0.75-1.5x) so rings vary in thickness
      // instead of all reading the same, some notably chunkier/thinner
      const thickMul = 0.75 + h(gi * 23 + bi, 31) * 0.75;
      const midR = (band.r0 + band.r1) / 2, tubeR = (band.r1 - band.r0) / 2 * 2.2 * thickMul;
      band.geo = new THREE.TorusGeometry(midR / band.r1, tubeR / band.r1, 10, 48);
    });
    ringsGates.push({ bands, outerR });
  }
  // rep -1 keeps a full chunk of gates BEHIND the camera too, so the ring
  // stream continues seamlessly in every direction - nothing visibly
  // pops or resets as the wrap comes around
  for (let rep = -1; rep < RINGS_REPEATS; rep++){
    for (let gi = 0; gi < gatesPerChunk; gi++){
      const gate = ringsGates[gi];
      const gz = gateZ[gi] - rep * RINGS_CHUNK_LENGTH;
      // the gate sits on the serpentine spine at its own depth
      const bend = ringsPathAt(-gz);
      gate.bands.forEach((band, bi) => {
        // the band's own base color is shared (set once in ringsRetint),
        // but each mesh instance gets its OWN material so the light-up
        // wave can brighten individual rings independently without
        // affecting every repeated copy of that band at once
        if (!band.baseColor) band.baseColor = new THREE.Color(0xffffff);
        const mesh = new THREE.Mesh(band.geo, new THREE.MeshBasicMaterial({ color: band.baseColor }));
        mesh.userData.band = band;
        mesh.position.set(bend.x, bend.y, gz - band.zOff);
        const baseScale = band.r1;
        mesh.scale.set(baseScale, baseScale, 1);
        mesh.userData.baseX = bend.x; mesh.userData.baseY = bend.y;
        mesh.userData.baseScale = baseScale;
        mesh.userData.drift = 1.2 + h(gi * 17 + bi, 9) * 2.6;
        mesh.userData.phase = h(gi * 19 + bi, 10) * Math.PI * 2;
        mesh.userData.rate = 0.03 + h(gi * 23 + bi, 11) * 0.05;
        mesh.userData.gate = gi + rep * gatesPerChunk;
        mesh.frustumCulled = false;
        ringsGroup.add(mesh);
      });
    }
  }
  // the light at the end of the tunnel: a big soft glow far down the spine
  const glowCv = document.createElement("canvas");
  glowCv.width = glowCv.height = 128;
  const gg = glowCv.getContext("2d");
  const grad = gg.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, "rgba(255,252,244,1)");
  grad.addColorStop(0.35, "rgba(255,244,225,0.75)");
  grad.addColorStop(1, "rgba(255,244,225,0)");
  gg.fillStyle = grad; gg.fillRect(0, 0, 128, 128);
  ringsGlowMat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(glowCv), transparent: true,
    opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false });
  ringsGlowMat.fog = false;
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), ringsGlowMat); // 2x bigger
  const glowBend = ringsPathAt(280);
  glow.position.set(glowBend.x, glowBend.y, -280);
  glow.frustumCulled = false;
  ringsScenery.add(glow);
  // the same gradient.mp4 wash used as the screen-space overlay, also
  // placed as a real plane far down the tunnel's spine - reuses the
  // existing <video> element (already playing/looping) rather than
  // loading the clip a second time
  const gradientVideoEl = document.getElementById("gradient-overlay");
  if (gradientVideoEl){
    const gradientVideoTex = new THREE.VideoTexture(gradientVideoEl);
    const gradientMat = new THREE.MeshBasicMaterial({ map: gradientVideoTex, transparent: true,
      opacity: 0.15, depthWrite: false });
    gradientMat.fog = false;
    const gradientPlane = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), gradientMat);
    const gradientBend = ringsPathAt(280);
    gradientPlane.position.set(gradientBend.x, gradientBend.y, -282);
    gradientPlane.frustumCulled = false;
    ringsScenery.add(gradientPlane);
  }
}
ringsGroup.visible = false;
ringsScenery.visible = false;
scene.add(ringsGroup);
scene.add(ringsScenery);
// far gates dissolve into the solid backdrop (no dark specks in the deep),
// but light enough that the 150%-sized bore still reads several gates deep
const ringsFog = new THREE.FogExp2(0x000000, 0.008);
// starfield streaming from the deep past the camera
const ringsStars = (() => {
  const h = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
  const group = new THREE.Group();
  // sizes now perspective-scaled (was a fixed pixel size) so stars visibly
  // grow as they near the camera, tuned so the closest read at ~5px
  [[160, 0.7], [40, 1.3]].forEach(([count, size], si) => {
    const positions = [];
    for (let rep = -1; rep < RINGS_REPEATS; rep++){
      for (let i = 0; i < count; i++){
        positions.push((h(i * 3 + si * 97, 1) - 0.5) * 300, (h(i * 5 + si * 31, 2) - 0.5) * 220,
          -h(i * 7 + si * 53, 3) * RINGS_CHUNK_LENGTH - rep * RINGS_CHUNK_LENGTH);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({ size, sizeAttenuation: true, map: roadDotTexture,
      color: 0xffffff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
    mat.fog = false;
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    group.add(points);
  });
  group.visible = false;
  scene.add(group);
  return group;
})();
function ringsRetint(tr){
  const { dominant, others } = artistScenePalette(tr);
  // ONE continuous gradient across each gate's radial sweep: deep artist
  // shade at the innermost ring, through the full artist color, out into
  // the other artists' hues - every circle sits on the same ramp, so all
  // rings match
  // intense ramp with far more variety (+25% punch across the board):
  // artist shades interleaved with four other-artist hues and a bright tint
  const stops = [
    dominant.clone().multiplyScalar(0.63),
    dominant.clone().multiplyScalar(1.6), // the 2nd stop - brighter still, this is the one that reads deepest into the tunnel
    others[0].clone().multiplyScalar(1.25),
    dominant.clone().lerp(new THREE.Color(0xffffff), 0.35),
    others[1 % others.length].clone().multiplyScalar(1.25),
    dominant.clone().multiplyScalar(0.95),
    others[2 % others.length].clone().multiplyScalar(1.25),
    others[3 % others.length].clone().multiplyScalar(1.25),
  ];
  // more intense across the board - a straight saturation/brightness
  // punch on top of the ramp above, plus a little brighter still
  stops.forEach(c => c.offsetHSL(0, 0.16, 0.03).multiplyScalar(1.15));
  const gradientAt = t => {
    const f = t * (stops.length - 1);
    const i0 = Math.min(stops.length - 2, Math.floor(f));
    return stops[i0].clone().lerp(stops[i0 + 1], f - i0);
  };
  // solid color per band, straight onto the real torus mesh material - same
  // brightness-jitter ramp as before, no canvas/texture step needed now
  // that each ring is real geometry instead of a flat painted image
  ringsGates.forEach(gate => {
    gate.bands.forEach(band => {
      const seed = band.r0 * 7.13 + band.t * 11;
      const jitter = 0.85 + ((Math.sin(seed * 91.7) * 43758.5453) % 1 + 1) % 1 * 0.3;
      if (band.baseColor) band.baseColor.copy(gradientAt(band.t)).multiplyScalar(jitter);
    });
  });
  // the end-of-tunnel glow: the artist color at half brightness
  if (ringsGlowMat) ringsGlowMat.color.copy(dominant).multiplyScalar(0.5);
}

/* ---------- Scene 5 "NATURE": elements of nature after the foam/bubble
   references - winding organic streams of round dots (dense sprays of
   tiny bubbles clumping around scattered big circles) drifting through
   black space. The camera flies through them slowly, wandering in every
   direction along a winding path. ---------- */
const CHECK_CHUNK_LENGTH = 140;
const CHECK_REPEATS = 3;
const CHECK_SPEED = 6; // slow drift
// the flight path winds through the streams (periodic per chunk)
function checkPathAt(dist){
  const a = (dist / CHECK_CHUNK_LENGTH) * Math.PI * 2;
  return {
    x: Math.sin(a) * 10 + Math.sin(a * 3 + 1) * 4,
    y: Math.sin(a * 2 + 2) * 8 + Math.sin(a * 5) * 3,
  };
}
let checkCamX = 0, checkCamY = 0, checkCamYaw = 0, checkCamPitch = 0, checkCamBank = 0;
const checkGroup = new THREE.Group();
const checkDotMats = []; // [0] big dots in artist color, [1..2] big dots in other hues
// crisp disc sprite: hard edge with only a hair of anti-aliasing, shared
// by EVERY ball so small and big dots carry identical sharp edges
const checkDiscTexture = (() => {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 128;
  const cx = cv.getContext("2d");
  const g = cx.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.92, "rgba(255,255,255,1)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  cx.fillStyle = g;
  cx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(cv);
})();
{
  const h = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
  const smallPos = [], bigPos = [[], [], []];
  // three winding bubble streams per chunk, tiled (incl. one chunk behind
  // the camera so the wander can look anywhere without finding an edge)
  for (let rep = -1; rep < CHECK_REPEATS; rep++){
    for (let s = 0; s < 3; s++){
      for (let i = 0; i < 260; i++){
        const t = i / 260;
        const d = t * CHECK_CHUNK_LENGTH;
        const a = t * Math.PI * 2;
        // strand centerline: its own winding course offset from the path
        const cx = Math.sin(a * 2 + s * 2.1) * 30 + Math.sin(a * 5 + s) * 9;
        const cy = Math.sin(a * 3 + s * 4.2) * 22 + Math.sin(a * 7 + s * 2) * 6;
        const cz = -d - rep * CHECK_CHUNK_LENGTH;
        // clumpy density: stretches of dense spray with real gaps between
        if (h(i * 7 + s * 131, 3) < 0.3) continue;
        const clump = 0.5 + Math.sin(a * 9 + s * 5) * 0.5; // 0..1 density wave
        if (h(i * 13 + s * 57, 4) > clump * 0.9 + 0.15) continue;
        const jr = h(i * 17 + s * 23, 5) ** 2 * 7;
        const ja = h(i * 19 + s * 41, 6) * Math.PI * 2;
        smallPos.push(cx + Math.cos(ja) * jr, cy + Math.sin(ja) * jr * 0.8, cz + (h(i, 7) - 0.5) * 3);
        // occasionally a big circle sits in the spray
        if (h(i * 29 + s * 71, 8) < 0.09){
          bigPos[(i + s) % 3].push(cx + Math.cos(ja) * jr * 0.6, cy + Math.sin(ja) * jr * 0.5, cz + 1.5);
        }
      }
    }
    // sparse loose bubbles floating between the streams
    for (let i = 0; i < 120; i++){
      smallPos.push((h(i * 3 + rep * 97, 10) - 0.5) * 120, (h(i * 5 + rep * 31, 11) - 0.5) * 90,
        -h(i * 11 + rep * 53, 12) * CHECK_CHUNK_LENGTH - rep * CHECK_CHUNK_LENGTH);
    }
  }
  const mkPoints = (positions, size, color, mat) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    // depth-written with an alpha test: every ball occludes correctly by
    // its true z-depth (nearer balls always in front, farther behind),
    // regardless of draw order between the dot layers
    const m = mat || new THREE.PointsMaterial({ size, sizeAttenuation: true, map: checkDiscTexture,
      color, transparent: true, depthWrite: true, alphaTest: 0.5 });
    const points = new THREE.Points(geo, m);
    points.frustumCulled = false;
    checkGroup.add(points);
    return m;
  };
  // the dense spray: tinted per-artist now too (was flat grey, which made
  // most of the scene colorless) - tracked in checkDotMats[0]
  checkDotMats.push(mkPoints(smallPos, 1.1, 0xffffff));
  // the big circles: artist color + two other hues (retinted per artist)
  bigPos.forEach((positions, i) => {
    checkDotMats.push(mkPoints(positions, 4.2 + i * 1.3, 0xffffff));
  });
}
checkGroup.visible = false;
scene.add(checkGroup);
// denser haze: distant dots fade in gradually from the black instead of
// popping into view - a ball is either smoothly emerging or fully there
const checkFog = new THREE.FogExp2(0x000000, 0.01);
function checkRetint(tr){
  const { dominant, others } = artistScenePalette(tr);
  // index 0 is now the dense small-bubble spray (used to be flat grey),
  // 1-3 are the big circles - artist color first, then two other hues.
  // Punched up more intense overall: much less lerp toward white (was
  // washing everything out) and a higher brightness floor
  // a light yellow/green/red touch mixed into the "other hue" circles -
  // subtle (25%), so they stay in the same tone field as the artist
  // palette instead of reading as a separate clashing set of colors
  const checkAccents = [0xffd400, 0x3ddc73, 0xff4d4d];
  checkDotMats.forEach((mat, i) => {
    const c = i === 0 ? dominant.clone().lerp(new THREE.Color(0xffffff), 0.3) // spray - a light tint, stays in the background
      : i === 1 ? dominant.clone()
      : others[(i - 2) % others.length].clone().lerp(new THREE.Color(checkAccents[(i - 2) % checkAccents.length]), 0.25);
    mat.color.copy(c.lerp(new THREE.Color(0xffffff), 0.15).multiplyScalar(0.85));
    mat.color.offsetHSL(0, 0.15, 0);
  });
}

/* ---------- scene navigator: cycle between AUTO (per-artist pick) and
   every world directly, whatever track is playing ---------- */
/* ================================================================
   FIVE REFERENCE SCENES — PORTAL (rounded-rect tunnel), BURST
   (radial teardrops), DOMINO (toppling rows), EYES (blinking field),
   HANDS (waving fans). All chunk-wrapped off the shared flight clock;
   colors follow the artist palette rule (dominant ~50%, others rest)
   ================================================================ */

// -- PORTAL: flying through endless portal walls - each layer a huge
// surface (10x beyond the opening) with a rounded-rect hole, lit with
// specular sheen and a baked soft shadow ring around every opening --
const PORTAL_CHUNK_LENGTH = 216, PORTAL_SPEED = 9;
const portalGroup = new THREE.Group();
const portalFrames = [];
// a real rounded-rect ring with true depth (extruded, not a flat
// canvas-cutout image) - built once and reused by every frame instance
function roundedRectShape(w, hh, r){
  const s = new THREE.Shape();
  const x = -w / 2, y = -hh / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + hh - r);
  s.quadraticCurveTo(x + w, y + hh, x + w - r, y + hh);
  s.lineTo(x + r, y + hh);
  s.quadraticCurveTo(x, y + hh, x, y + hh - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
{
  const portalOuter = roundedRectShape(960, 720, 24);
  portalOuter.holes.push(roundedRectShape(92, 68, 22));
  const portalGeo = new THREE.ExtrudeGeometry(portalOuter, {
    depth: 6, bevelEnabled: true, bevelThickness: 1.6, bevelSize: 1.6, bevelSegments: 2, curveSegments: 14,
  });
  portalGeo.translate(0, 0, -3); // centered on its own z, thickness split evenly front/back
  const FRAME_STEP = 27; // 3x the old spacing between layers
  for (let rep = -1; rep <= 2; rep++){
    for (let i = 0; i < PORTAL_CHUNK_LENGTH / FRAME_STEP; i++){
      // two materials, using ExtrudeGeometry's built-in face-group
      // convention (index 0 = front/back caps, index 1 = the extruded
      // side walls/bevel): the big flat cap areas stay diffuse, while the
      // edges go back to the original hard, high specular sheen
      const capMat = new THREE.MeshPhongMaterial({ specular: 0x444444, shininess: 18 });
      const edgeMat = new THREE.MeshPhongMaterial({ specular: 0xffffff, shininess: 60 });
      const mesh = new THREE.Mesh(portalGeo, [capMat, edgeMat]);
      mesh.position.z = -(rep * PORTAL_CHUNK_LENGTH + i * FRAME_STEP);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.ci = i; // color index - stable per ring so the rainbow order holds
      portalFrames.push(mesh);
      portalGroup.add(mesh);
    }
  }
}
portalGroup.visible = false;
scene.add(portalGroup);
// the sheen: a roaming point light near the camera raking the walls,
// plus a dim ambient so the far side of each wall never goes fully black
const portalLight = new THREE.PointLight(0xffffff, 0.7, 320, 1.6); // less heavy than before (was 1.15)
portalLight.position.set(20, 30, -14);
portalLight.visible = false;
scene.add(portalLight);
const portalAmbient = new THREE.AmbientLight(0xffffff, 0.75); // raised to keep the panels visible with the dimmer point light
portalAmbient.visible = false;
scene.add(portalAmbient);
const portalFog = new THREE.FogExp2(0x070707, 0.014);
function portalRetint(tr){
  const { dominant, others } = artistScenePalette(tr);
  const cols = [
    dominant, dominant.clone().lerp(new THREE.Color(0xffffff), 0.35),
    others[0], dominant.clone().multiplyScalar(0.7),
    others[1 % others.length], dominant,
    others[2 % others.length], others[3 % others.length],
  ];
  portalFrames.forEach(m => {
    const c = cols[m.userData.ci % cols.length];
    m.material[0].color.copy(c);
    m.material[1].color.copy(c);
  });
  // the far distance now fades to a dark version of the artist color
  // instead of a flat near-black
  portalFog.color.copy(dominant).multiplyScalar(0.18);
}

// -- DOMINO: a single toppling row travelling in a wave as we pass --
const DOMINO_CHUNK_LENGTH = 150, DOMINO_SPEED = 8;
const dominoGroup = new THREE.Group();
const dominoPivots = [];
const dominoDarkMat = new THREE.MeshPhongMaterial({ color: 0x101010, specular: 0xcccccc, shininess: 80 });
const dominoAltMats = [0, 1, 2, 3].map(() => new THREE.MeshPhongMaterial({ color: 0x101010, specular: 0xcccccc, shininess: 80 }));
const dominoFloorMat = new THREE.MeshPhongMaterial({ color: 0x992222, specular: 0xffffff, shininess: 110,
  transparent: true, opacity: 0.72, side: THREE.DoubleSide });
// normal blending (was multiply) so fog actually fades this layer out with
// the rest of the ground instead of staying visible forever - multiply
// blending has no distance term of its own, and disabling fog on it (the
// old fix for multiply fighting fog) meant it just never faded at all
const dominoFloorOverlayMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.15,
  depthWrite: false });
// mirror counterparts - the same shared-material trick ROADS uses for its
// floor reflections, just kept separate so they can sit darker/translucent
// beneath the real floor
const dominoMirrorDarkMat = new THREE.MeshBasicMaterial({ color: 0x101010, transparent: true, opacity: 0.4 });
const dominoMirrorAltMats = [0, 1, 2, 3].map(() => new THREE.MeshBasicMaterial({ color: 0x101010, transparent: true, opacity: 0.4 }));
// the run's curved centerline - periodic over the chunk so the endless
// wrap lands on itself; also drives the camera follow in animate(). Bends
// much harder now (more degrees of turn) than the original gentle S-curve
function dominoPathX(z){
  const a = (z / DOMINO_CHUNK_LENGTH) * Math.PI * 2;
  // a new, more winding route - three integer-multiple sine terms so it
  // still closes perfectly on itself at the chunk seam
  return Math.sin(a * 3) * 16 + Math.sin(a * 2 - 1) * 24 + Math.sin(a + 2) * 12;
}
{
  // every stone is the same flat round disc - same footprint (5.4
  // diameter, 0.9 thick) the old rectangular slab used
  const HEX_H = 5.4, HEX_T = 0.9;
  const roundGeo = new THREE.CylinderGeometry(HEX_H / 2, HEX_H / 2, HEX_T, 24);
  roundGeo.rotateX(Math.PI / 2);
  const h = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
  // yaw group (pivot at the ground, faces along the run) wrapping a tip
  // hinge (the animated topple) wrapping the stone itself
  // every stone now topples all the way down (flat is size-independent -
  // 90 degrees is 90 degrees whatever the stone's height), so what makes
  // the fall actually LOOK like a chain reaction is purely the spacing:
  // see TOUCH_RATIO below
  const DOMINO_MAX_TOPPLE = Math.PI / 2 * 0.98;
  const addStone = (rep, x, z, yaw, stagger, mi, sizeScale) => {
    // palette rule: half the stones near-black like the reference, half
    // in dark variants of the other artists' colors
    const useAlt = h(mi, 7) < 0.5;
    const pv = new THREE.Group();
    pv.position.set(x, 0, -(rep * DOMINO_CHUNK_LENGTH + z));
    pv.rotation.y = yaw;
    const tip = new THREE.Group();
    const mesh = new THREE.Mesh(roundGeo, useAlt ? dominoAltMats[mi % 4] : dominoDarkMat);
    mesh.scale.setScalar(sizeScale);
    mesh.position.y = 2.7 * sizeScale;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    tip.add(mesh);
    pv.add(tip);
    pv.userData.stagger = stagger;
    pv.userData.tip = tip;
    pv.userData.maxTopple = DOMINO_MAX_TOPPLE;
    pv.userData.mesh = mesh;
    dominoPivots.push(pv);
    dominoGroup.add(pv);
  };
  // realistic spacing: the gap to the next stone is sized from the
  // FALLING stone's own height (not a fixed distance), so when it topples
  // all the way flat its tip lands right at - and visibly touches - the
  // next stone, whatever size either one is. A fixed STEP couldn't do
  // this: taller stones left a visible gap they never actually reached,
  // shorter ones overshot into the next slot
  const TOUCH_RATIO = 0.21; // half the previous distance (was 0.42) - same fixed step for every stone
  // stone count sized from the ACTUAL expected gap (TOUCH_RATIO applied to
  // the average stone height), not a stale unrelated constant - that
  // mismatch was the real bug: it undercounted stones, so the chain only
  // filled the first half of each chunk repeat and then just stopped,
  // leaving a long dead gap (an "interruption") before the next repeat
  // every stone the same size now, so the spacing math is just a fixed step
  const STEP_AVG = HEX_H * TOUCH_RATIO;
  const N = Math.ceil(DOMINO_CHUNK_LENGTH / STEP_AVG) + 2; // +2 margin so it slightly overlaps the seam rather than gapping it
  const sizes = [];
  for (let i = 0; i <= N; i++) sizes.push(1);
  const gaps = [];
  for (let i = 0; i < N; i++) gaps.push(sizes[i] * HEX_H * TOUCH_RATIO);
  for (let rep = -1; rep <= 1; rep++){
    let z = 0;
    for (let i = 0; i < N; i++){
      const gap = gaps[i];
      const x = dominoPathX(z);
      const yaw = -Math.atan2(dominoPathX(z + gap) - x, gap);
      // a small per-stone timing jitter for a natural, not-perfectly-
      // robotic wave - but bounded well under the gap so it can NEVER flip
      // two neighbours' fall order (that inversion was why a later stone
      // could topple before the one ahead of it and appear to fall
      // straight through it)
      addStone(rep, x, z, yaw, (h(i, 8) - 0.5) * 0.6, i, sizes[i]);
      z += gap;
    }
  }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 700), dominoFloorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.z = -200;
  floor.receiveShadow = true;
  dominoGroup.add(floor);
  // the op-art photo sheet, tiled across the ground as a 30%-opacity
  // overlay riding just above the floor - its own texture instance (not
  // one shared with CUBE) so its own repeat/tiling never touches theirs
  const dominoFloorOverlayTex = new THREE.TextureLoader().load("assets/tiles/" + TILE_IMAGE_FILES[3]);
  dominoFloorOverlayTex.wrapS = dominoFloorOverlayTex.wrapT = THREE.RepeatWrapping;
  dominoFloorOverlayTex.repeat.set(8, 14);
  dominoFloorOverlayMat.map = dominoFloorOverlayTex;
  const floorOverlay = new THREE.Mesh(new THREE.PlaneGeometry(400, 700), dominoFloorOverlayMat);
  floorOverlay.rotation.x = -Math.PI / 2;
  floorOverlay.position.set(0, 0.03, -200); // a hair above the real floor - no z-fighting
  dominoGroup.add(floorOverlay);
}
dominoGroup.visible = false;
scene.add(dominoGroup);
// a full mirrored clone beneath the floor (scale.y=-1) - same technique
// as ROADS' cube reflections, just applied to the whole toppling row at
// once so the now-translucent floor genuinely reflects the dominoes
const dominoMirrorGroup = dominoGroup.clone(true);
dominoMirrorGroup.scale.y = -1;
dominoMirrorGroup.traverse(obj => {
  if (!obj.isMesh) return;
  if (obj.material === dominoFloorMat || obj.material === dominoFloorOverlayMat){ obj.visible = false; return; }
  const altIdx = dominoAltMats.indexOf(obj.material);
  obj.material = altIdx >= 0 ? dominoMirrorAltMats[altIdx] : dominoMirrorDarkMat;
  obj.castShadow = false;
  obj.receiveShadow = false;
});
const dominoMirrorTips = dominoPivots.map((pv, i) => dominoMirrorGroup.children[i].children[0]);
dominoMirrorGroup.visible = false;
scene.add(dominoMirrorGroup);
// the light rig - dominoes were unlit before; now specular needs an
// actual light source, same "travels with the camera" pattern as TILES
const dominoDirLight = new THREE.DirectionalLight(0xffffff, 0.7);
dominoDirLight.castShadow = true;
dominoDirLight.shadow.radius = 6;
// widened + sharpened so the stones actually throw a visible shadow onto
// the floor (was 512/±50 - too small/soft to read, and too narrow to
// cover the second lane's wider spread)
dominoDirLight.shadow.mapSize.set(1024, 1024);
dominoDirLight.shadow.camera.left = -100;
dominoDirLight.shadow.camera.right = 100;
dominoDirLight.shadow.camera.top = 100;
dominoDirLight.shadow.camera.bottom = -100;
dominoDirLight.shadow.camera.near = 1;
dominoDirLight.shadow.camera.far = 100;
dominoDirLight.shadow.bias = -0.0015;
dominoDirLight.visible = false;
scene.add(dominoDirLight);
scene.add(dominoDirLight.target);
const dominoAmbient = new THREE.AmbientLight(0xffffff, 0.4);
dominoAmbient.visible = false;
scene.add(dominoAmbient);
const dominoBgColor = new THREE.Color(0x220808);
// denser still (was 0.01, then 0.022) - pulls the ground into the
// background much closer to the camera instead of only fading out near
// the far edge of the visible run
const dominoFog = new THREE.FogExp2(0x220808, 0.028); // less dense still - more of the scene visible (was 0.036)
function dominoRetint(tr){
  const { dominant } = artistScenePalette(tr);
  dominoFloorMat.color.copy(dominant.clone().multiplyScalar(0.8));
  // every stone a lighter version of the artist's color, in four shades
  // (was 0.28/0.2-0.46 - read as near-black; brightened well clear of that)
  dominoDarkMat.color.copy(dominant.clone().multiplyScalar(0.55));
  const shades = [0.45, 0.58, 0.7, 0.85];
  dominoAltMats.forEach((m, i) => m.color.copy(dominant.clone().multiplyScalar(shades[i % shades.length])));
  // mirror stones darker still - a reflection, not a duplicate
  dominoMirrorDarkMat.color.copy(dominant.clone().multiplyScalar(0.28)).multiplyScalar(0.5);
  dominoMirrorAltMats.forEach((m, i) => m.color.copy(dominant.clone().multiplyScalar(shades[i % shades.length])).multiplyScalar(0.5));
  dominoBgColor.copy(dominant.clone().multiplyScalar(0.5));
  dominoFog.color.copy(dominoBgColor);
}

// -- EYES: a floating field of blinking eyes on an artist-color sky --
const EYES_CHUNK_LENGTH = 220, EYES_SPEED = 5;
const eyesGroup = new THREE.Group();
const eyesList = [];
const eyesIrisMats = [];
{
  // every part is real vector geometry now (THREE.Shape), not a canvas
  // texture - a unit almond for the sclera, an annulus + a separate solid
  // disc for the iris/pupil, each instance just scaling the shared shape
  const eyeSclShape = new THREE.Shape();
  eyeSclShape.moveTo(-0.5, 0);
  eyeSclShape.quadraticCurveTo(0, 0.5, 0.5, 0);
  eyeSclShape.quadraticCurveTo(0, -0.5, -0.5, 0);
  eyeSclShape.closePath();
  const eyeSclGeo = new THREE.ShapeGeometry(eyeSclShape, 16);
  const eyeIrisRingShape = new THREE.Shape();
  eyeIrisRingShape.absarc(0, 0, 0.5, 0, Math.PI * 2, false);
  const irisHole = new THREE.Path();
  irisHole.absarc(0, 0, 0.27, 0, Math.PI * 2, true);
  eyeIrisRingShape.holes.push(irisHole);
  const eyeIrisRingGeo = new THREE.ShapeGeometry(eyeIrisRingShape, 24);
  const eyePupilShape = new THREE.Shape();
  eyePupilShape.absarc(0, 0, 0.27, 0, Math.PI * 2, false);
  const eyePupilGeo = new THREE.ShapeGeometry(eyePupilShape, 24);
  const eyePupilMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const sclMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false });
  for (let i = 0; i < 5; i++) eyesIrisMats.push(new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
  const h = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
  const N = 18; // half the count (was 36)
  for (let rep = -1; rep <= 1; rep++){
    for (let i = 0; i < N; i++){
      const eye = new THREE.Group();
      const size = 10 + h(i, 11) * 18;
      const scl = new THREE.Mesh(eyeSclGeo, sclMat);
      const sclBaseH = size / 2 * 1.25 * 1.25; // half its own width, +25% taller twice now, open-eye state
      scl.scale.set(size, sclBaseH, 1);
      const irisRing = new THREE.Mesh(eyeIrisRingGeo, eyesIrisMats[i % eyesIrisMats.length]);
      const pupil = new THREE.Mesh(eyePupilGeo, eyePupilMat);
      pupil.position.z = 0.01;
      const iris = new THREE.Group();
      iris.add(irisRing); iris.add(pupil);
      iris.scale.set(size * 0.375 * 0.7, size * 0.375 * 0.7, 1); // 70% of the previous size
      // NOT renderOrder - a fixed renderOrder is scene-global, so it was
      // forcing every eye's circles in front of every OTHER eye's white
      // too, including bigger/closer eyes that should occlude a smaller/
      // farther eye's circles. A real (if small) z-offset lets Three's
      // normal per-object distance sort get both right: each eye's own
      // circles land in front of its own white, AND eyes still correctly
      // occlude each other by actual distance from the camera.
      iris.position.z = 0.6;
      eye.add(iris); eye.add(scl); // circle added before the white
      // biased toward the sides (left/right) and away from dead center,
      // so the camera's own flight corridor down the middle stays open
      const side = h(i, 12) < 0.5 ? -1 : 1;
      const ex = side * (14 + h(i, 18) * 31); // |x| in [14, 45] - never right on the centerline
      const ey = (h(i, 13) - 0.5) * 60;
      eye.position.set(ex, ey,
        -(rep * EYES_CHUNK_LENGTH + (i / N) * EYES_CHUNK_LENGTH + h(i, 14) * 8));
      eye.userData.blinkPhase = h(i, 15) * Math.PI * 2;
      eye.userData.blinkSpeed = 0.7 + h(i, 16) * 0.8;
      eye.userData.doubleWink = h(i, 17) < 0.35; // these sometimes wink twice, fast
      eye.userData.size = size;
      eye.userData.sclBaseH = sclBaseH;
      // base position + outward direction, used in animate() to gently
      // shove an eye away from the camera's path as it nears it
      eye.userData.baseX = ex;
      eye.userData.baseY = ey;
      const outLen = Math.hypot(ex, ey) || 1;
      eye.userData.outX = ex / outLen;
      eye.userData.outY = ey / outLen;
      eye.userData.scl = scl;
      eye.userData.iris = iris;
      eyesList.push(eye);
      eyesGroup.add(eye);
    }
  }
}
eyesGroup.visible = false;
// little cubes in the eyes' own iris colors, flying through a little
// faster than the eyes themselves
const EYES_CUBE_SPEED_MULT = 2.1; // 1.5x faster still (was 1.4)
const eyesCubeMats = [];
const eyesCubesGroup = new THREE.Group();
const eyesCubeList = [];
{
  const h = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
  for (let i = 0; i < 5; i++) eyesCubeMats.push(new THREE.MeshPhongMaterial({ specular: 0xffffff, shininess: 70,
    transparent: true, opacity: 0.5 }));
  const cubeGeo = new THREE.BoxGeometry(1, 1, 1);
  const NC = 40;
  for (let rep = -1; rep <= 1; rep++){
    for (let i = 0; i < NC; i++){
      const cube = new THREE.Mesh(cubeGeo, eyesCubeMats[i % eyesCubeMats.length]);
      const r = 1.2 + h(i, 80) * 2.2;
      cube.scale.setScalar(r);
      // biased away from the centerline too, same as the eyes, so the
      // flight corridor down the middle stays clear of clutter
      const cside = h(i, 81) < 0.5 ? -1 : 1;
      const baseX = cside * (16 + h(i, 84) * 34);
      const baseY = (h(i, 82) - 0.5) * 70;
      cube.position.set(baseX, baseY,
        -(rep * EYES_CHUNK_LENGTH + (i / NC) * EYES_CHUNK_LENGTH + h(i, 83) * 8));
      // spins on its own axis while it bobs up/down around its base y
      cube.userData.spinAxis = new THREE.Vector3(h(i, 85) - 0.5, h(i, 86) - 0.5, h(i, 87) - 0.5).normalize();
      cube.userData.spinRate = 0.4 + h(i, 88) * 0.8;
      cube.userData.baseX = baseX;
      cube.userData.baseY = baseY;
      cube.userData.bobAmp = 3 + h(i, 89) * 5;
      cube.userData.bobRate = 0.3 + h(i, 90) * 0.4;
      cube.userData.bobPhase = h(i, 91) * Math.PI * 2;
      // same outward-avoidance direction the eyes use, so the cubes push
      // off the camera's path the same way as it nears them
      const outLen = Math.hypot(baseX, baseY) || 1;
      cube.userData.outX = baseX / outLen;
      cube.userData.outY = baseY / outLen;
      eyesCubeList.push(cube);
      eyesCubesGroup.add(cube);
    }
  }
}
eyesCubesGroup.visible = false;
scene.add(eyesCubesGroup);
scene.add(eyesGroup);
// a light for the cubes' specular highlights to actually show - EYES had
// no light source at all before, so the material's specular/shininess
// never had anything to catch
const eyesCubeLight = new THREE.DirectionalLight(0xffffff, 0.8);
eyesCubeLight.position.set(20, 40, 20);
eyesCubeLight.visible = false;
scene.add(eyesCubeLight);
const eyesCubeAmbient = new THREE.AmbientLight(0xffffff, 0.45);
eyesCubeAmbient.visible = false;
scene.add(eyesCubeAmbient);
const eyesBgColor = new THREE.Color(0x102040);
// denser than before (was 0.008) so eyes and cubes actually blend into
// the background color as they get distant, instead of staying clearly
// visible at any range
const eyesFog = new THREE.FogExp2(0x102040, 0.016);
function eyesRetint(tr){
  const { dominant, others } = artistScenePalette(tr);
  // irises: half in the artist's color, the rest in the other artists'
  eyesIrisMats.forEach((m, i) => m.color.copy(i % 2 === 0 ? dominant : others[i % others.length]));
  // little flying cubes: same palette split as the irises
  eyesCubeMats.forEach((m, i) => m.color.copy(i % 2 === 0 ? dominant : others[i % others.length]));
  eyesBgColor.copy(dominant.clone().multiplyScalar(0.55));
  eyesFog.color.copy(eyesBgColor);
}

// -- HANDS: a real 3D flythrough of the referenced clip - a hexagonal
// tunnel of big screens all playing the same video, so flying down the
// tunnel reads as flying THROUGH the footage rather than past a flat
// picture of it --
const HANDS_CHUNK_LENGTH = 216, HANDS_SPEED = 5;
const handsGroup = new THREE.Group();
const handsList = [];
const handsVideoEl = document.createElement("video");
handsVideoEl.muted = true; handsVideoEl.loop = true; handsVideoEl.playsInline = true;
handsVideoEl.crossOrigin = "anonymous";
handsVideoEl.src = "/panorama2/" + encodeURIComponent("From Klickpin.com- 712624341076768821-pin-id-712624341076768821.mp4");
handsVideoEl.load();
const handsVideoTex = new THREE.VideoTexture(handsVideoEl);
// one shared material - the video only ever decodes once, no matter how
// many tunnel panels are showing it at once
const handsVideoMat = new THREE.MeshBasicMaterial({ map: handsVideoTex, side: THREE.DoubleSide });
{
  const RING_R = 20, SPHERE_R = 8, SIDES = 6, STEP = 24;
  const stations = Math.round(HANDS_CHUNK_LENGTH / STEP);
  const h = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
  // low-poly sphere, exactly 40 triangular faces (5 width x 5 height
  // segments -> 5*4*2 = 40) - the video plays across its facets instead
  // of one flat screen
  const sphereGeo = new THREE.SphereGeometry(SPHERE_R, 5, 5);
  for (let rep = -1; rep <= 1; rep++){
    for (let si = 0; si < stations; si++){
      const z = -(rep * HANDS_CHUNK_LENGTH + si * STEP);
      // alternating stations rotate half a slot, and a couple faces per
      // station are skipped, so the tunnel isn't a rigid repeating drum -
      // open sightlines and real gaps to fly past as well as through
      const rot = (si % 2) * (Math.PI / SIDES);
      for (let k = 0; k < SIDES; k++){
        if (h(si * 7 + k, 40) < 0.16) continue;
        const a = (k / SIDES) * Math.PI * 2 + rot;
        const mesh = new THREE.Mesh(sphereGeo, handsVideoMat);
        const bx = Math.cos(a) * RING_R, by = Math.sin(a) * RING_R * 0.72;
        mesh.position.set(bx, by, z);
        // each sphere spins slowly around its own random axis
        mesh.userData.spinAxis = new THREE.Vector3(h(si * 13 + k, 41) - 0.5, h(si * 17 + k, 42) - 0.5, h(si * 19 + k, 43) - 0.5).normalize();
        mesh.userData.spinRate = 0.15 + h(si * 23 + k, 44) * 0.25;
        // base ring position + outward direction, used in animate() to
        // gently shove a sphere off the tunnel wall as the camera nears it
        mesh.userData.baseX = bx;
        mesh.userData.baseY = by;
        const outLen = Math.hypot(bx, by) || 1;
        mesh.userData.outX = bx / outLen;
        mesh.userData.outY = by / outLen;
        handsList.push(mesh);
        handsGroup.add(mesh);
      }
    }
  }
}
// a fast-moving star field - flies past noticeably quicker than the
// sphere tunnel itself, via its own scroll speed in animate()
const HANDS_STAR_COUNT = 500;
const handsStarsGeo = new THREE.BufferGeometry();
{
  const pos = new Float32Array(HANDS_STAR_COUNT * 3);
  const h = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
  for (let i = 0; i < HANDS_STAR_COUNT; i++){
    pos[i * 3] = (h(i, 51) - 0.5) * 140;
    pos[i * 3 + 1] = (h(i, 52) - 0.5) * 100;
    pos[i * 3 + 2] = -h(i, 53) * HANDS_CHUNK_LENGTH * 2;
  }
  handsStarsGeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
}
// a round sprite - without a map, PointsMaterial draws each point as a
// flat square, which was reading as "dots"/squares instead of circles
const handsStarTex = (() => {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 64;
  const g = cv.getContext("2d");
  const rad = g.createRadialGradient(32, 32, 0, 32, 32, 30);
  rad.addColorStop(0, "rgba(255,255,255,1)");
  rad.addColorStop(0.8, "rgba(255,255,255,1)");
  rad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = rad; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
})();
const handsStarsMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.9, sizeAttenuation: true,
  map: handsStarTex, transparent: true, opacity: 0.85, depthWrite: false });
const handsStars = new THREE.Points(handsStarsGeo, handsStarsMat);
handsStars.frustumCulled = false;
handsGroup.add(handsStars);
handsGroup.visible = false;
scene.add(handsGroup);
const handsBgColor = new THREE.Color(0x401008);
const handsFog = new THREE.FogExp2(0x401008, 0.008);
function handsRetint(tr){
  const { dominant } = artistScenePalette(tr);
  // the video itself stays untinted (raw footage) - only the fog/backdrop
  // beyond the tunnel picks up the artist color, same as every other scene
  handsBgColor.copy(dominant.clone().multiplyScalar(0.45));
  handsFog.color.copy(handsBgColor);
  if (handsVideoEl.paused) handsVideoEl.play().catch(() => {});
}

/* ---------- Scene "ORBS": like SPHERE, but instead of one static
   sphere it's a row of spheres strung along a single straight line (per
   the reference sketch - three-plus overlapping circles seen from
   above, one center line straight through all of them), with the
   camera gliding forward and backward along that same line rather than
   flying endlessly one-way. Every sphere has its own two polar caps -
   the actual surface area that would sit inside its neighbor - cut away
   as real geometry, not just occluded by depth testing, so each one is
   a genuine open tube you see straight through into the next. All
   spheres show the same panorama video the plain SPHERE scene uses. */
const SC_R = 55;             // every sphere's radius
const SC_STEP = 70;          // distance between consecutive sphere centers (< 2*SC_R, so they overlap)
const SC_COUNT = 5;          // spheres in the row (sketch shows 3+; a couple extra reads better)
const SC_OSC_AMP = (SC_COUNT - 1) / 2 * SC_STEP - 10; // swing just short of the outermost sphere's center
const SC_OSC_PERIOD = 26;    // seconds for one full forward-and-back cycle
const orbsGroup = new THREE.Group();
// same shared texture the plain SPHERE scene plays, kept in sync with
// it in loadPanoFile() (video or gif, whichever is currently loaded) -
// "same video in all spheres" falls out for free from reusing one material
const orbsMat = new THREE.MeshBasicMaterial({ map: panoTexture, side: THREE.DoubleSide });
{
  // the sphere-sphere intersection circle, for two equal-radius spheres
  // whose centers are SC_STEP apart, sits at the exact midpoint between
  // them - its angular radius (measured from either center, off the
  // line joining them) is acos((SC_STEP/2)/SC_R). Padded a few degrees
  // wider so the cut is a hair bigger than the true overlap: no thin
  // ring of surface left poking through the opening, no seam.
  const cutAngle = Math.acos((SC_STEP / 2) / SC_R) + 0.05;
  const geo = new THREE.SphereGeometry(SC_R, 48, 32, 0, Math.PI * 2, cutAngle, Math.PI - cutAngle * 2);
  geo.rotateX(Math.PI / 2); // poles (theta=0/PI) now point along +Z/-Z, the row's own axis
  geo.scale(-1, 1, 1); // inside-out, same trick as the pano patch - front faces point inward
  for (let i = 0; i < SC_COUNT; i++){
    const orb = new THREE.Mesh(geo, orbsMat);
    orb.position.set(0, 0, (i - (SC_COUNT - 1) / 2) * SC_STEP);
    orb.frustumCulled = false;
    orbsGroup.add(orb);
  }
}
orbsGroup.visible = false;
scene.add(orbsGroup);
let orbsCamYaw = 0;

// scene-type navigation (SPHERE/ROAD/PRISM/etc) has been retired - the
// sphere is always the active world now. AUTO, EYES, HANDS, and ORBS were
// already inactive before that; all of their scene code is left in place,
// just never selected
const sceneOverride = "sphere";

// swaps the sphere for a per-artist 3D scene: Polaroid gets the synthwave
// road, Aveluna gets the mist world. Called on every track load (see
// load()) and once more from the gate handoff, since the very first
// "current" track is only known then. Also drives the renderer clear
// color + scene fog to match whichever scene is up.
function updateArtistBackground(tr){
  const gateActive = document.body.classList.contains("gate-active");
  // AUTO keeps the original per-artist picks; any other navigator choice
  // forces that world for every track (colors still follow the artist)
  const byArtist = !tr ? "sphere"
    : tr.artist === ROAD_ARTIST_NAME ? "road"
    : tr.artist === MIST_ARTIST_NAME ? "mist"
    : tr.artist === DT_ARTIST_NAME ? "maze"
    : "sphere";
  const sceneId = sceneOverride === "auto" ? byArtist : sceneOverride;
  const wantRoad = !gateActive && sceneId === "road";
  const wantMist = !gateActive && sceneId === "mist";
  const wantMaze = !gateActive && sceneId === "maze";
  const wantTiles = !gateActive && sceneId === "tiles";
  const wantBeams = !gateActive && sceneId === "beams";
  const wantPrism = !gateActive && sceneId === "prism";
  const wantRings = !gateActive && sceneId === "rings";
  const wantCheck = !gateActive && sceneId === "check";
  const wantCube = !gateActive && sceneId === "cube";
  const wantPortal = !gateActive && sceneId === "portal";
  const wantDomino = !gateActive && sceneId === "domino";
  const wantEyes = !gateActive && sceneId === "eyes";
  const wantHands = !gateActive && sceneId === "hands";
  const wantOrbs = !gateActive && sceneId === "orbs";
  const want3d = wantRoad || wantMist || wantMaze || wantTiles || wantBeams || wantPrism || wantRings || wantCheck
    || wantCube || wantPortal || wantDomino || wantEyes || wantHands || wantOrbs;
  // same lerp-follow camera snap as the other flythrough scenes
  if (wantRoad && !roadGroup.visible){
    const here0 = roadCenterAt(flightDist * ROAD_SPEED - 8);
    roadCamX = here0.x; roadCamY = here0.y + ROAD_CAM_HEIGHT;
    roadCamYaw = 0; roadCamPitch = 0; roadCamBank = 0;
  }
  if (wantMist && !mistGroup.visible){
    const here0 = mistPathAt(flightDist * MIST_SPEED - 8);
    mistCamX = here0.x; mistCamY = here0.y;
    mistCamYaw = 0; mistCamPitch = 0; mistCamBank = 0;
    mistFadeStartMs = performance.now(); // flocks fade in over 0.2s from here (see animate())
  }
  roadGroup.visible = wantRoad;
  roadScenery.visible = wantRoad;
  mistGroup.visible = wantMist;
  downtownGroup.visible = wantMaze;
  downtownLight.visible = wantMaze;
  downtownAmbient.visible = wantMaze;
  dtStars.visible = wantMaze;
  // same lerp-follow camera snap as CUBE/RINGS/NATURE
  if (wantTiles && !tilesGroup.visible){
    const here0 = tilesPathAt(flightDist * TILES_SPEED - 8);
    tilesCamX = here0.x; tilesCamY = here0.y;
    tilesCamYaw = 0; tilesCamPitch = 0; tilesCamBank = 0;
  }
  tilesGroup.visible = wantTiles;
  tilesDirLight.visible = wantTiles;
  tilesDirFill.visible = wantTiles;
  tilesAmbient.visible = wantTiles;
  beamsGroup.visible = wantBeams;
  beamsScenery.visible = wantBeams;
  beamsLight.visible = wantBeams;
  beamsAmbient.visible = wantBeams;
  // PRISM's gaze target drifts at an extremely slow lerp rate (0.003) -
  // without a snap here a stale value from a much-earlier visit could
  // take minutes to settle
  if (wantPrism && !prismGroup.visible) prismCamYaw = prismCamPitch = prismCamRoll = 0;
  prismGroup.visible = wantPrism;
  prismStarLayers.forEach(g => { g.visible = wantPrism; });
  // star lights retired - their moving washes read as artifacts
  prismAmbient.visible = wantPrism;
  // snap RINGS' and NATURE's lerp-follow camera state to their correct
  // starting position the instant each scene turns on, same fix as CUBE -
  // otherwise the camera starts wherever it was last left and visibly
  // drifts into place over the first couple of seconds
  if (wantRings && !ringsGroup.visible){
    const here0 = ringsPathAt(flightDist * RINGS_SPEED - 8);
    ringsCamX = here0.x; ringsCamY = here0.y;
    ringsCamYaw = 0; ringsCamPitch = 0; ringsCamBank = 0;
  }
  if (wantCheck && !checkGroup.visible){
    const here0 = checkPathAt(flightDist * CHECK_SPEED - 8);
    checkCamX = here0.x; checkCamY = here0.y;
    checkCamYaw = 0; checkCamPitch = 0; checkCamBank = 0;
  }
  ringsGroup.visible = wantRings;
  ringsScenery.visible = wantRings; // end-of-tunnel glow re-enabled, toned down (see ringsGlowMat)
  ringsStars.visible = wantRings;
  checkGroup.visible = wantCheck;
  portalGroup.visible = wantPortal;
  portalLight.visible = wantPortal;
  portalAmbient.visible = wantPortal;
  dominoGroup.visible = wantDomino;
  dominoMirrorGroup.visible = wantDomino;
  dominoDirLight.visible = wantDomino;
  dominoAmbient.visible = wantDomino;
  eyesGroup.visible = wantEyes;
  eyesCubesGroup.visible = wantEyes;
  eyesCubeLight.visible = wantEyes;
  eyesCubeAmbient.visible = wantEyes;
  handsGroup.visible = wantHands;
  document.body.classList.toggle("scene-hands", wantHands);
  orbsGroup.visible = wantOrbs;
  const wantSphere = !gateActive && !want3d;
  if (panoMesh) panoMesh.visible = wantSphere;
  // snap the lerp-follow camera state straight to the tunnel's centerline
  // the instant this scene turns on - otherwise the camera starts at
  // wherever it was left (often (0,0), outside the bent tube's actual
  // wall radius) and visibly drifts from outside the tunnel to inside it
  // over the first couple of seconds
  if (wantCube && !donutGroup.visible){
    const here0 = cubePathAt(flightDist * CUBEW_SPEED - 8);
    cubeCamX = here0.x; cubeCamY = here0.y;
    cubeCamYaw = 0; cubeCamPitch = 0; cubeCamBank = 0;
  }
  donutGroup.visible = wantCube;
  donutDirLight.visible = wantCube;
  donutDirFill.visible = wantCube;
  donutAmbient.visible = wantCube;
  if (wantCube && tr) donutRetint(tr);
  // the wave visualizer runs 6x taller on the sphere screen (see
  // positionWaveCanvas), so re-measure whenever the scene flips
  document.body.classList.toggle("scene-sphere", wantSphere);
  positionWaveCanvas();
  // vertical-grid overlay shows over every 3D environment (see styles.css;
  // the intro tunnel is covered by its own body.gate-active selector)
  document.body.classList.toggle("scene-3d", want3d);
  // road and mist scenes render over CSS gradient skies (see
  // body.scene-road / body.scene-mist #stage in styles.css)
  document.body.classList.toggle("scene-road", wantRoad);
  document.body.classList.toggle("scene-mist", wantMist);
  document.body.classList.toggle("scene-beams", wantBeams);
  document.body.classList.toggle("scene-check", wantCheck);
  document.body.classList.toggle("scene-rings", wantRings);
  document.body.classList.toggle("scene-maze", wantMaze);
  document.body.classList.toggle("scene-eyes", wantEyes);
  document.body.classList.toggle("scene-prism", wantPrism);
  // tighter lens in every constructed environment (incl. the intro
  // tunnel) = a more zoomed, cinematic framing; only the plain video
  // sphere keeps the natural 1x lens
  camera.zoom = gateActive ? 1.3 : wantRoad ? 1.6 : wantMist ? 1.5 : wantMaze ? 1.35
    : wantTiles ? 1.4 : wantCheck ? 1.6 : (wantBeams || wantPrism || wantRings) ? 1.45
    : wantPortal ? 1.2 : (wantDomino || wantEyes || wantHands) ? 1.35 : 1;
  camera.updateProjectionMatrix();
  if (wantRoad){
    // transparent clear: the sky is a CSS gradient behind the canvas
    // (body.scene-road #stage) - a bit brighter low, darker at the top -
    // while the purple haze still melts the far terrain into the night
    retintRoadStrip(tr.artistColor);
    renderer.setClearColor(0x000000, 0);
    roadFog.color.set(0x120821);
    scene.fog = roadFog;
  } else if (wantMist){
    // transparent clear: the sky is a CSS gradient behind the canvas
    // (body.scene-mist #stage), dark blue low fading to black up top; the
    // haze fades far objects toward a matching deep blue-black
    renderer.setClearColor(0x000000, 0);
    mistFog.color.set(0x0c1330);
    scene.fog = mistFog;
  } else if (wantMaze){
    // near-black warm brown fog swallows the corridor's far end; transparent
    // clear so the CSS black-to-dark-red/blue gradient (body.scene-maze
    // #stage) shows through behind it
    applyDowntownTint(ROADS_BLUE_HEX); // fixed app-wide blue scheme, not per-artist anymore
    renderer.setClearColor(0x000000, 0);
    scene.fog = downtownFog;
  } else if (wantTiles){
    // op-art box, tiles regenerated in the current palette - background
    // and fog both match the artist color at 60% darker
    tilesRetint(tr);
    renderer.setClearColor(tilesFog.color, 1);
    scene.fog = tilesFog;
  } else if (wantBeams){
    // transparent clear: a subtle vertical CSS gradient stands behind the
    // scene (body.scene-beams #stage), while the fog still swallows the
    // far floor
    beamsRetint(tr);
    renderer.setClearColor(0x000000, 0);
    scene.fog = beamsFog;
  } else if (wantPrism){
    // transparent clear - a moving CSS gradient stands behind the scene
    // now (body.scene-prism #stage), replacing the old 3D background blooms
    prismRetint(tr);
    renderer.setClearColor(0x000000, 0);
    scene.fog = prismFog;
  } else if (wantRings){
    ringsRetint(tr);
    // transparent clear - the sky is a CSS gradient behind the canvas
    // (body.scene-rings #stage), same pattern as NATURE's horizon
    renderer.setClearColor(0x000000, 0);
    ringsFog.color.set(0x000000);
    scene.fog = ringsFog;
  } else if (wantCheck){
    checkRetint(tr);
    // transparent clear: a CSS horizon gradient stands behind the scene
    // (black up top into 15% artist color at the bottom)
    renderer.setClearColor(0x000000, 0);
    scene.fog = checkFog;
  } else if (wantCube){
    // fully enclosed donut tunnel - its own walls are the backdrop, and
    // fog softly hazes the far walls for a depth-of-field feel. Clear
    // color matches the fog's own (artist-tinted) color exactly, so the
    // haze fades into the backdrop instead of fading to black
    renderer.setClearColor(donutFog.color, 1);
    scene.fog = donutFog;
  } else if (wantPortal){
    portalRetint(tr);
    renderer.setClearColor(portalFog.color, 1);
    scene.fog = portalFog;
  } else if (wantDomino){
    dominoRetint(tr);
    renderer.setClearColor(dominoBgColor, 1);
    scene.fog = dominoFog;
  } else if (wantEyes){
    // transparent clear - a radial CSS gradient stands behind the scene
    // (body.scene-eyes #stage), artist color at the middle fading to dark
    // grey at the edges
    eyesRetint(tr);
    renderer.setClearColor(0x000000, 0);
    scene.fog = eyesFog;
  } else if (wantHands){
    handsRetint(tr);
    // transparent clear - the horizon is a CSS gradient behind the canvas
    // (body.scene-hands #stage), same pattern as ROADS/RINGS/NATURE
    renderer.setClearColor(0x000000, 0);
    scene.fog = handsFog;
  } else if (wantOrbs){
    // no fog - the camera is always fully enclosed by video-covered
    // sphere walls, there's no distant emptiness to fade
    renderer.setClearColor(0x000000, 1);
    scene.fog = null;
  } else {
    renderer.setClearColor(0x000000, 0);
    scene.fog = null;
  }
}

panoVideoEl.addEventListener("loadedmetadata", () => { if (currentPanoKind === "video") rebuildPanoMesh(); });
panoGifImg.addEventListener("load", () => {
  panoGifCanvas.width = panoGifImg.naturalWidth;
  panoGifCanvas.height = panoGifImg.naturalHeight;
  if (currentPanoKind === "gif") rebuildPanoMesh();
});
rebuildPanoMesh();

function isGifFile(file){ return /\.gif$/i.test(file); }
function loadPanoFile(file, base = "/panorama2/"){
  const src = base + file;
  if (isGifFile(file)){
    currentPanoKind = "gif";
    panoMat.map = panoGifTexture;
    orbsMat.map = panoGifTexture; // ORBS scene follows too
    if (panoGifImg.getAttribute("src") !== src) panoGifImg.src = src;
    else rebuildPanoMesh();
  } else {
    currentPanoKind = "video";
    panoMat.map = panoTexture;
    orbsMat.map = panoTexture; // ORBS scene follows too
    if (panoVideoEl.getAttribute("src") !== src){
      panoVideoEl.src = src;
      panoVideoEl.play().catch(() => {});
    }
  }
}

// manual sphere control is retired (button removed) - the sphere always
// drifts on its own and reacts to the music (see animate())
const sphereUserControl = false;

// the intro/gate screen shows this specific clip (reserved via
// INTRO_PANO_FILE, excluded from regular playback rotation) on the shared
// panorama sphere until the listener taps in, at which point load() picks
// a per-track background as usual
loadPanoFile(INTRO_PANO_FILE);

let mouseNX = 0, mouseNY = 0;
addEventListener("mousemove", e => {
  mouseNX = (e.clientX / window.innerWidth) * 2 - 1;
  mouseNY = (e.clientY / window.innerHeight) * 2 - 1;
});

// below the 1200px breakpoint the controls row no longer wraps (transport
// pinned left, side-btns pinned right - see the @media rule), so on a
// screen too narrow to fit everything at natural size the whole block is
// scaled down uniformly instead of overflowing/clipping
function fitControlsRowToWidth(){
  const row = document.querySelector(".controls-row");
  if (!row || !row.parentElement) return;
  if (window.innerWidth > 1200){
    row.style.transform = "";
    row.style.transformOrigin = "";
    return;
  }
  row.style.transform = "none";
  const available = row.parentElement.clientWidth;
  const natural = row.scrollWidth;
  if (available > 0 && natural > available){
    row.style.transformOrigin = "center top";
    row.style.transform = `scale(${available / natural})`;
  } else {
    row.style.transform = "";
  }
}

function resize(){
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  tunnelLineResolution.set(renderer.domElement.width, renderer.domElement.height);
  positionWaveCanvas();
  fitControlsRowToWidth();
}
addEventListener("resize", resize); resize();

function audioIntensity(){
  if (!freqData || !playing) return 0;
  let sum = 0;
  for (let i = 0; i < freqData.length; i++) sum += freqData[i];
  const raw = sum / freqData.length / 255;
  return Math.min(1, Math.pow(raw, 0.5) * 1.8);
}

const gateLogoTiltEl = $("#gate-logo-tilt");
let camYaw = 0, camPitch = 0;
let sphereSpinRoll = 0; // SPHERE scene's own continuous clockwise turn (see animate())
// timestamp the automatic motion (re)starts from; null forces a fresh
// "centred, then ease in" ramp the next time auto-drift takes over
let autoMotionStartT = null;

/* ---------- flight controls (all scenes): hold ArrowUp to speed forward,
   ArrowDown to fly backwards, ArrowLeft/ArrowRight to rotate the scene
   counter-/clockwise. Every scene scrolls from the shared accumulated
   flightDist (advanced by the smoothed speed factor each frame) instead
   of raw clock time, which is what makes variable/reverse speed possible
   without any scene-visible seam. ---------- */
const flightKeys = { up: false, down: false, left: false, right: false };
let flightSpeedFactor = 1; // smoothed: 1 cruise, up to 5.2 boosted, -2.4 reverse
let flightDist = 0;        // accumulated "seconds of cruise flight" all scenes scroll from
let cameraRollOffset = 0;  // steered roll applied on top of every scene's own bank
let flightRollRate = 0;    // smoothed roll velocity, so key presses ease in/out
let lastAnimT = null;
// safe wrap for scroll offsets - flightDist can go negative while reversing
function wrapScroll(v, m){ return ((v % m) + m) % m; }
addEventListener("keydown", e => {
  const el = document.activeElement;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
  if (e.key === "ArrowUp") flightKeys.up = true;
  else if (e.key === "ArrowDown") flightKeys.down = true;
  else if (e.key === "ArrowLeft") flightKeys.left = true;
  else if (e.key === "ArrowRight") flightKeys.right = true;
  else return;
  e.preventDefault();
});
addEventListener("keyup", e => {
  if (e.key === "ArrowUp") flightKeys.up = false;
  else if (e.key === "ArrowDown") flightKeys.down = false;
  else if (e.key === "ArrowLeft") flightKeys.left = false;
  else if (e.key === "ArrowRight") flightKeys.right = false;
});

function animate(t){
  requestAnimationFrame(animate);
  if (analyser && playing) analyser.getByteFrequencyData(freqData);
  updateVuMeter(analyser && playing);
  updateWaveSamples();
  drawWaveCanvas();
  panoUniforms.uIntensity.value += (audioIntensity() - panoUniforms.uIntensity.value) * 0.15;
  updateArtistRingVisualiser();
  // flight controls: advance the shared scroll clock by the (smoothed)
  // speed factor, and integrate the steered scene roll
  const dtSec = lastAnimT === null ? 0.016 : Math.min(0.1, ((t || 0) - lastAnimT) * 0.001);
  lastAnimT = t || 0;
  // both the speed factor and the roll rate ease toward their key-driven
  // targets rather than jumping, so a press ramps in and a release ramps
  // out - motion stays smooth at both ends. The idle cruise itself
  // breathes (roughly 0.6x-1.4x on two slow uneven beats), so the flight
  // naturally accelerates into some stretches and eases through others
  const animSec = (t || 0) * 0.001;
  const speedTarget = flightKeys.up ? 5.2 : flightKeys.down ? -2.4
    : 1 + Math.sin(animSec * 0.021) * 0.28 + Math.sin(animSec * 0.009 + 2) * 0.16;
  flightSpeedFactor += (speedTarget - flightSpeedFactor) * 0.035;
  flightDist += dtSec * flightSpeedFactor;
  // warped sway clock shared by every scene camera: time itself speeds up
  // and slows down (continuously, never resetting), so the sinusoidal
  // drifts change direction and pace organically instead of ticking like
  // a metronome
  const swayT = animSec + Math.sin(animSec * 0.017) * 7;
  const rollTarget = flightKeys.left ? -0.9 : flightKeys.right ? 0.9 : 0;
  flightRollRate += (rollTarget - flightRollRate) * 0.04;
  cameraRollOffset += flightRollRate * dtSec;
  // logo no longer scales with music intensity - fixed size, just its
  // own CSS centering (see positionLogo())

  // camera target. When the user has taken control (sphere-control button,
  // music screen only) the mouse steers it. Otherwise the sphere drifts on
  // its own — an elegant Lissajous sweep (yaw left↔right, pitch up↔down on
  // two slow periods ~25s/~33s so it never resyncs into a mechanical loop),
  // and on the music screen that drift also reacts to the audio: louder
  // passages add a faster, wider sway on top (uIntensity is ~0 on the
  // silent intro, so there it stays the pure elegant drift).
  // SPHERE scene's own steady, continuous clockwise turn - one full 360
  // every 30s, forever - as a camera ROLL (rotation.z), applied further
  // down where the sphere screen sets its position sway, not here (this
  // block only ever drives yaw/pitch - see camera.rotation.z below)
  if (document.body.classList.contains("scene-sphere")) sphereSpinRoll += dtSec * (Math.PI * 2 / 30);

  let targetYaw, targetPitch, camSmooth;
  if (sphereUserControl && !document.body.classList.contains("gate-active")){
    targetYaw = -mouseNX * 0.5;
    targetPitch = -mouseNY * 0.35;
    camSmooth = 0.04335; // slow trailing follow for mouse-look
    autoMotionStartT = null; // restart the centred ramp when auto resumes
  } else if (document.body.classList.contains("scene-sphere")){
    // no yaw/pitch drift for SPHERE any more - the roll above is the only
    // motion, so ease straight back to dead-centre and stay there
    targetYaw = 0;
    targetPitch = 0;
    camSmooth = 0.05;
    autoMotionStartT = null; // restart the centred ramp for when the gate returns
  } else {
    if (autoMotionStartT === null) autoMotionStartT = t || 0;
    // always begin dead-centre: hold for 1s, then ease the movement in and
    // let it intensify to full over the following 4s (smoothstep ramp)
    const elapsed = ((t || 0) - autoMotionStartT) / 1000;
    const r = Math.max(0, Math.min(1, (elapsed - 1.0) / 4.0));
    const ramp = r * r * (3 - 2 * r);
    const time = (t || 0) * 0.001;
    // always start from the centre (mouse-in-the-middle) and ease the drift
    // in - identical to the reset that happens when manual control is
    // switched off. No mouse offset here, so its resting point stays centred.
    // Deliberately NOT music-reactive - just the sweet slow Lissajous sweep
    // on two never-resyncing periods
    targetYaw = ramp * Math.sin(time * 0.25) * 0.42;
    targetPitch = ramp * Math.sin(time * 0.19) * 0.26;
    // gentle trailing follow to keep the long strokes smooth
    camSmooth = 0.07;
  }
  camYaw += (targetYaw - camYaw) * camSmooth;
  camPitch += (targetPitch - camPitch) * camSmooth;
  camera.rotation.y = camYaw;
  camera.rotation.x = camPitch;
  // intro screen's logo tilts the same way - the button/hint text below
  // it stay put, only the logo itself reacts to the mouse
  if (gateLogoTiltEl){
    const gateYawDeg = camYaw * (180 / Math.PI) * 0.6;
    const gatePitchDeg = camPitch * (180 / Math.PI) * 0.6;
    gateLogoTiltEl.style.transform = `rotateY(${gateYawDeg}deg) rotateX(${gatePitchDeg}deg)`;
  }

  if (tunnelGroup.visible){
    const nowSec = (t || 0) * 0.001;
    // scrolled by exactly one chunk-length wraps seamlessly, since chunk 2
    // is an identical copy of chunk 1 (see buildTunnelGeometry)
    tunnelGroup.position.z = wrapScroll(flightDist * TUNNEL_SPEED, TUNNEL_CHUNK_LENGTH);
    // same 10.8s period as the intro logo's own CSS spin (logo3dSpin),
    // both slowed 20% for a heavier feel
    tunnelGroup.rotation.z = (nowSec / 10.8) * Math.PI * 2;
    // once in a while a light band sweeps the rock from the deep end
    // toward the camera: for the first 30% of every 9s cycle the pulse
    // distance runs 140 -> 0, then parks off-range until the next cycle
    const pulsePhase = (nowSec % 9) / 9;
    tunnelPulseUniform.value = pulsePhase < 0.3 ? 140 * (1 - pulsePhase / 0.3) : -100;
  }

  if (roadGroup.visible){
    // drone flight over the rolling, curving road - deliberately
    // disconnected from audio and mouse. The road streams toward the
    // camera (seamless chunk wrap); the camera tracks the centerline
    // point currently under it, looks/banks into the curve ahead, and
    // adds slow orbital sweeps in every direction on top, all lerped so
    // each move is an elegant glide
    const nowSec = (t || 0) * 0.001;
    const scroll = flightDist * ROAD_SPEED;
    roadGroup.position.z = wrapScroll(scroll, ROAD_CHUNK_LENGTH);
    // the centerline point at the camera's own world z (camera sits at
    // z=8; road point d renders at world z = scroll - d)
    const here = roadCenterAt(scroll - 8);
    const ahead = roadCenterAt(scroll - 8 + 14);
    // long lookahead + a soft follow factor + slow low-amplitude sways =
    // unhurried, stylish glides instead of abrupt corrections
    const follow = 0.02;
    roadCamX += (here.x + Math.sin(swayT * 0.055) * 1.6 - roadCamX) * follow;
    roadCamY += (here.y + ROAD_CAM_HEIGHT + Math.sin(swayT * 0.045 + 1) * 1.0 - roadCamY) * follow;
    // hard floor: whatever the sway/lerp is doing, never sink below the
    // road surface under the camera
    roadCamY = Math.max(roadCamY, here.y + 2.6);
    // look into the curve/hill ahead, with a slow scanning sway on top
    roadCamYaw += (-Math.atan2(ahead.x - here.x, 14) * 0.6 + Math.sin(swayT * 0.032) * 0.05 - roadCamYaw) * follow;
    roadCamPitch += (Math.atan2(ahead.y - here.y, 14) * 0.45 - 0.05 + Math.sin(swayT * 0.028 + 3) * 0.03 - roadCamPitch) * follow;
    roadCamBank += (-Math.atan2(ahead.x - here.x, 14) * 0.8 + Math.sin(swayT * 0.025 + 5) * 0.025 - roadCamBank) * follow;
    camera.position.x = roadCamX;
    camera.position.y = roadCamY;
    camera.rotation.x = roadCamPitch;
    camera.rotation.y = roadCamYaw;
    camera.rotation.z = roadCamBank + cameraRollOffset;
    // stars stream from the far back toward (and past) the camera
    roadStars.position.z = wrapScroll(flightDist * ROAD_STAR_SPEED, ROAD_STAR_DEPTH);
    // outline spheres rise slowly from just above the field: p*p is the
    // ease-in (gentle lift-off, accelerating upward). Each cycle fades in
    // over its first 15% and out over its last 15%, so a sphere appears
    // softly, drifts up, and dissolves - never popping in or out at once
    roadFloaters.forEach(s => {
      const p = ((nowSec / s.userData.period) + s.userData.phase) % 1;
      s.position.y = s.userData.startY + p * p * s.userData.rise;
      s.userData.outlineMat.opacity = Math.min(1, Math.min(p / 0.15, (1 - p) / 0.15)) * 0.95;
    });
    // the road itself brightens up to 25% with the music (uIntensity is
    // the same smoothed audio level the other visualisers use)
    if (roadStripMat) roadStripMat.color.setScalar(1 + panoUniforms.uIntensity.value * 0.25);
    // red balls and their cast-light pools stay red, but their SIZE reacts
    // to the music like the audio visualisers - swelling with the level on
    // top of a gentle idle breathing, each on its own phase
    const ballBeat = panoUniforms.uIntensity.value;
    roadBallPulses.forEach(p => {
      const s = (1 + Math.sin(nowSec * 1.4 + p.phase) * 0.08) * (1 + ballBeat * 0.9);
      p.ball.scale.setScalar(s);
      p.pool.scale.setScalar(s);
    });
  } else if (mistGroup.visible){
    // endless flight straight THROUGH the star/ball field, drone-style:
    // the camera lerp-follows an invisible curving path, looking and
    // banking into the curve ahead, with generous sways on every axis
    const nowSec = (t || 0) * 0.001;
    const scroll = flightDist * MIST_SPEED;
    mistGroup.position.z = wrapScroll(scroll, MIST_CHUNK_LENGTH);
    const here = mistPathAt(scroll - 8);
    const ahead = mistPathAt(scroll - 8 + 14);
    const follow = 0.02;
    // wobble slowed 4x across the board - long dreamy arcs
    mistCamX += (here.x + Math.sin(swayT * 0.014) * 12 - mistCamX) * follow;
    mistCamY += (here.y + Math.sin(swayT * 0.011 + 1) * 9 - mistCamY) * follow;
    mistCamYaw += (-Math.atan2(ahead.x - here.x, 14) * 0.6 + Math.sin(swayT * 0.008) * 0.3 - mistCamYaw) * follow;
    mistCamPitch += (Math.atan2(ahead.y - here.y, 14) * 0.45 + Math.sin(swayT * 0.007 + 3) * 0.1 - mistCamPitch) * follow;
    mistCamBank += (-Math.atan2(ahead.x - here.x, 14) * 0.8 + Math.sin(swayT * 0.006 + 5) * 0.16 - mistCamBank) * follow;
    camera.position.x = mistCamX;
    camera.position.y = mistCamY;
    // a very slow wander swings the gaze all the way around over minutes -
    // sometimes looking sideways, up, down, even fully backward - layered
    // over the path-follow sways
    camera.rotation.x = mistCamPitch + Math.sin(swayT * 0.0043 + 2) * 0.5;
    camera.rotation.y = mistCamYaw + Math.sin(swayT * 0.0033) * 2.6;
    // sways on all three axes plus a slow continuous barrel roll (~2.7min
    // per revolution) - the camera is always rotating around every axis
    camera.rotation.z = mistCamBank + cameraRollOffset + nowSec * (Math.PI * 2 / 160);
    // the reactive flocks swell and brighten with the music level
    const mistBeat = panoUniforms.uIntensity.value;
    mistReactiveMats.forEach(m => {
      m.size = m.userData.baseSize * (1 + mistBeat * 0.6);
      m.userData.baseOpacity = 0.45 + mistBeat * 0.3;
    });
    // every flock fades in over 0.2s from whenever the scene last turned on
    const mistFadeIn = Math.min(1, (performance.now() - mistFadeStartMs) / 200);
    mistAllMats.forEach(m => { m.opacity = m.userData.baseOpacity * mistFadeIn; });
    // every circle slowly orbits its own flock's center, each at its own
    // (slow) speed, instead of sitting frozen at its starting offset
    mistOrbitPoints.forEach(points => {
      const pos = points.geometry.attributes.position;
      const { orbitCX, orbitCY, orbitCZ, orbitR, orbitPhase, orbitSpeed } = points.userData;
      for (let i = 0; i < orbitR.length; i++){
        const theta = orbitPhase[i] + nowSec * orbitSpeed[i];
        pos.setXYZ(i, orbitCX[i] + Math.cos(theta) * orbitR[i], orbitCY[i], orbitCZ[i] + Math.sin(theta) * orbitR[i]);
      }
      pos.needsUpdate = true;
    });
  } else if (downtownGroup.visible){
    // wide-roaming glide through the big block maze: sweeping left/right/
    // up/down travel plus all three rotations, still clear of the slabs'
    // deepest reach into the corridor
    const nowSec = (t || 0) * 0.001;
    downtownGroup.position.z = wrapScroll(flightDist * DT_SPEED, DT_CHUNK_LENGTH);
    // the starfield streams past at 3x the blocks' speed
    dtStars.position.z = wrapScroll(flightDist * DT_SPEED * 3, DT_CHUNK_LENGTH);
    // just the one hero line reacts to the music - flashes toward white
    // and grows from 2px to 5px wide with the intensity; every other
    // block edge stays at its plain thin base tint
    dtHeroFatMat.uniforms.uColor.value.copy(dtHeroBaseColor).lerp(new THREE.Color(0xffffff), panoUniforms.uIntensity.value);
    dtHeroFatMat.uniforms.uLineWidth.value = 2 + panoUniforms.uIntensity.value * 3;
    camera.position.x = Math.sin(swayT * 0.05) * 24 + Math.sin(swayT * 0.021 + 3) * 10;
    camera.position.y = Math.sin(swayT * 0.042 + 1) * 18 + Math.sin(swayT * 0.017) * 8;
    camera.rotation.x = Math.sin(swayT * 0.036 + 2) * 0.16;
    camera.rotation.y = Math.sin(swayT * 0.03) * 0.34;
    // one full slow 360deg barrel roll every ~2.5 minutes, with the axis
    // sways and the steered flight roll layered on top
    camera.rotation.z = nowSec * (Math.PI * 2 / 150) + Math.sin(swayT * 0.04 + 4) * 0.2 + cameraRollOffset;
    // the reactive slabs breathe with the music (uIntensity is the same
    // smoothed audio level the sphere shader uses), each on its own phase
    const beat = panoUniforms.uIntensity.value;
    dtReactiveSlabs.forEach(slab => {
      slab.material.emissiveIntensity = beat * (0.55 + Math.sin(nowSec * 2.2 + slab.userData.pulsePhase) * 0.45);
    });
    // every box floats smoothly up and down on its own slow phase (outer
    // boxes with a wider travel than the corridor slabs); rotation stays
    // fixed at the shared 45-degree tilt set at build time
    dtBobSlabs.forEach(slab => {
      slab.position.y = slab.userData.baseY + Math.sin(nowSec * slab.userData.bobSpeed + slab.userData.bobPhase) * slab.userData.bobAmp;
    });
    // the boxes' vertical lines light up with the music
    const lineGlow = 0.35 + beat * 0.65;
    dtLineMats.forEach(lm => { lm.opacity = lineGlow; });
  } else if (tilesGroup.visible){
    // op-art corridor: a true weaving fly-through - the camera follows a
    // winding path (corners left/right, climbs and dives), looking and
    // banking into every turn, while tile blocks tumble past
    const nowSec = (t || 0) * 0.001;
    const scroll = flightDist * TILES_SPEED;
    tilesGroup.position.z = wrapScroll(scroll, TILES_CHUNK_LENGTH);
    // long lookahead + very soft follow + tiny sways: the camera glides
    // through the bends without any quick jiggling
    const here = tilesPathAt(scroll - 8);
    const ahead = tilesPathAt(scroll - 8 + 18);
    const follow = 0.016;
    tilesCamX += (here.x + Math.sin(swayT * 0.03) * 0.7 - tilesCamX) * follow;
    tilesCamY += (here.y + Math.sin(swayT * 0.026 + 1) * 0.7 - tilesCamY) * follow;
    // an elegant slow left/right gaze wander layered over the path look
    tilesCamYaw += (-Math.atan2(ahead.x - here.x, 18) * 0.65 + Math.sin(swayT * 0.012) * 0.4 + Math.sin(swayT * 0.019) * 0.05 - tilesCamYaw) * follow;
    tilesCamPitch += (Math.atan2(ahead.y - here.y, 18) * 0.5 + Math.sin(swayT * 0.022 + 2) * 0.035 - tilesCamPitch) * follow;
    tilesCamBank += (-Math.atan2(ahead.x - here.x, 18) * 0.7 + Math.sin(swayT * 0.024 + 4) * 0.025 - tilesCamBank) * follow;
    camera.position.x = tilesCamX;
    camera.position.y = tilesCamY;
    camera.rotation.x = tilesCamPitch;
    camera.rotation.y = tilesCamYaw;
    camera.rotation.z = tilesCamBank + cameraRollOffset;
    // every block spins 2x faster on all three axes and travels a real
    // up-and-down swing
    tilesBlocks.forEach(b => {
      b.position.y = b.userData.baseY + Math.sin(nowSec * 0.3 + b.userData.phase) * 4.5;
      b.rotation.x = nowSec * b.userData.spin * 2 + b.userData.phase;
      b.rotation.y = nowSec * b.userData.spin * 1.4 + b.userData.phase * 2;
      b.rotation.z = nowSec * b.userData.spin * 0.9 + b.userData.phase * 3;
    });
    // the stripe patterns slide across every surface in a shared rhythm:
    // fast, slow, fast, STOP, slow... - an eased step sequence, each beat
    // ~2.4s, accumulated so the flow pauses and surges but never jumps
    const TILES_RHYTHM = [1.6, 0.35, 1.3, 0, 0.55, 1.0];
    const rt = nowSec / 2.4;
    const r0 = Math.floor(rt) % TILES_RHYTHM.length;
    const rf = rt - Math.floor(rt);
    const rEase = rf * rf * (3 - 2 * rf);
    tilesFlowPhase += (TILES_RHYTHM[r0] + (TILES_RHYTHM[(r0 + 1) % TILES_RHYTHM.length] - TILES_RHYTHM[r0]) * rEase) * dtSec * 0.12;
    // only the cubes' stripe coats slide - the surface motifs stay put
    tilesStripeMats.forEach((m, i) => {
      const dir = i % 2 === 0 ? 1 : -1;
      m.map.offset.set(tilesFlowPhase * dir, tilesFlowPhase * dir * 0.5);
    });
    // and every few seconds the stripes change direction/size
    tilesStripeFlipT -= dtSec;
    if (tilesStripeFlipT <= 0){
      tilesRedrawStripes();
      tilesStripeFlipT = 4 + Math.random() * 6;
    }
    // the invisible light travels WITH the camera - a soft diffuse key
    // riding above and ahead, so light and shadows sweep along the bends
    // (the shadowless fill shares its axis and target)
    tilesDirLight.position.set(tilesCamX + 12, tilesCamY + 26, 8 + 18);
    tilesDirLight.target.position.set(tilesCamX, tilesCamY, 8 - 40);
    tilesDirFill.position.copy(tilesDirLight.position);
  } else if (beamsGroup.visible){
    // five-lane road: drone flight over the ribbons while cubes rain in,
    // bounce with real gravity, roll to a stop and drift past with the
    // scrolling ground
    const nowSec = (t || 0) * 0.001;
    beamsGroup.position.z = wrapScroll(flightDist * BEAMS_SPEED, BEAMS_CHUNK_LENGTH);
    // how far the ground moved this frame - landed cubes ride along
    const beamsScrollDz = (flightDist - beamsPrevFlight) * BEAMS_SPEED;
    beamsPrevFlight = flightDist;
    // drifting slowly in every direction: sweeps left/right, up/down, and
    // a slow push-pull along the flight line - sign flipped on every term
    // so the whole drift runs the opposite way from before; frequencies
    // slowed further and amplitudes opened up a little for a more
    // noticeable, unhurried all-direction wander
    camera.position.x = -(Math.sin(swayT * 0.031) * 12 + Math.sin(swayT * 0.013 + 3) * 5);
    // floor-clamped so the drift's low point never dips the camera under
    // the ground plane (y=0) - always stays a couple units above it
    camera.position.y = Math.max(2.6, 5.5 - (Math.sin(swayT * 0.026 + 1) * 5 + Math.sin(swayT * 0.011) * 2));
    camera.position.z = 8 - Math.sin(swayT * 0.010 + 5) * 4;
    // down-tilt tuned so the horizon sits at the profile picture's
    // vertical midpoint (~60% down the frame)
    camera.rotation.x = -0.09 + Math.sin(swayT * 0.03 + 2) * 0.04;
    // continuous slight left/right gaze on two overlapping slow beats -
    // never still, never abrupt
    camera.rotation.y = Math.sin(swayT * 0.026) * 0.14 + Math.sin(swayT * 0.011 + 2) * 0.08;
    // roll: the gentle lean plus a slow, wide 25-degree clockwise/
    // counter-clockwise sweep layered on top
    camera.rotation.z = Math.sin(swayT * 0.021 + 4) * 0.13
      + Math.sin(swayT * 0.008) * (25 * Math.PI / 180) + cameraRollOffset;
    beamsCubes.forEach(c => {
      if (c.state === "wait"){
        c.timer -= dtSec;
        // one-at-a-time launches: a cube only drops if none has dropped in
        // the last ~0.8s - they fall one by one, never in a batch
        if (c.timer <= 0 && nowSec - beamsLastSpawn > 0.8){
          beamsLastSpawn = nowSec;
          // capped smaller now (max ~150px on screen) so cubes never
          // dominate the frame; a modest "big" tier still exists, and the
          // once-per-~5s giant drop is capped down to the same ceiling
          c.size = 0.6 + Math.random() * 1.1;
          if (Math.random() < 0.2) c.size *= 1.6;
          if (nowSec - beamsLastBigDrop > 5){
            c.size = 2.2 + Math.random() * 0.8;
            beamsLastBigDrop = nowSec;
          }
          c.mesh.scale.setScalar(c.size);
          // spread across the FULL screen width now (was two side clusters
          // with a gap down the middle) for denser, whole-screen coverage
          c.mesh.position.set((Math.random() - 0.5) * 60, 30 + Math.random() * 12, -(50 + Math.random() * 120));
          c.mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
          c.vy = 0;
          c.vx = 0;
          c.vz = 0;
          c.av.set((Math.random() - 0.5) * 5, (Math.random() - 0.5) * 5, (Math.random() - 0.5) * 5);
          c.state = "fall";
          c.mesh.visible = c.mirror.visible = c.shadow.visible = true;
        }
      } else {
        // landed or airborne, everything drifts with the ground scroll
        c.mesh.position.z += beamsScrollDz;
        // support height: how far the cube's LOWEST corner hangs below its
        // center at the current rotation - resting on this keeps every
        // corner above the floor, at any orientation, with nothing sunk
        // through the ground
        beamsRotMat.makeRotationFromEuler(c.mesh.rotation);
        const e = beamsRotMat.elements;
        const gY = beamsGroundY(c.mesh.position.x, c.mesh.position.z);
        const support = (Math.abs(e[1]) + Math.abs(e[5]) + Math.abs(e[9])) * (c.size / 2) + gY;
        // diffuse shadow blob: pinned under the cube, softly scaling with
        // its size, fading a touch the higher off the ground it still is
        const shadowHeightF = Math.max(0.35, 1 - (c.mesh.position.y - support) / 14);
        c.shadow.position.set(c.mesh.position.x, gY + 0.04, c.mesh.position.z);
        c.shadow.scale.setScalar(c.size * 1.8);
        c.shadow.material.opacity = 0.4 * shadowHeightF;
        // knock-on velocity from cube-cube collisions, air/ground damped
        c.mesh.position.x += (c.vx || 0) * dtSec;
        c.mesh.position.z += (c.vz || 0) * dtSec;
        const hDamp = Math.max(0, 1 - (c.state === "rest" ? 2.2 : 0.5) * dtSec);
        c.vx = (c.vx || 0) * hDamp;
        c.vz = (c.vz || 0) * hDamp;
        if (c.state === "fall"){
          c.vy -= 26 * dtSec;           // gravity
          c.mesh.position.y += c.vy * dtSec;
          if (c.mesh.position.y <= support){
            const impact = -c.vy; // downward speed at the moment of contact
            c.mesh.position.y = support;
            c.vy = -c.vy * 0.42;        // restitution: each bounce lower
            c.av.multiplyScalar(0.7);   // impacts bleed off spin too
            if (c.vy < 1.4){
              c.vy = 0; c.state = "rest";
              // find whichever local face-axis is closest to vertical right
              // now, then build the exact quaternion that snaps ONLY that
              // tilt away (rotating around that axis is left untouched, so
              // it doesn't visually "un-spin") - unlike rounding the x/z
              // Euler angles separately, this guarantees a true axis-aligned
              // rest pose: one whole face, all four corners, flush with gY
              const q = c.mesh.quaternion.clone();
              const localAxes = [beamsAxisX, beamsAxisY, beamsAxisZ];
              let bestWorldAxis = null, bestAbsDot = -1, bestSign = 1;
              localAxes.forEach(axis => {
                const world = axis.clone().applyQuaternion(q);
                if (Math.abs(world.y) > bestAbsDot){
                  bestAbsDot = Math.abs(world.y); bestWorldAxis = world; bestSign = world.y >= 0 ? 1 : -1;
                }
              });
              const targetUp = new THREE.Vector3(0, bestSign, 0);
              const correction = new THREE.Quaternion().setFromUnitVectors(bestWorldAxis.normalize(), targetUp);
              c.settleQuat = correction.multiply(q);
            }
            // light up a soft round glow where it hit
            if (impact > 3){
              const r = beamsRipples.find(x => x.life >= 1);
              if (r){
                r.life = 0;
                r.strength = Math.min(1, impact / 22);
                r.baseSize = c.size * 2.5;
                r.mesh.position.set(c.mesh.position.x, gY + 0.12, c.mesh.position.z);
                r.mesh.visible = true;
              }
              // and a thin line streaking the full length of the floor
              // through the impact point, brightest there and fading out
              // toward both the near and far ends - fades in, then HOLDS
              // at full brightness (see the update loop below) and only
              // fades out once this cube itself scrolls off-screen
              const s = beamsStreaks.find(x => x.life >= 1);
              if (s){
                s.life = 0;
                s.strength = Math.min(1, impact / 22);
                s.cube = c;
                // exactly as wide as the cube itself (c.size is the
                // cube's own world-unit edge length), scaled off the
                // base 0.4-wide plane
                s.mesh.scale.x = c.size / 0.4;
                s.mesh.position.set(c.mesh.position.x, gY + 0.1, 0);
                s.mesh.visible = true;
                s.mat.opacity = 0;
              }
            }
          }
        } else {
          // resting: spin dies out while the cube slerps onto the exact
          // flat-face orientation computed at landing - a real rotation
          // snap rather than an approximate per-axis ease, so it always
          // settles with one full face level on the ground
          c.av.multiplyScalar(Math.max(0, 1 - 3 * dtSec));
          if (c.settleQuat){
            c.mesh.quaternion.slerp(c.settleQuat, Math.min(1, 3.2 * dtSec));
          }
          c.mesh.position.y = support;
        }
        if (c.state === "fall"){
          c.mesh.rotation.x += c.av.x * dtSec;
          c.mesh.rotation.y += c.av.y * dtSec;
          c.mesh.rotation.z += c.av.z * dtSec;
        }
        c.mesh.scale.setScalar(c.size);
        if (c.mesh.position.z > 30){
          c.state = "wait";
          c.timer = Math.random() * 3;
          c.mesh.visible = c.mirror.visible = c.shadow.visible = false;
        }
      }
    });
    // cube-vs-cube: overlapping cubes shove apart and bounce off each
    // other (sphere-approximate impulse along the contact normal)
    for (let i = 0; i < beamsCubes.length; i++){
      const a = beamsCubes[i];
      if (a.state === "wait") continue;
      for (let j = i + 1; j < beamsCubes.length; j++){
        const b = beamsCubes[j];
        if (b.state === "wait") continue;
        const dx = a.mesh.position.x - b.mesh.position.x;
        const dy = a.mesh.position.y - b.mesh.position.y;
        const dz = a.mesh.position.z - b.mesh.position.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const minDist = (a.size + b.size) * 0.55;
        if (dist > 0.001 && dist < minDist){
          const nx = dx / dist, ny = dy / dist, nz = dz / dist;
          const push = (minDist - dist) / 2;
          a.mesh.position.x += nx * push; a.mesh.position.y += ny * push; a.mesh.position.z += nz * push;
          b.mesh.position.x -= nx * push; b.mesh.position.y -= ny * push; b.mesh.position.z -= nz * push;
          const kick = 2.4;
          a.vx = (a.vx || 0) + nx * kick; a.vz = (a.vz || 0) + nz * kick; a.vy += Math.max(0, ny * kick);
          b.vx = (b.vx || 0) - nx * kick; b.vz = (b.vz || 0) - nz * kick; b.vy += Math.max(0, -ny * kick);
          if (a.state === "rest" && a.vy > 0.5) a.state = "fall";
          if (b.state === "rest" && b.vy > 0.5) b.state = "fall";
          a.av.x += (Math.random() - 0.5) * 2;
          b.av.y += (Math.random() - 0.5) * 2;
          if (a.mesh.position.y < a.size / 2) a.mesh.position.y = a.size / 2;
          if (b.mesh.position.y < b.size / 2) b.mesh.position.y = b.size / 2;
        }
      }
    }
    // impact ripples expand and fade like drips in water, drifting with
    // the ground scroll so they stay pinned to their landing spot
    beamsRipples.forEach(r => {
      if (r.life >= 1) return;
      r.life = Math.min(1, r.life + dtSec / 0.9);
      r.mesh.position.z += beamsScrollDz;
      const s = r.baseSize * (0.6 + r.life * 5);
      r.mesh.scale.set(s, 1, s);
      r.mat.opacity = (1 - r.life) * 0.55 * r.strength;
      if (r.life >= 1) r.mesh.visible = false;
    });
    // impact streaks: fade in, hold at full brightness for as long as the
    // cube that caused it is still on screen, then fade out once it's gone
    beamsStreaks.forEach(s => {
      if (s.life >= 1) return;
      const targetOpacity = 0.5 * s.strength;
      const cubeGone = !s.cube || !s.cube.mesh.visible;
      if (cubeGone){
        s.mat.opacity = Math.max(0, s.mat.opacity - dtSec / 0.9 * targetOpacity);
        if (s.mat.opacity <= 0){ s.life = 1; s.mesh.visible = false; }
      } else if (s.mat.opacity < targetOpacity){
        s.mat.opacity = Math.min(targetOpacity, s.mat.opacity + dtSec / 0.25 * targetOpacity);
      }
    });
    // mirror clones follow after all position corrections, and every cube
    // darkens with depth - dim far back like the floor, full color as it
    // reaches the camera
    beamsCubes.forEach((c, ci) => {
      if (!c.mesh.visible) return;
      // mirrored about the local ground height, jelly squash included
      const mGY = beamsGroundY(c.mesh.position.x, c.mesh.position.z);
      c.mirror.position.set(c.mesh.position.x, 2 * mGY - c.mesh.position.y, c.mesh.position.z);
      c.mirror.rotation.copy(c.mesh.rotation);
      c.mirror.scale.set(c.mesh.scale.x, -c.mesh.scale.y, c.mesh.scale.z);
      if (beamsCubeBase[ci]){
        const depthF = Math.min(1, Math.max(0.3, (c.mesh.position.z + 180) / 200));
        c.mesh.material.color.copy(beamsCubeBase[ci]).multiplyScalar(depthF);
        c.mirror.material.color.copy(beamsCubeBase[ci]).multiplyScalar(depthF * 0.6);
      }
    });
  } else if (prismGroup.visible){
    // slat curtains: slow elegant drift between the glowing rims
    const nowSec = (t || 0) * 0.001;
    prismGroup.position.z = wrapScroll(flightDist * PRISM_SPEED, PRISM_CHUNK_LENGTH);
    camera.position.x = Math.sin(swayT * 0.04) * 5;
    camera.position.y = Math.sin(swayT * 0.033 + 1) * 4;
    // every ~22s a fresh gaze target (yaw/pitch/roll) is picked, and the
    // camera glides over to it at half the previous pace - each move takes
    // twice as long; small sways ride on top
    const stepI = Math.floor(nowSec / 22);
    const hs = k => { const s = Math.sin((stepI * 7 + k) * 127.1) * 43758.5453; return s - Math.floor(s); };
    prismCamYaw += ((hs(1) - 0.5) * 1.0 - prismCamYaw) * 0.003;
    prismCamPitch += ((hs(2) - 0.5) * 0.3 - prismCamPitch) * 0.003;
    prismCamRoll += ((hs(3) - 0.5) * 0.7 - prismCamRoll) * 0.003;
    camera.rotation.x = prismCamPitch + Math.sin(swayT * 0.027 + 2) * 0.06;
    camera.rotation.y = prismCamYaw + Math.sin(swayT * 0.023) * 0.1;
    // a slow full 180-degree roll each way (~80s per swing), layered
    // under the step-and-glide re-frames
    camera.rotation.z = prismCamRoll + Math.sin(nowSec * 0.0785) * Math.PI
      + Math.sin(swayT * 0.03 + 4) * 0.05 + cameraRollOffset;
    // the free slats ease in toward the camera's base line and back out
    prismMovers.forEach(m => {
      const s01 = 0.5 + 0.5 * Math.sin(nowSec * m.userData.speed + m.userData.phase);
      m.position.x = m.userData.baseX - Math.sign(m.userData.baseX) * m.userData.amp * s01;
      // rim glow at full 100% opacity at the midpoint of the swing
      // (s01=0.5), fading toward 0 at either end of its travel - a
      // parabola peaking at exactly 1 when s01=0.5
      const glow = 4 * s01 * (1 - s01);
      m.userData.rimMats.forEach(mat => { mat.opacity = glow; });
    });
    // star layers ride their own clocks - half speed behind, 1.7x in front
    prismStarLayers.forEach(g => {
      g.position.z = wrapScroll(flightDist * PRISM_SPEED * g.userData.speedMul, PRISM_CHUNK_LENGTH);
      // solid circles, gently pulsing brighter and dimmer
      const m = g.children[0].material;
      m.opacity = m.userData.baseOpacity * (0.7 + 0.3 * (0.5 + 0.5 * Math.sin(nowSec * 0.6 + m.userData.pulsePhase)));
    });
  } else if (ringsGroup.visible){
    // ring snake: the tunnel of gates bends in every direction and the
    // camera rides its spine exactly like the Polaroid road drone -
    // lerp-following the path, looking and banking into the curve ahead -
    // while slowly rolling a full 360 around its own axis
    const nowSec = (t || 0) * 0.001;
    const scroll = flightDist * RINGS_SPEED;
    ringsGroup.position.z = wrapScroll(scroll, RINGS_CHUNK_LENGTH);
    const here = ringsPathAt(scroll - 8);
    const ahead = ringsPathAt(scroll - 8 + 16);
    const follow = 0.02;
    // every sway/roll halved - the whole scene glides at half pace
    ringsCamX += (here.x + Math.sin(swayT * 0.025) * 0.8 - ringsCamX) * follow;
    ringsCamY += (here.y + Math.sin(swayT * 0.02 + 1) * 0.7 - ringsCamY) * follow;
    ringsCamYaw += (-Math.atan2(ahead.x - here.x, 16) * 0.6 + Math.sin(swayT * 0.013) * 0.05 - ringsCamYaw) * follow;
    ringsCamPitch += (Math.atan2(ahead.y - here.y, 16) * 0.5 + Math.sin(swayT * 0.015 + 2) * 0.03 - ringsCamPitch) * follow;
    ringsCamBank += (-Math.atan2(ahead.x - here.x, 16) * 0.7 - ringsCamBank) * follow;
    camera.position.x = ringsCamX;
    camera.position.y = ringsCamY;
    camera.rotation.x = ringsCamPitch;
    camera.rotation.y = ringsCamYaw;
    camera.rotation.z = ringsCamBank + nowSec * (Math.PI * 2 / 220) + cameraRollOffset;
    // stars stream from the deep and fly past behind the camera
    ringsStars.position.z = wrapScroll(flightDist * RINGS_SPEED * 2.2, RINGS_CHUNK_LENGTH);
    // the snake pulse: a swell travels gate by gate down the spine, and
    // every gate still wanders its own little orbit on top - the wander
    // now runs 5x slower, long continuous arcs that never jump
    // the light-up wave: every 4s, a bright band sweeps once through the
    // whole gate sequence (one ring at a time), each ring gaining 20%
    // brightness as the band passes it, then the cycle repeats
    const ringsCycleT = (nowSec % 4) / 4;
    ringsGroup.children.forEach(m => {
      const pulse = m.userData.baseScale * (1 + Math.sin(nowSec * 0.9 - m.userData.gate * 0.7) * 0.12);
      m.scale.set(pulse, pulse, 1);
      m.position.x = m.userData.baseX + Math.sin(nowSec * m.userData.rate * 0.5 + m.userData.phase) * m.userData.drift;
      m.position.y = m.userData.baseY + Math.sin(nowSec * m.userData.rate * 0.4 + m.userData.phase * 2) * m.userData.drift * 0.8;
      const gateT = (m.userData.gate - RINGS_GATE_MIN) / (RINGS_GATE_MAX - RINGS_GATE_MIN);
      const d = Math.min(Math.abs(gateT - ringsCycleT), Math.abs(gateT - ringsCycleT + 1), Math.abs(gateT - ringsCycleT - 1));
      const wave = Math.exp(-((d / 0.05) ** 2));
      m.material.color.copy(m.userData.band.baseColor).multiplyScalar(1 + wave * 0.2);
    });
  } else if (checkGroup.visible){
    // bubble streams: a slow drifting flight winding through the sprays,
    // wandering in every direction with a gentle continuous roll
    const nowSec = (t || 0) * 0.001;
    const scroll = flightDist * CHECK_SPEED;
    checkGroup.position.z = wrapScroll(scroll, CHECK_CHUNK_LENGTH);
    const here = checkPathAt(scroll - 8);
    const ahead = checkPathAt(scroll - 8 + 14);
    const follow = 0.015;
    checkCamX += (here.x + Math.sin(swayT * 0.016) * 5 - checkCamX) * follow;
    checkCamY += (here.y + Math.sin(swayT * 0.013 + 1) * 4 - checkCamY) * follow;
    checkCamYaw += (-Math.atan2(ahead.x - here.x, 14) * 0.5 + Math.sin(swayT * 0.009) * 0.35 - checkCamYaw) * follow;
    checkCamPitch += (Math.atan2(ahead.y - here.y, 14) * 0.4 + Math.sin(swayT * 0.011 + 3) * 0.2 - checkCamPitch) * follow;
    checkCamBank += (-Math.atan2(ahead.x - here.x, 14) * 0.6 - checkCamBank) * follow;
    camera.position.x = checkCamX;
    camera.position.y = checkCamY;
    camera.rotation.x = checkCamPitch;
    camera.rotation.y = checkCamYaw;
    camera.rotation.z = checkCamBank + nowSec * (Math.PI * 2 / 180) + cameraRollOffset;
  } else if (portalGroup.visible){
    // endless concentric rounded-rect frames; a drifting off-center path
    // so the nested rings slide around each other
    const nowSec = (t || 0) * 0.001;
    portalGroup.position.z = wrapScroll(flightDist * PORTAL_SPEED, PORTAL_CHUNK_LENGTH);
    // each incoming panel now drifts up/down (and a little side to side)
    // by its own amount as it approaches, instead of staying dead-centered
    // on the tunnel axis the whole way in
    portalFrames.forEach(m => {
      m.position.y = Math.sin(nowSec * 0.15 + m.userData.ci * 1.3) * 22;
      m.position.x = Math.sin(nowSec * 0.11 + m.userData.ci * 2.1) * 10;
    });
    // the roaming light keeps the specular sheen alive on the walls
    portalLight.position.x = Math.sin(swayT * 0.045) * 34;
    portalLight.position.y = Math.sin(swayT * 0.037 + 2) * 26;
    camera.position.x = Math.sin(swayT * 0.02) * 7;
    camera.position.y = Math.sin(swayT * 0.016 + 1) * 5;
    camera.rotation.x = Math.sin(swayT * 0.012 + 2) * 0.05;
    camera.rotation.y = Math.sin(swayT * 0.014) * 0.06;
    // continuous clockwise roll - a full turn every 40s - layered under
    // the small existing sway so it never feels perfectly mechanical
    camera.rotation.z = Math.sin(swayT * 0.01 + 3) * 0.1 + nowSec * (Math.PI * 2 / 40) + cameraRollOffset;
  } else if (dominoGroup.visible){
    // the topple wave: every domino stands until the flight brings it
    // near, then it eases over around its ground edge and stays down
    // until the wrap resets it far ahead
    dominoGroup.position.z = wrapScroll(flightDist * DOMINO_SPEED, DOMINO_CHUNK_LENGTH);
    dominoMirrorGroup.position.z = dominoGroup.position.z;
    dominoPivots.forEach((pv, i) => {
      const wz = pv.position.z + dominoGroup.position.z;
      // realistic topple: a fast accelerating fall (smoothstep over a
      // short window) followed by a small rebound off the ground
      const a = wz + 26 + pv.userData.stagger;
      const p = Math.min(1, Math.max(0, a / 5));
      const e = p * p * (3 - 2 * p);
      const q = Math.min(1, Math.max(0, (a - 5) / 3));
      // capped per-stone (see maxTopple at build time) instead of a fixed
      // 1.45rad for every stone - this is the actual collision fix: each
      // stone now stops right where its own tip would reach the next
      // stone's slot, instead of swinging on through it
      const rot = -e * pv.userData.maxTopple + Math.sin(q * Math.PI) * 0.07;
      pv.userData.tip.rotation.x = rot;
      dominoMirrorTips[i].rotation.x = rot; // the reflection topples in lockstep
    });
    // the camera tracks the run's curve, banking into the bends, and
    // periodically dives down low, right up next to the toppling stones
    const dScroll = dominoGroup.position.z;
    const hereX = dominoPathX(dScroll - 8);
    const aheadX = dominoPathX(dScroll + 24);
    // the invisible light travels with the camera so the specular sheen
    // and cast shadows sweep along the bends, same as TILES
    dominoDirLight.position.set(hereX + 8, 22, 8 + 14);
    dominoDirLight.target.position.set(hereX, 0, 8 - 30);
    const dive = Math.pow((Math.sin(swayT * 0.028) + 1) / 2, 2);
    camera.position.x = hereX + Math.sin(swayT * 0.018) * (4 - dive * 2.5);
    camera.position.y = 7 - dive * 4.6 + Math.sin(swayT * 0.014 + 1) * 1.5 * (1 - dive * 0.6);
    camera.rotation.x = -0.18 + dive * 0.12 + Math.sin(swayT * 0.011) * 0.04;
    camera.rotation.y = -Math.atan2(aheadX - hereX, 32) * 0.5 + Math.sin(swayT * 0.013) * 0.04;
    camera.rotation.z = Math.sin(swayT * 0.01 + 2) * 0.05 + cameraRollOffset;
    camera.position.z = 5; // a little closer to the toppling row (was the unset 8 default)
  } else if (eyesGroup.visible){
    // floating eye field: quick winks (a third of the eyes sometimes
    // double-wink) squash only the white - the iris ball never scales
    // vertically, it wanders around inside the white instead
    eyesGroup.position.z = wrapScroll(flightDist * EYES_SPEED, EYES_CHUNK_LENGTH);
    const nowSec = (t || 0) * 0.001;
    eyesList.forEach(e => {
      const u = e.userData;
      let cyc = (nowSec * u.blinkSpeed + u.blinkPhase) % (Math.PI * 2);
      if (cyc < 0) cyc += Math.PI * 2;
      // narrow pulses = a fast snap shut/open; the second pulse lands
      // right after the first for the double-winkers
      const pulse = at => Math.exp(-Math.pow((cyc - at) / 0.11, 2));
      let b = pulse(0.35);
      if (u.doubleWink) b = Math.min(1, b + pulse(0.85));
      u.scl.scale.y = u.sclBaseH * Math.max(0.06, 1 - b * 0.94);
      u.iris.visible = b < 0.75; // the lid covers the ball at full close
      // saccade-style iris movement: snap quickly to a new spot, hold
      // briefly, then snap again - real eye movement instead of a smooth
      // continuous wander. Mostly side to side, occasionally a bigger
      // up/down glance, always bounded by the almond's ellipse shape (the
      // vertical range shrinks toward the corners) so it stays in the white
      if (u.irisNextJump === undefined || nowSec >= u.irisNextJump){
        u.irisFromX = u.irisToX || 0;
        u.irisFromY = u.irisToY || 0;
        const nx = (Math.random() - 0.5) * 2 * u.size * 0.28;
        const vertical = Math.random() < 0.3; // occasional bigger glance up/down
        const yAmp = (vertical ? 0.16 : 0.05) * (1 - Math.pow(nx / (u.size * 0.3), 2));
        u.irisToX = nx;
        u.irisToY = (Math.random() - 0.5) * 2 * u.size * yAmp;
        u.irisMoveStart = nowSec;
        u.irisMoveDur = 0.1 + Math.random() * 0.12; // fast snap, ~100-220ms
        u.irisNextJump = nowSec + u.irisMoveDur + 0.35 + Math.random() * 0.9; // brief pause after
      }
      const p = Math.min(1, (nowSec - u.irisMoveStart) / u.irisMoveDur);
      const ease = 1 - Math.pow(1 - p, 3); // fast out, settles smoothly
      u.iris.position.x = u.irisFromX + (u.irisToX - u.irisFromX) * ease;
      u.iris.position.y = u.irisFromY + (u.irisToY - u.irisFromY) * ease;
      // as an eye nears the camera's own z position: shove it outward off
      // the camera's path (so it never sits right on top of the lens) and
      // bend it a little to face the camera, like it's turning to look at
      // you as you pass
      const worldZ = e.position.z + eyesGroup.position.z;
      const dz = worldZ - camera.position.z;
      const near = Math.max(0, 1 - Math.abs(dz) / 22);
      e.position.x = u.baseX + u.outX * near * 9;
      e.position.y = u.baseY + u.outY * near * 9;
      const lookYaw = Math.atan2(camera.position.x - e.position.x, camera.position.z - worldZ);
      e.rotation.y = lookYaw * near * 0.5;
    });
    eyesCubesGroup.position.z = wrapScroll(flightDist * EYES_SPEED * EYES_CUBE_SPEED_MULT, EYES_CHUNK_LENGTH);
    // each cube spins on its own axis while it bobs up/down around its base
    // y, and pushes off the camera's path the same way (and direction) the
    // eyes do as it nears the camera's own z position
    eyesCubeList.forEach(c => {
      c.rotateOnAxis(c.userData.spinAxis, c.userData.spinRate * dtSec);
      const worldZc = c.position.z + eyesCubesGroup.position.z;
      const nearC = Math.max(0, 1 - Math.abs(worldZc - camera.position.z) / 22);
      c.position.x = c.userData.baseX + c.userData.outX * nearC * 9;
      c.position.y = c.userData.baseY + c.userData.outY * nearC * 9
        + Math.sin(nowSec * c.userData.bobRate + c.userData.bobPhase) * c.userData.bobAmp;
    });
    camera.position.x = Math.sin(swayT * 0.017) * 6;
    camera.position.y = Math.sin(swayT * 0.013 + 1) * 4;
    camera.rotation.x = Math.sin(swayT * 0.01 + 2) * 0.05;
    camera.rotation.y = Math.sin(swayT * 0.012) * 0.06;
    // gentle roll, plus a slow +-20 degree rotation sweep layered under it
    camera.rotation.z = Math.sin(swayT * 0.008 + 3) * 0.07 + Math.sin(swayT * 0.0045) * (20 * Math.PI / 180) + cameraRollOffset;
  } else if (handsGroup.visible){
    // flying straight down the video tunnel's own centerline, with a slow
    // wander side to side and a gentle look-around so it never feels like
    // a rigid rail
    handsGroup.position.z = wrapScroll(flightDist * HANDS_SPEED, HANDS_CHUNK_LENGTH);
    // each sphere spins slowly on its own axis, and gently shoves itself
    // outward off the tunnel wall as the camera gets close, instead of
    // sitting still and getting flown straight through
    const HANDS_AVOID_RADIUS = 30, HANDS_AVOID_PUSH = 7;
    handsList.forEach(m => {
      m.rotateOnAxis(m.userData.spinAxis, m.userData.spinRate * dtSec);
      const worldZ = m.position.z + handsGroup.position.z;
      const d = Math.abs(worldZ - camera.position.z);
      const t = Math.max(0, 1 - d / HANDS_AVOID_RADIUS);
      const push = t * t * HANDS_AVOID_PUSH;
      m.position.x = m.userData.baseX + m.userData.outX * push;
      m.position.y = m.userData.baseY + m.userData.outY * push;
    });
    // the star field flies past noticeably quicker than the tunnel itself -
    // its own faster scroll, layered on top of (and cancelling out) the
    // group's own slower scroll since it's a child of handsGroup
    const HANDS_STAR_SPEED = HANDS_SPEED * 2.6;
    handsStars.position.z = wrapScroll(flightDist * HANDS_STAR_SPEED, HANDS_CHUNK_LENGTH * 2) - handsGroup.position.z;
    // sway amplitudes (and a new depth wander) boosted 25% over the base
    // flythrough sway used elsewhere
    camera.position.x = Math.sin(swayT * 0.017) * 7.5;
    camera.position.y = Math.sin(swayT * 0.013 + 1) * 5;
    camera.position.z = 8 + Math.sin(swayT * 0.009 + 4) * 2.5;
    camera.rotation.x = Math.sin(swayT * 0.01 + 2) * 0.0625;
    camera.rotation.y = Math.sin(swayT * 0.012) * 0.075;
    camera.rotation.z = Math.sin(swayT * 0.008 + 3) * 0.0875 + cameraRollOffset;
  } else if (orbsGroup.visible){
    // glides forward and back along the straight row of spheres (see the
    // reference sketch) - an actual back-and-forth oscillation, not a
    // one-way flythrough. The spheres themselves never move; the camera
    // slides through them and reverses at each end
    const nowSec = (t || 0) * 0.001;
    const rate = Math.PI * 2 / SC_OSC_PERIOD;
    const z = Math.sin(nowSec * rate) * SC_OSC_AMP;
    const velocity = Math.cos(nowSec * rate); // only the sign matters
    const follow = 0.01;
    // faces whichever direction it's currently travelling - a slow
    // lerped 180-degree turn around each end of the swing, not an
    // instant flip
    const targetYaw = velocity < 0 ? 0 : Math.PI;
    orbsCamYaw += (targetYaw - orbsCamYaw) * follow;
    camera.position.x = 0;
    camera.position.y = 0;
    camera.position.z = z;
    camera.rotation.x = 0;
    camera.rotation.y = orbsCamYaw;
    camera.rotation.z = cameraRollOffset;
  } else if (donutGroup.visible){
    // winding tunnel: the camera follows the same bending spine the walls
    // were built along, banking into the curves - exactly the RINGS/TILES
    // flythrough pattern (lerp-follow + look-ahead yaw/pitch/bank), just
    // with a taller, wilder bend
    const nowSec = (t || 0) * 0.001;
    const scroll = flightDist * CUBEW_SPEED;
    donutGroup.position.z = wrapScroll(scroll, CUBEW_CHUNK_LENGTH);
    const here = cubePathAt(scroll - 8);
    const ahead = cubePathAt(scroll - 8 + 16);
    const follow = 0.02;
    cubeCamX += (here.x - cubeCamX) * follow;
    cubeCamY += (here.y - cubeCamY) * follow;
    cubeCamYaw += (-Math.atan2(ahead.x - here.x, 16) * 0.7 + Math.sin(swayT * 0.013) * 0.05 - cubeCamYaw) * follow;
    cubeCamPitch += (Math.atan2(ahead.y - here.y, 16) * 0.6 + Math.sin(swayT * 0.015 + 2) * 0.04 - cubeCamPitch) * follow;
    cubeCamBank += (-Math.atan2(ahead.x - here.x, 16) * 0.5 - cubeCamBank) * follow;
    camera.position.x = cubeCamX;
    camera.position.y = cubeCamY;
    camera.rotation.x = cubeCamPitch;
    camera.rotation.y = cubeCamYaw;
    camera.rotation.z = cubeCamBank + cameraRollOffset;
    // the cubes drift a little within their own slot as the tunnel scrolls
    // them past (riding the shared group transform automatically), and
    // tumble continuously on their own axis
    donutCubes.forEach(b => {
      const wobble = Math.sin(nowSec * b.userData.driftRate + b.userData.driftPhase);
      b.position.x = b.userData.baseX + wobble * 1.3;
      b.position.y = b.userData.baseY + Math.sin(nowSec * b.userData.driftRate * 0.7 + b.userData.driftPhase) * 1.3;
      b.rotation.x += b.userData.spin.x * dtSec;
      b.rotation.y += b.userData.spin.y * dtSec;
      b.rotation.z += b.userData.spin.z * dtSec;
    });
    // the invisible light travels WITH the camera, same as TILES - a soft
    // diffuse key riding above and ahead so light and shadows sweep along
    // the bends (the shadowless fill shares its axis and target)
    donutDirLight.position.set(cubeCamX + 12, cubeCamY + 26, 8 + 18);
    donutDirLight.target.position.set(cubeCamX, cubeCamY, 8 - 40);
    donutDirFill.position.copy(donutDirLight.position);
  } else if (!tunnelGroup.visible){
    // the sphere (auto) screen: a drone-style glide in the Polaroid
    // spirit - slow translational sweeps, floating above the glossy floor.
    // Roll comes straight from sphereSpinYaw's steady turn (see the top of
    // this function) rather than the small bank sway every other scene
    // uses here - this line used to overwrite that turn every frame.
    camera.position.x = Math.sin(swayT * 0.021) * 3.2;
    camera.position.y = Math.sin(swayT * 0.017 + 1) * 2.2;
    camera.rotation.z = sphereSpinRoll + cameraRollOffset;
  } else {
    // intro tunnel: keep its fixed lowered viewpoint; only the steered
    // flight roll applies
    camera.position.x = 0;
    camera.rotation.z = cameraRollOffset;
    camera.position.y = -1.1;
  }

  if (currentPanoKind === "video"){
    if (panoVideoEl.readyState >= panoVideoEl.HAVE_CURRENT_DATA) panoTexture.needsUpdate = true;
  } else if (currentPanoKind === "gif" && panoGifCanvas.width){
    panoGifCtx.drawImage(panoGifImg, 0, 0, panoGifCanvas.width, panoGifCanvas.height);
    panoGifTexture.needsUpdate = true;
  }

  if (TRACKS.length) updateUI();
  renderer.render(scene, camera);
}
requestAnimationFrame(animate);

/* ================================================================
   BOOT — load the dynamic manifest, then start the app
   ================================================================ */
fetch("/api/tracks").then(r => r.json()).then(data => {
  TRACKS = data.tracks.map(t => ({
    id: t.id,
    title: t.title,
    artist: t.artist,
    folder: t.folder,
    artistPhoto: t.artistPhoto || null,
    artistColor: t.artistColor || null,
    duration: t.duration || 0,
    tags: t.tags || "",
    url: t.audioUrl,
    downloadName: t.downloadName,
    rawLyrics: t.lyrics || [],
    sectionBreaks: t.sectionBreaks || [],
    lines: [],
    _lyricsLoaded: false,
  }));
  $("#info-count").textContent = TRACKS.length;
  EDITABLE = !!data.editable;
  updateEditControlsVisibility();
  initLyricsAudit();
  initLyricsFlagging();
  initVideoExport();
  // deep link from a shared "?t=<id>" URL (see $("#btn-share").onclick) -
  // starts the player on that track instead of the default first one
  const deepLinkId = new URLSearchParams(location.search).get("t");
  if (deepLinkId){
    const idx = TRACKS.findIndex(tr => tr.id === deepLinkId);
    if (idx !== -1) cur = idx;
  }
  renderMeta(); renderList(); syncButtons();
  ensureLyricsLoaded(cur);
  if (TRACKS.length) applyTheme(themeIndexForTrack(TRACKS[cur]));
  if (TRACKS.length) updateArtistBackground(TRACKS[cur]);
  if (location.hash.includes("sync")){
    renderSyncTracks();
    fillLyrics();
  }
  tracksReady = true;
  updateGateLoadingState();
}).catch(() => {
  toast("Could not load the library");
  const btn = $("#gate-btn");
  if (btn){ btn.textContent = "COULD NOT LOAD - TAP TO RETRY"; btn.disabled = false; btn.classList.remove("loading"); }
  if (btn) btn.onclick = () => location.reload();
});

// owner-only QA button (see #lyrics-audit-block/OWNER_ONLY_SELECTORS): asks
// the server which tracks' lyrics look missing, empty, or suspiciously
// sparse for their length, and lists them out so they can be re-run
function initLyricsAudit(){
  const btn = $("#btn-lyrics-audit");
  const out = $("#lyrics-audit-results");
  if (!btn || !out) return;
  btn.onclick = async () => {
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "Scanning…";
    out.innerHTML = "";
    try {
      const res = await fetch("/api/lyrics-audit");
      const data = await res.json();
      const items = data.items || [];
      if (!items.length){
        const p = document.createElement("p");
        p.className = "dim";
        p.textContent = "Nothing flagged - every track's lyrics look complete.";
        out.appendChild(p);
      } else {
        const p = document.createElement("p");
        p.textContent = `${items.length} track${items.length === 1 ? "" : "s"} flagged:`;
        out.appendChild(p);
        const ul = document.createElement("ul");
        items.forEach(it => {
          const li = document.createElement("li");
          const strong = document.createElement("strong");
          strong.textContent = (it.manual ? "📌 " : "") + it.title;
          const folder = document.createElement("span");
          folder.className = "dim";
          folder.textContent = ` (${it.folder}) `;
          const reason = document.createTextNode(`— ${it.reason}`);
          li.append(strong, folder, reason);
          ul.appendChild(li);
        });
        out.appendChild(ul);
      }
    } catch (e){
      const p = document.createElement("p");
      p.className = "dim";
      p.textContent = "Scan failed - is the server running?";
      out.appendChild(p);
    }
    btn.disabled = false;
    btn.textContent = label;
  };
}

// builds the extruded-logo illusion: stacked copies of the same "AQAI"
// text (set via Brice, the same font the home screen's wordmark uses)
// a few px apart in depth - solid green, with one moderate specular
// sheen (pre-rendered to a bitmap and used as a plain <img>, since live
// CSS/SVG gradients - background-clip:text or an inline SVG fill -
// silently paint as a flat color once nested inside this
// transform-style:preserve-3d stack, a compositing quirk bitmaps
// aren't subject to)
const LOGO3D_DEPTH = 20;
const logo3dEl = $("#gate-logo3d");
// fillColor now parameterized - the intro logo cycles through it (see
// startLogoColorCycle below), so every face gets re-rendered with a new
// fill on each color step instead of a fixed black
function renderLogoFace(fillColor, strokeColor, specular, specularPos){
  const W = 1200, H = 450;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.font = `900 ${H * 0.85}px Brice, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const cx = W / 2, cy = H / 2 + H * 0.03;
  // fill with a hairline outline (stroke drawn first so the fill covers
  // its inner half, leaving just the outer edge visible) - this canvas
  // renders at 1200px wide then displays at 50% of the screen width (see
  // .logo3d's width:50vw). Stroke defaults to the fill color itself (was
  // always hardcoded white) so the sides' color-cycle carries all the way
  // to the edge instead of keeping a fixed white rim
  ctx.lineJoin = "round";
  ctx.fillStyle = fillColor;
  ctx.fillText("AQAI", cx, cy);
  ctx.strokeStyle = strokeColor || fillColor; // 1px hairline outline (3px @1200 ≈ 1px on screen)
  ctx.lineWidth = 3;
  ctx.strokeText("AQAI", cx, cy);
  if (specular){
    // a soft, wide diagonal glossy sheen (much more diffuse than a tight
    // hotspot), painted only over the already-lit text pixels (source-atop)
    // so it reads as a specular highlight instead of a flat overlay
    // outside the letterforms. Its position sweeps back and forth (see
    // startLogoColorCycle) so it reads as light moving across the surface
    const pos = specularPos == null ? 0.5 : specularPos;
    ctx.globalCompositeOperation = "source-atop";
    const grad = ctx.createLinearGradient(0, H * 0.15, W * 0.6, H * 0.85);
    grad.addColorStop(Math.max(0, pos - 0.45), "rgba(255,255,255,0)");
    grad.addColorStop(Math.max(0, pos - 0.05), "rgba(255,255,255,0.22)");
    grad.addColorStop(Math.min(1, pos + 0.05), "rgba(255,255,255,0.22)");
    grad.addColorStop(Math.min(1, pos + 0.45), "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";
  }
  return canvas.toDataURL("image/png");
}
// only the extruded SIDE layers (the depth between front and back) fade
// through colors - the front and back end caps stay fixed (never
// animated), but at the 10%-darkest version of the same artist colors
// the sides cycle through, instead of pure black
const logo3dSideImgs = [];
const logo3dCapImgs = []; // front/back - color stays fixed black, but the specular sheen sweeps across them
if (logo3dEl){
  (async () => {
    try { await document.fonts.load(`900 ${450 * 0.85}px Brice`); } catch (e) {}
    const blackSrc = renderLogoFace("#000000", "#ffffff", true, 0.5); // front/back: fixed black, with a light specular sheen (position animates)
    const sideSrc = renderLogoFace("#ffffff"); // sides: start white, then cycle
    for (let i = LOGO3D_DEPTH; i >= 0; i--){
      const isEndCap = i === 0 || i === LOGO3D_DEPTH;
      const layer = document.createElement("div");
      layer.className = "logo3d-layer" + (i === 0 ? " logo3d-front" : "") + (i === LOGO3D_DEPTH ? " logo3d-back" : "");
      layer.style.transform = `translateZ(${-i}px)`;
      const img = document.createElement("img");
      img.src = isEndCap ? blackSrc : sideSrc;
      img.alt = "";
      img.style.cssText = "width:100%;height:100%;object-fit:contain;";
      layer.appendChild(img);
      logo3dEl.appendChild(layer);
      if (!isEndCap) logo3dSideImgs.push(img);
      else logo3dCapImgs.push(img);
    }
    startLogoColorCycle();
  })();
}
// the extruded sides fade white -> through every artist's color -> back
// to white, looping continuously while the gate is up. Re-renders the
// canvas bitmap (throttled - the bitmap approach can't be recolored with
// a plain CSS filter, see the comment above renderLogoFace) rather than
// running every animation frame, since a slow color fade doesn't need it
function startLogoColorCycle(){
  const LOGO_CYCLE_SEC = 16;
  const white = new THREE.Color(0xffffff);
  let lastUpdate = -1;
  function tick(){
    if (!document.body.classList.contains("gate-active")) return; // stop once the gate is dismissed
    const now = performance.now();
    if (now - lastUpdate > 120){
      lastUpdate = now;
      const artistColors = [...new Set(TRACKS.map(t => t.artistColor).filter(Boolean))].map(c => new THREE.Color(c));
      const stops = [white, ...(artistColors.length ? artistColors : [new THREE.Color(0x7CFF9E)]), white];
      const u = (now / 1000 % LOGO_CYCLE_SEC) / LOGO_CYCLE_SEC;
      const f = u * (stops.length - 1);
      const i0 = Math.min(stops.length - 2, Math.floor(f));
      const c = stops[i0].clone().lerp(stops[i0 + 1], f - i0);
      const src = renderLogoFace("#" + c.getHexString());
      logo3dSideImgs.forEach(img => { img.src = src; });
      // the front/back caps' own specular sheen sweeps back and forth
      // slowly across the letters, like light moving over the surface
      const CAP_SWEEP_SEC = 6;
      const sweepU = (1 - Math.cos(now / 1000 / CAP_SWEEP_SEC * Math.PI * 2)) / 2;
      const capSrc = renderLogoFace("#000000", "#ffffff", true, sweepU);
      logo3dCapImgs.forEach(img => { img.src = capSrc; });
    }
    requestAnimationFrame(tick);
  }
  tick();
}

// the hint text cycles the same colors as the button, per letter, so it
// sweeps left to right instead of changing everywhere at once
const gateHintEl = $(".gate-hint");
if (gateHintEl){
  const hintText = gateHintEl.textContent;
  gateHintEl.textContent = "";
  [...hintText].forEach((ch, i) => {
    const span = document.createElement("span");
    span.className = "gate-hint-letter";
    span.style.setProperty("--i", i);
    span.textContent = ch === " " ? " " : ch;
    gateHintEl.appendChild(span);
  });
}

// hidden entirely for non-owner visitors; #btn-sphere-control deliberately
// isn't here - it stays visible for everyone (it's a view control, not editing)
const OWNER_ONLY_SELECTORS = [
  "#pano-btns", "#btn-delete", "#btn-edit-title", "#btn-edit-artist",
  "#btn-edit-lyrics", "#btn-relocate-artist", "#lf-edit-btns",
  "#lyrics-audit-block", "#btn-flag-lyrics", "#btn-make-video",
];
// true only when the server confirms this request never crossed the public
// reverse proxy (see "editable" on /api/tracks and _is_public_request() in
// server.py) - the real boundary for who gets editing controls
let EDITABLE = false;
function updateEditControlsVisibility(){
  const hide = !EDITABLE;
  OWNER_ONLY_SELECTORS.forEach(sel => {
    const el = document.querySelector(sel);
    if (el) el.style.display = hide ? "none" : "";
  });
  const lfList = $("#lf-list");
  if (lfList) lfList.classList.toggle("editable", !hide);
}

// the library manifest fetch (see BOOT below) can take a real, visible
// moment - scanning the whole folder tree on first load, especially on
// the live server. Without this, tapping through before it resolves left
// an empty-looking home screen with no track, no lyrics, no audio and no
// explanation why. The button now stays disabled and says so until the
// manifest actually lands.
let tracksReady = false;
function updateGateLoadingState(){
  const btn = $("#gate-btn");
  if (!btn) return;
  btn.disabled = !tracksReady;
  btn.textContent = tracksReady ? "TAP TO LISTEN" : "LOADING…";
  btn.classList.toggle("loading", !tracksReady);
}
updateGateLoadingState();

$("#gate-btn").onclick = () => {
  if (!tracksReady) return;
  $("#gate").classList.add("hidden");
  document.body.classList.remove("gate-active");
  // the (now hidden) password input may still hold keyboard focus, which
  // would swallow the arrow-key flight controls - release it
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  panoUniforms.uGate.value = 0; // restore the sphere's shader effects for the music screen
  tunnelGroup.visible = false; // intro-only tunnel hands off to the sphere (or the Polaroid road)
  tunnelLight.visible = false;
  camera.position.y = 0; // undo the tunnel's lowered viewpoint for the sphere's mouse-look
  camera.position.z = 8; // undo the tunnel's deeper placement too - back to its previous position
  // the pano shader's near/far distance range was baked in from wherever
  // the camera was when the mesh was last built (during the gate) -
  // recompute now that it just moved, so the falloff still matches
  if (panoMesh) computePanoDistRange(panoMesh);
  updateArtistBackground(TRACKS[cur]);
  // .home-top/#lyrics/#wave-canvas were all display:none behind the gate,
  // so the very first positionWaveCanvas() (run from the initial resize()
  // at boot) measured zero-size rects - redo it now that they're visible
  positionWaveCanvas();
  initAudio();
  // this tap is the one guaranteed user gesture in the whole app, so
  // it's also used to go full screen automatically - no separate toggle
  // button for it, just this
  if (document.documentElement.requestFullscreen && !document.fullscreenElement){
    document.documentElement.requestFullscreen().catch(() => {});
  }
  if (TRACKS.length) load(Math.floor(Math.random() * TRACKS.length), true);
};

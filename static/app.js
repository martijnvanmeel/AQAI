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
let panoManualIndex = -1;
// reserved for the intro screen only - excluded from the per-track pick,
// the 5s random rotation, and manual prev/next browsing during playback
const INTRO_PANO_FILE = "From Klickpin.com- 68749462254-pin-id-68749462254.mp4";
// test source: Panoramas2 (mix of .mp4 clips and .gif animations), served
// via /api/panoramas2 + /panorama2/ instead of the original panoramas folder
fetch("/api/panoramas2").then(r => r.json()).then(data => {
  PANORAMAS = (data.files || []).filter(f => f !== INTRO_PANO_FILE);
  updatePanoLabel();
}).catch(() => {});
function setBgVideoForTrack(track) {
  if (!PANORAMAS.length || typeof panoVideoEl === "undefined") return;
  // the server lists panoramas newest-first; bias the (still per-track
  // deterministic) pick toward the front of that list so freshly-added
  // clips show up far more often than older ones
  const frac = (hashString((track.id || track.title || "") + "#bg") % 100000) / 100000;
  const idx = Math.min(PANORAMAS.length - 1, Math.floor(Math.pow(frac, 2.2) * PANORAMAS.length));
  loadPanoFile(PANORAMAS[idx]);
  panoManualIndex = idx;
  updatePanoLabel();
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
const LYRIC_GAP_COLOR = "#0A1830"; // dark blue the last sentence fades to during a silence gap, instead of vanishing
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
      const prevEnd = prev.words.length ? prev.words[prev.words.length - 1].t : prev.t0;
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
  const { before, after } = realNeighbors(dl, li, LYRIC_ROW_REACH);
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
  const dur = Math.max(0.2, dl[dli].t1 - dl[dli].t0);
  // fades each word's color down to a dark blue rather than fading the
  // row's opacity to nothing - the sentence stays put and visible
  // (dimmed), it just stops reading as "currently sung" during the gap
  const spans = row.querySelectorAll(".w");
  spans.forEach(w => {
    w.style.animation = "none";
    w.style.transition = "none";
    w.style.color = "var(--fg)";
  });
  row.getBoundingClientRect();
  spans.forEach(w => {
    w.style.transition = `color ${dur}s linear`;
    w.style.color = LYRIC_GAP_COLOR;
  });
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
    // start on the artist color, darkened (49% artist = a further 30% darker)
    spans[i].style.color = "color-mix(in srgb, var(--artist-color, var(--active-green)) 49%, black)";
  }
  row.getBoundingClientRect();
  // each word fades blue -> green -> yellow -> white one by one, on its
  // own turn, so the last word finishes fading right as the next
  // sentence takes over (no scaling - color fade only)
  for (let i = 0; i < spans.length; i++){
    const wordStart = words[i].t - start;
    const wordEnd = (i < words.length - 1 ? words[i + 1].t : end) - start;
    const fadeDuration = Math.max(0.15, wordEnd - wordStart);
    spans[i].style.animation = `wordFadeBlueGreenWhite ${fadeDuration}s linear ${wordStart}s forwards`;
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
  // canvas drawing can't reference a CSS custom property directly
  const artistColor = tr.artistColor || "#7CFF9E";
  document.documentElement.style.setProperty("--artist-color", artistColor);
  WAVE_COLOR = artistColor;
  positionBgGradient();
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
const WAVE_SEGMENTS = 160;
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
  const height = Math.max(40, Math.min(80, lyricsTop * 0.5)) + 40;
  const photoRect = photo.getBoundingClientRect();
  const centerY = photoRect.top + photoRect.height / 2;
  const canvasCenterY = centerY + 40 - 15 + 5 + 10 - 22 + 20; // visualiser (only) net 20px down from that
  const top = canvasCenterY - height / 2;
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
const TUNNEL_SPEED = 5.5; // world units/sec scrolled toward the camera ("flying backwards" through it)
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
// same palette, dimmed way down - the tunnel walls read as near-black with
// just a tint of the artist color, so the point light (see tunnelLight)
// standing in for the AQAI logo has something to visibly glint off of
function tunnelSurfaceColorForRing(ring, out){
  return tunnelColorForRing(ring, out).multiplyScalar(0.14);
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
    uniforms: { uResolution: { value: tunnelLineResolution }, uLineWidth: { value: 3.2 } },
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
      void main(){
        // same distance fade as applyTunnelProximityGrow(): the deeper
        // into the tunnel, the darker AND more transparent it gets
        float tunnelFade = 1.0 - smoothstep( 35.0, 130.0, vTunnelFadeDist );
        gl_FragColor = vec4( vColor * tunnelFade, tunnelFade );
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
    shader.fragmentShader = "varying float vTunnelFadeDist;\n" + shader.fragmentShader
      .replace(
        "#include <fog_fragment>",
        `#include <fog_fragment>
        float tunnelFade = 1.0 - smoothstep( 35.0, 130.0, vTunnelFadeDist );
        gl_FragColor.rgb *= tunnelFade;
        gl_FragColor.a *= tunnelFade;`
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
const ROAD_COLS = 36;           // terrain grid resolution across (x)
const ROAD_ROWS = 44;           // terrain grid rows per chunk (z)
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
let roadEdgeGeos = [];
let roadEdgeMat = null;
function retintRoadStrip(artistColor){
  if (!roadStripGeo) return;
  const totalRows = ROAD_ROWS * ROAD_REPEATS;
  // darker, moodier ends of the sweep (whole-scene darkening pass)
  const cA = new THREE.Color(artistColor || "#7ED957").multiplyScalar(0.42);
  const cB = new THREE.Color(0x2d5bd8).multiplyScalar(0.55);
  const attr = roadStripGeo.attributes.color;
  const tmpColor = new THREE.Color();
  for (let r = 0; r <= totalRows; r++){
    const a = ((r % ROAD_ROWS) / ROAD_ROWS) * Math.PI * 2;
    tmpColor.copy(cA).lerp(cB, (Math.sin(a) + 1) / 2);
    attr.setXYZ(r * 2, tmpColor.r, tmpColor.g, tmpColor.b);
    attr.setXYZ(r * 2 + 1, tmpColor.r, tmpColor.g, tmpColor.b);
    // edge ribbons carry the same gradient at 2x the road's brightness;
    // their quad layout has 4 verts per segment - verts 0/1 belong to row
    // s, verts 2/3 to row s+1 (see the builder in buildRoadStrip)
    roadEdgeGeos.forEach(geo => {
      const ec = geo.attributes.color;
      if (r < totalRows){ ec.setXYZ(r * 4, tmpColor.r * 2, tmpColor.g * 2, tmpColor.b * 2); ec.setXYZ(r * 4 + 1, tmpColor.r * 2, tmpColor.g * 2, tmpColor.b * 2); }
      if (r > 0){ ec.setXYZ((r - 1) * 4 + 2, tmpColor.r * 2, tmpColor.g * 2, tmpColor.b * 2); ec.setXYZ((r - 1) * 4 + 3, tmpColor.r * 2, tmpColor.g * 2, tmpColor.b * 2); }
    });
  }
  attr.needsUpdate = true;
  roadEdgeGeos.forEach(geo => { geo.attributes.color.needsUpdate = true; });
}
function buildRoadStrip(group){
  const totalRows = ROAD_ROWS * ROAD_REPEATS;
  const positions = [];
  for (let r = 0; r <= totalRows; r++){
    const center = roadCenterAt(r * ROAD_SEG);
    const z = -r * ROAD_SEG;
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
  // edge lines hugging both sides of the ribbon: 3px screen-space ribbon
  // quads (plain GL lines ignore linewidth - same technique as the tunnel
  // wireframe), carrying the gradient at 2x the road's brightness, glowing
  // additively and surging with the music via the uBeat uniform
  roadEdgeMat = new THREE.ShaderMaterial({
    uniforms: { uResolution: { value: tunnelLineResolution }, uLineWidth: { value: 3 }, uBeat: { value: 1 } },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    vertexShader: `
      attribute vec3 aOther;
      attribute float aSide;
      attribute vec3 color;
      uniform vec2 uResolution;
      uniform float uLineWidth;
      varying vec3 vColor;
      varying float vDist;
      void main(){
        vColor = color;
        vec4 mvSelf = modelViewMatrix * vec4( position, 1.0 );
        vDist = -mvSelf.z;
        vec4 clipSelf = projectionMatrix * mvSelf;
        vec4 clipOther = projectionMatrix * ( modelViewMatrix * vec4( aOther, 1.0 ) );
        vec2 screenSelf = clipSelf.xy / clipSelf.w * uResolution;
        vec2 screenOther = clipOther.xy / clipOther.w * uResolution;
        vec2 dir = normalize( screenOther - screenSelf + 1e-4 );
        vec2 normal = vec2( -dir.y, dir.x );
        clipSelf.xy += ( normal * ( uLineWidth * 0.5 ) * aSide / uResolution ) * clipSelf.w;
        gl_Position = clipSelf;
      }
    `,
    fragmentShader: `
      uniform float uBeat;
      varying vec3 vColor;
      varying float vDist;
      void main(){
        // hand-rolled distance fade standing in for the scene fog (custom
        // shaders don't get three's fog injection)
        float fade = 1.0 - smoothstep( 80.0, 260.0, vDist );
        gl_FragColor = vec4( vColor * uBeat * fade, fade );
      }
    `,
  });
  roadEdgeGeos = [-1, 1].map(sideSign => {
    const positionsE = [], others = [], sides = [];
    const rowPoint = r => {
      const center = roadCenterAt(r * ROAD_SEG);
      return [center.x + sideSign * ROAD_HALF_WIDTH, center.y + 0.05, -r * ROAD_SEG];
    };
    const indicesE = [];
    for (let s = 0; s < totalRows; s++){
      const a = rowPoint(s), b = rowPoint(s + 1);
      positionsE.push(...a, ...a, ...b, ...b);
      others.push(...b, ...b, ...a, ...a);
      sides.push(-1, 1, -1, 1);
      const base = s * 4;
      indicesE.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positionsE, 3));
    geo.setAttribute("aOther", new THREE.Float32BufferAttribute(others, 3));
    geo.setAttribute("aSide", new THREE.Float32BufferAttribute(sides, 1));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(totalRows * 4 * 3), 3));
    geo.setIndex(indicesE);
    const mesh = new THREE.Mesh(geo, roadEdgeMat);
    mesh.frustumCulled = false;
    group.add(mesh);
    return geo;
  });
  retintRoadStrip("#7ED957"); // sensible default (incl. edges) until a track is active
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
function buildRoadBalls(group){
  const ballGeo = new THREE.SphereGeometry(0.26, 12, 10);
  const ballMat = new THREE.MeshBasicMaterial({ color: 0xff4038 });
  const poolMat = new THREE.MeshBasicMaterial({ map: roadPoolTexture, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false });
  const poolGeo = new THREE.PlaneGeometry(9, 9);
  poolGeo.rotateX(-Math.PI / 2);
  const PER_CHUNK = 5;
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
      s.userData.rise = 8 + roadHash(i, 7) * 6;
      s.userData.period = 22 + roadHash(i, 9) * 18; // seconds per full rise
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
const roadFog = new THREE.FogExp2(0x120821, 0.0052);
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
const MIST_SPEED = 8; // floaty, but with real forward motion
const MIST_SKY = new THREE.Color(0x241d5c); // the reference's deep indigo
// soft round puff - the one texture every cloud sprite shares
const mistPuffTexture = (() => {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 128;
  const cx = cv.getContext("2d");
  const g = cx.createRadialGradient(64, 64, 6, 64, 64, 62);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(0.5, "rgba(255,255,255,0.45)");
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
{
  // hash-driven template (no Math.random) so every tile is an exact copy -
  // that's what makes the scroll wrap invisible and the flight endless.
  // Puffs are THREE.Points in three size buckets (NOT sprites - textured
  // SpriteMaterials silently rendered nothing in this renderer setup, see
  // the road stars which use this same proven Points pipeline), additive
  // so overlap just builds glow and needs no depth sorting.
  const h = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
  const CLUSTERS = 20;
  const buckets = [
    { size: 280, positions: [], colors: [] },
    { size: 406, positions: [], colors: [] },
    { size: 546, positions: [], colors: [] },
  ];
  for (let rep = 0; rep < MIST_REPEATS; rep++){
    for (let ci = 0; ci < CLUSTERS; ci++){
      // the whole field sits low, from the view's midline downward - the
      // camera looks down over a screen-filling floor of dark cloud.
      // Spread very wide with few puffs per cluster, so the huge puffs
      // still leave real open sky between cloud masses
      const cx0 = (h(ci, 1) - 0.5) * 700;
      const cy0 = -16 + h(ci, 2) * 6;
      const cz0 = -h(ci, 3) * MIST_CHUNK_LENGTH;
      const puffs = 4 + Math.floor(h(ci, 4) * 4);
      for (let pi = 0; pi < puffs; pi++){
        // offsets scaled to the huge puff size, so a cluster reads as a
        // sprawling cloud mass instead of one white-hot stacked blob
        const dx = (h(ci * 31 + pi, 5) - 0.5) * 280;
        const dy = (h(ci * 31 + pi, 6) - 0.35) * 60; // flattened field: wider than tall
        const dz = (h(ci * 31 + pi, 7) - 0.5) * 220;
        // color by height in the cluster: cool underside, coral middle,
        // and the occasional warm glowing core puff at the heart
        let color;
        if (dy < -1.5) color = MIST_UNDER[(ci + pi) % MIST_UNDER.length];
        else if (Math.abs(dx) < 8 && h(ci * 7 + pi, 9) < 0.3) color = MIST_CORES[(ci + pi) % MIST_CORES.length];
        else color = MIST_TOPS[(ci + pi) % MIST_TOPS.length];
        const bucket = buckets[Math.floor(h(ci * 13 + pi, 10) * 3) % 3];
        bucket.positions.push(cx0 + dx, cy0 + dy, cz0 + dz - rep * MIST_CHUNK_LENGTH);
        bucket.colors.push(color.r, color.g, color.b);
      }
    }
  }
  buckets.forEach(b => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(b.positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(b.colors, 3));
    const points = new THREE.Points(geo, new THREE.PointsMaterial({ size: b.size, sizeAttenuation: true,
      map: mistPuffTexture, vertexColors: true, transparent: true, opacity: 0.85,
      depthWrite: false, blending: THREE.AdditiveBlending }));
    // puffs must not pop out while still partly on screen - only vanish
    // once they're genuinely behind the camera
    points.frustumCulled = false;
    mistGroup.add(points);
  });
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
const dtMats = DT_BASE_COLORS.map(color => new THREE.MeshPhongMaterial({ color: color.clone(), specular: 0x2a1c10, shininess: 8 }));
const dtReactiveSlabs = []; // slabs that light up with the music (see animate())
const downtownGroup = new THREE.Group();
{
  const h = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  // solid corridor shell behind the slabs, so gaps read as dark wood
  const shellMat = new THREE.MeshPhongMaterial({ color: 0x2a1a0e, specular: 0x000000, shininess: 4, side: THREE.BackSide });
  const shell = new THREE.Mesh(new THREE.BoxGeometry(DT_HALF_W * 2, DT_HALF_H * 2, DT_CHUNK_LENGTH * DT_REPEATS), shellMat);
  shell.position.z = -DT_CHUNK_LENGTH * DT_REPEATS / 2;
  downtownGroup.add(shell);
  // per-chunk template of slabs on all four sides, tiled DT_REPEATS times
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
      downtownGroup.add(slab);
    }
  }
}
// tint the maze into the artist's own color range (called on activation,
// when the current track - and so its artistColor - is known), with
// dedicated red, green and blue slab variants scattered through the scene
const dtTintColor = new THREE.Color();
const DT_RGB_VARIANTS = [0xa03028, 0x2f7a3a, 0x2d4fa0].map(c => new THREE.Color(c)); // dark red / green / blue
function applyDowntownTint(artistColor){
  dtTintColor.set(artistColor || "#8a5a2c");
  dtMats.forEach((mat, i) => {
    if (i < 3){
      // half the palette: warm base pulled toward the artist color
      mat.color.copy(DT_BASE_COLORS[i]).lerp(dtTintColor, 0.5).multiplyScalar(0.85);
    } else {
      // the other half: the red/green/blue variants, faintly artist-tinted
      mat.color.copy(DT_RGB_VARIANTS[i - 3]).lerp(dtTintColor, 0.2).multiplyScalar(0.85);
    }
  });
  dtReactiveSlabs.forEach(slab => {
    slab.material.color.copy(DT_BASE_COLORS[0]).lerp(dtTintColor, 0.6).multiplyScalar(0.85);
    slab.material.emissive.copy(dtTintColor).multiplyScalar(0.5);
    slab.material.emissiveIntensity = 0;
  });
}
downtownGroup.visible = false;
scene.add(downtownGroup);
// warm light near the camera - the corridor darkens with distance, like
// the reference's vanishing point; plus a dim warm ambient fill
const downtownLight = new THREE.PointLight(0xffd9a0, 1.6, 70 * DT_SCALE, 1.8);
downtownLight.position.set(0, 2 * DT_SCALE, 2);
downtownLight.visible = false;
scene.add(downtownLight);
const downtownAmbient = new THREE.AmbientLight(0x2a180c, 0.9);
downtownAmbient.visible = false;
scene.add(downtownAmbient);
const downtownFog = new THREE.FogExp2(0x120a05, 0.02 / DT_SCALE);

// swaps the sphere for a per-artist 3D scene: Polaroid gets the synthwave
// road, Aveluna gets the mist world. Called on every track load (see
// load()) and once more from the gate handoff, since the very first
// "current" track is only known then. Also drives the renderer clear
// color + scene fog to match whichever scene is up.
function updateArtistBackground(tr){
  const gateActive = document.body.classList.contains("gate-active");
  const wantRoad = !gateActive && !!tr && tr.artist === ROAD_ARTIST_NAME;
  const wantMist = !gateActive && !!tr && tr.artist === MIST_ARTIST_NAME;
  const wantMaze = !gateActive && !!tr && tr.artist === DT_ARTIST_NAME;
  roadGroup.visible = wantRoad;
  roadScenery.visible = wantRoad;
  mistGroup.visible = wantMist;
  downtownGroup.visible = wantMaze;
  downtownLight.visible = wantMaze;
  downtownAmbient.visible = wantMaze;
  if (panoMesh) panoMesh.visible = !gateActive && !wantRoad && !wantMist && !wantMaze;
  // vertical-grid overlay shows over every 3D environment (see styles.css;
  // the intro tunnel is covered by its own body.gate-active selector)
  document.body.classList.toggle("scene-3d", wantRoad || wantMist || wantMaze);
  // tighter lens in every constructed environment (incl. the intro
  // tunnel) = a more zoomed, cinematic framing; only the plain video
  // sphere keeps the natural 1x lens
  camera.zoom = gateActive ? 1.3 : wantRoad ? 1.6 : (wantMist || wantMaze) ? 1.35 : 1;
  camera.updateProjectionMatrix();
  if (wantRoad){
    // deep retro purple-black night sky (darkened), plus a haze that
    // melts the far terrain into the dark
    retintRoadStrip(tr.artistColor);
    roadClearColor.set(0x0f0719);
    renderer.setClearColor(roadClearColor, 1);
    scene.fog = roadFog;
  } else if (wantMist){
    // the reference art's deep indigo night - clear color and fog match
    // exactly so far clouds dissolve seamlessly into the sky
    mistColor.copy(MIST_SKY);
    mistFog.color.copy(mistColor);
    renderer.setClearColor(mistColor, 1);
    scene.fog = mistFog;
  } else if (wantMaze){
    // near-black warm brown: the corridor's far end vanishes into it
    applyDowntownTint(tr.artistColor);
    renderer.setClearColor(0x120a05, 1);
    scene.fog = downtownFog;
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
    if (panoGifImg.getAttribute("src") !== src) panoGifImg.src = src;
    else rebuildPanoMesh();
  } else {
    currentPanoKind = "video";
    panoMat.map = panoTexture;
    if (panoVideoEl.getAttribute("src") !== src){
      panoVideoEl.src = src;
      panoVideoEl.play().catch(() => {});
    }
  }
}

/* ---- manual panorama browser: page through every clip in the Panoramas2
   folder (newest first), overriding the automatic per-track pick until
   the next track loads ---- */
function updatePanoLabel(){
  const label = $("#pano-label");
  if (!label) return;
  label.textContent = PANORAMAS.length
    ? `${panoManualIndex + 1} / ${PANORAMAS.length}`
    : "0 / 0";
}
function showPanoAt(idx){
  if (!PANORAMAS.length) return;
  panoManualIndex = ((idx % PANORAMAS.length) + PANORAMAS.length) % PANORAMAS.length;
  loadPanoFile(PANORAMAS[panoManualIndex]);
  updatePanoLabel();
}
// when true the user steers the sphere with the mouse; when false (default)
// the sphere drifts on its own and reacts to the music (see animate())
let sphereUserControl = false;
$("#btn-sphere-control").onclick = e => {
  sphereUserControl = !sphereUserControl;
  const btn = e.currentTarget;
  btn.classList.toggle("on", sphereUserControl);
  btn.setAttribute("aria-pressed", sphereUserControl ? "true" : "false");
  btn.setAttribute("aria-label", sphereUserControl
    ? "Stop controlling the sphere (let it react to the music)"
    : "Control the sphere with your mouse");
};
$("#pano-prev").onclick = () => showPanoAt(panoManualIndex - 1);
$("#pano-next").onclick = () => showPanoAt(panoManualIndex + 1);

/* fullscreen toggle - top-left corner, mirrors #btn-sphere-control's
   top-right spacing. Icon/aria state follows the real fullscreen state
   (via fullscreenchange) rather than being flipped optimistically, so it
   stays correct even if the browser exits fullscreen on its own (Escape key) */
function updateFullscreenBtn(){
  const on = !!document.fullscreenElement;
  const btn = $("#btn-fullscreen");
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.setAttribute("aria-label", on ? "Exit fullscreen" : "Enter fullscreen");
}
$("#btn-fullscreen").onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => toast("Fullscreen isn't available"));
};
document.addEventListener("fullscreenchange", updateFullscreenBtn);

// the intro/gate screen shows this specific clip (reserved via
// INTRO_PANO_FILE, excluded from regular playback rotation) on the shared
// panorama sphere until the listener taps in, at which point load() picks
// a per-track background as usual
loadPanoFile(INTRO_PANO_FILE);

// lets you cull a background you don't like right when you see it - the
// file is moved server-side into Panoramas2/_removed (not deleted
// outright) so a wrong click stays recoverable
let panoRemoveInFlight = false;
function removeCurrentPano(){
  if (panoRemoveInFlight || !PANORAMAS.length) return;
  const file = PANORAMAS[panoManualIndex];
  if (!file) return;
  panoRemoveInFlight = true;
  fetch("/api/panoramas2/remove", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file })
  }).then(r => r.json()).then(data => {
    if (!data.ok){ toast("Could not remove background"); return; }
    PANORAMAS.splice(panoManualIndex, 1);
    toast("Background removed");
    if (!PANORAMAS.length){
      panoManualIndex = -1;
      updatePanoLabel();
      return;
    }
    showPanoAt(panoManualIndex);
  }).catch(() => toast("Could not remove background"))
    .finally(() => { panoRemoveInFlight = false; });
}
$("#pano-remove").onclick = removeCurrentPano;

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
// timestamp the automatic motion (re)starts from; null forces a fresh
// "centred, then ease in" ramp the next time auto-drift takes over
let autoMotionStartT = null;
function animate(t){
  requestAnimationFrame(animate);
  if (analyser && playing) analyser.getByteFrequencyData(freqData);
  updateVuMeter(analyser && playing);
  updateWaveSamples();
  drawWaveCanvas();
  panoUniforms.uIntensity.value += (audioIntensity() - panoUniforms.uIntensity.value) * 0.15;
  updateArtistRingVisualiser();
  // logo no longer scales with music intensity - fixed size, just its
  // own CSS centering (see positionLogo())

  // camera target. When the user has taken control (sphere-control button,
  // music screen only) the mouse steers it. Otherwise the sphere drifts on
  // its own — an elegant Lissajous sweep (yaw left↔right, pitch up↔down on
  // two slow periods ~25s/~33s so it never resyncs into a mechanical loop),
  // and on the music screen that drift also reacts to the audio: louder
  // passages add a faster, wider sway on top (uIntensity is ~0 on the
  // silent intro, so there it stays the pure elegant drift).
  let targetYaw, targetPitch, camSmooth;
  if (sphereUserControl && !document.body.classList.contains("gate-active")){
    targetYaw = -mouseNX * 0.5;
    targetPitch = -mouseNY * 0.35;
    camSmooth = 0.04335; // slow trailing follow for mouse-look
    autoMotionStartT = null; // restart the centred ramp when auto resumes
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
    tunnelGroup.position.z = (nowSec * TUNNEL_SPEED) % TUNNEL_CHUNK_LENGTH;
    // same 9s period as the intro logo's own CSS spin (logo3dSpin)
    tunnelGroup.rotation.z = (nowSec / 9) * Math.PI * 2;
  }

  if (roadGroup.visible){
    // drone flight over the rolling, curving road - deliberately
    // disconnected from audio and mouse. The road streams toward the
    // camera (seamless chunk wrap); the camera tracks the centerline
    // point currently under it, looks/banks into the curve ahead, and
    // adds slow orbital sweeps in every direction on top, all lerped so
    // each move is an elegant glide
    const nowSec = (t || 0) * 0.001;
    const scroll = nowSec * ROAD_SPEED;
    roadGroup.position.z = scroll % ROAD_CHUNK_LENGTH;
    // the centerline point at the camera's own world z (camera sits at
    // z=8; road point d renders at world z = scroll - d)
    const here = roadCenterAt(scroll - 8);
    const ahead = roadCenterAt(scroll - 8 + 14);
    // long lookahead + a soft follow factor + slow low-amplitude sways =
    // unhurried, stylish glides instead of abrupt corrections
    const follow = 0.02;
    roadCamX += (here.x + Math.sin(nowSec * 0.055) * 1.6 - roadCamX) * follow;
    roadCamY += (here.y + ROAD_CAM_HEIGHT + Math.sin(nowSec * 0.045 + 1) * 1.0 - roadCamY) * follow;
    // hard floor: whatever the sway/lerp is doing, never sink below the
    // road surface under the camera
    roadCamY = Math.max(roadCamY, here.y + 2.6);
    // look into the curve/hill ahead, with a slow scanning sway on top
    roadCamYaw += (-Math.atan2(ahead.x - here.x, 14) * 0.6 + Math.sin(nowSec * 0.032) * 0.05 - roadCamYaw) * follow;
    roadCamPitch += (Math.atan2(ahead.y - here.y, 14) * 0.45 - 0.05 + Math.sin(nowSec * 0.028 + 3) * 0.03 - roadCamPitch) * follow;
    roadCamBank += (-Math.atan2(ahead.x - here.x, 14) * 0.8 + Math.sin(nowSec * 0.025 + 5) * 0.025 - roadCamBank) * follow;
    camera.position.x = roadCamX;
    camera.position.y = roadCamY;
    camera.rotation.x = roadCamPitch;
    camera.rotation.y = roadCamYaw;
    camera.rotation.z = roadCamBank;
    // stars stream from the far back toward (and past) the camera
    roadStars.position.z = (nowSec * ROAD_STAR_SPEED) % ROAD_STAR_DEPTH;
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
    // the same smoothed audio level the other visualisers use), and the
    // edge ribbons - already 2x the road's brightness - glow much harder
    if (roadStripMat) roadStripMat.color.setScalar(1 + panoUniforms.uIntensity.value * 0.25);
    if (roadEdgeMat) roadEdgeMat.uniforms.uBeat.value = 1 + panoUniforms.uIntensity.value * 1.5;
  } else if (mistGroup.visible){
    // endless drone flight THROUGH the cloud field, in the same style as
    // the Polaroid road: the camera lerp-follows an invisible curving
    // path at cloud level - masses loom past on every side rather than
    // sliding by underneath - looking and banking into the curve ahead
    const nowSec = (t || 0) * 0.001;
    const scroll = nowSec * MIST_SPEED;
    mistGroup.position.z = scroll % MIST_CHUNK_LENGTH;
    const here = mistPathAt(scroll - 8);
    const ahead = mistPathAt(scroll - 8 + 14);
    const follow = 0.02;
    // generous sways on every axis - the drone wanders far off the path
    // line and rolls/looks all around while following it
    mistCamX += (here.x + Math.sin(nowSec * 0.055) * 8 - mistCamX) * follow;
    mistCamY += (-10 + here.y + Math.sin(nowSec * 0.045 + 1) * 6 - mistCamY) * follow;
    mistCamYaw += (-Math.atan2(ahead.x - here.x, 14) * 0.6 + Math.sin(nowSec * 0.032) * 0.22 - mistCamYaw) * follow;
    // base pitch tilted up ~0.2rad (~200px at this zoom/viewport): the
    // whole cloudscape sits that much lower in the frame
    mistCamPitch += (Math.atan2(ahead.y - here.y, 14) * 0.45 + 0.18 + Math.sin(nowSec * 0.028 + 3) * 0.1 - mistCamPitch) * follow;
    mistCamBank += (-Math.atan2(ahead.x - here.x, 14) * 0.8 + Math.sin(nowSec * 0.025 + 5) * 0.12 - mistCamBank) * follow;
    camera.position.x = mistCamX;
    camera.position.y = mistCamY;
    camera.rotation.x = mistCamPitch;
    camera.rotation.y = mistCamYaw;
    camera.rotation.z = mistCamBank;
    // the cloud masses themselves drift around: each size bucket orbits
    // slowly on its own bounded offsets (never cumulative, so the
    // chunk-scroll wrap stays seamless)
    mistGroup.children.forEach((b, i) => {
      b.position.x = Math.sin(nowSec * (0.05 + i * 0.017) + i * 2) * 14;
      b.position.y = Math.sin(nowSec * (0.04 + i * 0.013) + i * 4) * 5;
    });
  } else if (downtownGroup.visible){
    // wide-roaming glide through the big block maze: sweeping left/right/
    // up/down travel plus all three rotations, still clear of the slabs'
    // deepest reach into the corridor
    const nowSec = (t || 0) * 0.001;
    downtownGroup.position.z = (nowSec * DT_SPEED) % DT_CHUNK_LENGTH;
    camera.position.x = Math.sin(nowSec * 0.05) * 24 + Math.sin(nowSec * 0.021 + 3) * 10;
    camera.position.y = Math.sin(nowSec * 0.042 + 1) * 18 + Math.sin(nowSec * 0.017) * 8;
    camera.rotation.x = Math.sin(nowSec * 0.036 + 2) * 0.16;
    camera.rotation.y = Math.sin(nowSec * 0.03) * 0.34;
    camera.rotation.z = Math.sin(nowSec * 0.04 + 4) * 0.2;
    // the reactive slabs breathe with the music (uIntensity is the same
    // smoothed audio level the sphere shader uses), each on its own phase
    const beat = panoUniforms.uIntensity.value;
    dtReactiveSlabs.forEach(slab => {
      slab.material.emissiveIntensity = beat * (0.55 + Math.sin(nowSec * 2.2 + slab.userData.pulsePhase) * 0.45);
    });
  } else {
    // only the scene branches above ever touch these - reset them so a
    // track change away from a 3D scene doesn't leave the sphere/tunnel
    // view stuck mid-turn
    camera.position.x = 0;
    camera.rotation.z = 0;
    camera.position.y = tunnelGroup.visible ? -1.1 : 0;
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
}).catch(() => toast("Could not load the library"));

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
function renderLogoFace(){
  const W = 1200, H = 450;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.font = `900 ${H * 0.85}px Brice, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const cx = W / 2, cy = H / 2 + H * 0.03;
  // black fill with a dark grey outline (stroke drawn first so the fill
  // covers its inner half, leaving just the outer edge visible) - this
  // canvas renders at 1200px wide then displays at ~400px (see .logo3d's
  // width:min(400px,90vw)), a ~3x downscale, so lineWidth 3 here reads as
  // about 1 screen pixel once displayed
  ctx.lineJoin = "round";
  ctx.fillStyle = "#000000"; // black letters
  ctx.fillText("AQAI", cx, cy);
  ctx.strokeStyle = "#ffffff"; // white 1px hairline outline (3px @1200 ≈ 1px on screen)
  ctx.lineWidth = 3;
  ctx.strokeText("AQAI", cx, cy);
  return canvas.toDataURL("image/png");
}
if (logo3dEl){
  (async () => {
    try { await document.fonts.load(`900 ${450 * 0.85}px Brice`); } catch (e) {}
    const faceSrc = renderLogoFace(); // black AQAI with a white 1px hairline
    // plain extruded stack: copies of the same black/white-outline face a few
    // px apart in depth (no reflection)
    for (let i = LOGO3D_DEPTH; i >= 0; i--){
      const layer = document.createElement("div");
      layer.className = "logo3d-layer" + (i === 0 ? " logo3d-front" : "") + (i === LOGO3D_DEPTH ? " logo3d-back" : "");
      layer.style.transform = `translateZ(${-i}px)`;
      const img = document.createElement("img");
      img.src = faceSrc;
      img.alt = "";
      img.style.cssText = "width:100%;height:100%;object-fit:contain;";
      layer.appendChild(img);
      logo3dEl.appendChild(layer);
    }
  })();
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

// intro-screen password gate, for keeping the site out of casual view while
// still finishing it up. This is a soft, client-side gate only (the actual
// audio/API files aren't protected by it) - good enough to stop casual
// visitors, not real access control. Flip GATE_PASSWORD_ENABLED to false
// (and delete this block + the matching HTML/CSS whenever convenient) to
// remove the feature entirely once the site is ready to be fully public.
const GATE_PASSWORD_ENABLED = true;
// two access levels: the restricted password hides editing controls
// (background-video prev/next/remove, delete song, rename title/artist),
// the full password shows everything. Change either string to your own.
const GATE_PASSWORD_RESTRICTED = "aqai2026";
const GATE_PASSWORD_FULL = "aqaimusic";
// hidden entirely in restricted mode; #btn-sphere-control deliberately isn't
// here - it stays visible in both modes (it's a view control, not editing)
const OWNER_ONLY_SELECTORS = [
  "#pano-btns", "#btn-delete", "#btn-edit-title", "#btn-edit-artist", "#lf-edit-btns",
];
// true only when the server confirms this request never crossed the public
// reverse proxy (see "editable" on /api/tracks and _is_public_request() in
// server.py) - the real boundary; the restricted password above is just a
// convenience toggle for viewing the restricted look while running locally.
// Editing controls (rename/delete/lyrics) need BOTH: locally-served AND not
// in restricted mode.
let EDITABLE = false;
let restrictedMode = false;
function updateEditControlsVisibility(){
  const hide = restrictedMode || !EDITABLE;
  OWNER_ONLY_SELECTORS.forEach(sel => {
    const el = document.querySelector(sel);
    if (el) el.style.display = hide ? "none" : "";
  });
  const lfList = $("#lf-list");
  if (lfList) lfList.classList.toggle("editable", !hide);
}
function applyAccessMode(restricted){
  restrictedMode = restricted;
  updateEditControlsVisibility();
}
if (!GATE_PASSWORD_ENABLED){
  $("#gate-password-form").style.display = "none";
  $("#gate-actions-main").style.display = "flex";
} else {
  $("#gate-password-form").addEventListener("submit", e => {
    e.preventDefault();
    const input = $("#gate-password-input");
    const val = input.value;
    if (val === GATE_PASSWORD_RESTRICTED || val === GATE_PASSWORD_FULL){
      applyAccessMode(val === GATE_PASSWORD_RESTRICTED);
      $("#gate-password-form").style.display = "none";
      $("#gate-actions-main").style.display = "flex";
    } else {
      $("#gate-password-error").classList.add("show");
      input.value = "";
      input.focus();
    }
  });
}

$("#gate-btn").onclick = () => {
  $("#gate").classList.add("hidden");
  document.body.classList.remove("gate-active");
  panoUniforms.uGate.value = 0; // restore the sphere's shader effects for the music screen
  tunnelGroup.visible = false; // intro-only tunnel hands off to the sphere (or the Polaroid road)
  tunnelLight.visible = false;
  camera.position.y = 0; // undo the tunnel's lowered viewpoint for the sphere's mouse-look
  camera.position.z = 8; // undo the tunnel's deeper placement too
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

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
// test source: Panoramas2 (mix of .mp4 clips and .gif animations), served
// via /api/panoramas2 + /panorama2/ instead of the original panoramas folder
fetch("/api/panoramas2").then(r => r.json()).then(data => {
  PANORAMAS = data.files || [];
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
let masterVolume = 0.01; // songs start at 1% volume
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
    el.preload = "metadata";
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
function load(i, autoplay = true){
  if (audioEls[cur]) audioEls[cur].pause();
  playing = false;
  cur = (i + TRACKS.length) % TRACKS.length;
  const el = getAudio(cur);
  el.currentTime = 0; el.playbackRate = 1;
  renderMeta(); renderList();
  $("#lyric-rows").innerHTML = "";
  lyricRowEls = {};
  lineIdx = -1;
  ensureLyricsLoaded(cur);
  flBuiltForTrack = -1;
  if (fullLyricsOpen) buildFullLyrics();
  applyTheme(themeIndexForTrack(TRACKS[cur]));
  setBgVideoForTrack(TRACKS[cur]);
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
const LYRIC_LINE_MAX_CHARS = 20;
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
  const overlay = $("#lyrics-full");
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
  // contractions (I'm/I've/I'll/I'd), which are always capitalised.
  const allWords = [];
  tr.lines.forEach(L => (L.words || []).forEach(w => allWords.push(w.w)));
  const sentences = [];
  allWords.forEach((w, i) => {
    const startsNewSentence = i > 0 && /^[A-Z]/.test(w) && !/^I(?:'|$)/.test(w);
    if (startsNewSentence || !sentences.length) sentences.push([]);
    sentences[sentences.length - 1].push(w);
  });
  sentences.forEach(words => {
    const row = document.createElement("div");
    row.className = "lf-row";
    row.innerHTML = words.map(w => `<span class="w">${w}</span>`).join("");
    list.appendChild(row);
    flRowEls.push(row);
  });

  // the card is sized off the widest sentence instead of a fixed
  // percentage, so every line renders in full on one line at its
  // natural size, with 20% of that width added as breathing room on
  // each side - this can make the card wider than the screen itself,
  // which is intentional (see #lyrics-full-backdrop for the full-screen
  // dimming layer behind it)
  let maxWidth = 0;
  flRowEls.forEach(row => { maxWidth = Math.max(maxWidth, row.scrollWidth); });
  const listPaddingX = 46; // #lf-list's own left+right padding (38 left + 8 right) - as tight as the 38px-left/close-button constraints allow
  const scrollbarW = 62.7; // custom scrollbar channel width (see #lf-list::-webkit-scrollbar)
  // width = exactly the longest sentence (+ padding + scrollbar), no extra
  overlay.style.width = (maxWidth + listPaddingX + scrollbarW) + "px";
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
addEventListener("resize", () => { if (fullLyricsOpen) positionLyricsFull(); positionBgGradient(); });
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
  const data = { title: "AQAI — " + tr.title, text: `Listening to "${tr.title}" by ${tr.artist}`, url: location.href.split("#")[0] };
  if (navigator.share){ try { await navigator.share(data); } catch(e){} }
  else if (navigator.clipboard){ await navigator.clipboard.writeText(data.url); toast("Link copied"); }
};
$("#btn-info").onclick = () => showView("info");

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

/* mute */
$("#c-mute").onclick = e => {
  const el = audioEls[cur];
  const muted = el ? !el.muted : false;
  Object.values(audioEls).forEach(a => { a.muted = muted; });
  const btn = e.currentTarget;
  btn.classList.toggle("muted", muted);
  btn.classList.toggle("on", !muted);
  btn.setAttribute("aria-label", muted ? "Unmute" : "Mute");
  btn.innerHTML = muted ? SOUND_OFF_ICON : SOUND_ON_ICON;
};

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
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 900);
camera.position.z = 8.0;

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
// second, round audio visualiser: one continuous closed outline through 60
// points around the photo's oval - each point tracks its own slice of the
// frequency spectrum (a proper circular EQ), moving out from or back down
// to the base radius, connected point-to-point into a single wobbling ring
// (not separate spikes) - updated every frame in animate().
const RING_POINT_COUNT = 60;
const RING_CX = 94.53125, RING_CY = 76.0706; // ellipse centre (viewBox units = css px)
const RING_RX = 93.53125, RING_RY = 75.0706; // base radius: 5px outside the photo's stroke
const RING_BASE_LEN = 2; // resting distance (px) beyond the base radius
const RING_MAX_LEN = 16; // extra distance (px) at full band intensity
const ringPoints = [];
for (let i = 0; i < RING_POINT_COUNT; i++){
  const theta = (i / RING_POINT_COUNT) * Math.PI * 2;
  const cosT = Math.cos(theta), sinT = Math.sin(theta);
  ringPoints.push({
    cosT, sinT,
    baseX: RING_CX + RING_RX * cosT, baseY: RING_CY + RING_RY * sinT,
  });
}
const artistRingPolyEl = $("#artist-ring-poly");
function updateArtistRingVisualiser(){
  if (!artistRingPolyEl) return;
  if (!freqData || !playing){
    artistRingPolyEl.setAttribute("points", ringPoints.map(p => `${p.baseX.toFixed(2)},${p.baseY.toFixed(2)}`).join(" "));
    artistRingPolyEl.setAttribute("stroke", WAVE_COLOR);
    artistRingPolyEl.style.opacity = 0.5;
    return;
  }
  const n = freqData.length;
  // mirrored spectrum: both left and right sides of the ring sweep the SAME
  // bass->treble band sequence outward from the bottom, meeting again at the
  // top - a symmetric "butterfly" look instead of one band sequence
  // spinning all the way around
  const MIRROR_BANDS = RING_POINT_COUNT / 2;
  const bucketSize = n / MIRROR_BANDS;
  let maxBoosted = 0;
  const coords = new Array(RING_POINT_COUNT);
  for (let i = 0; i < RING_POINT_COUNT; i++){
    // relabel so j=0 sits at the bottom point (i=15, a quarter turn from
    // this loop's i=0), then fold left/right onto the same 0..30 band
    // range - both sides sweep bass(bottom)->treble(top) identically
    const j = (i + 45) % RING_POINT_COUNT;
    const band = Math.min(MIRROR_BANDS - 1, Math.min(j, RING_POINT_COUNT - j));
    const start = Math.floor(band * bucketSize), end = Math.max(start + 1, Math.floor((band + 1) * bucketSize));
    let sum = 0;
    for (let k = start; k < end; k++) sum += freqData[k];
    const raw = (sum / (end - start)) / 255;
    const boosted = Math.min(1, Math.pow(raw, 0.6) * 2.2); // punchy per-band easing
    if (boosted > maxBoosted) maxBoosted = boosted;
    const len = RING_BASE_LEN + boosted * RING_MAX_LEN;
    const p = ringPoints[i];
    coords[i] = `${(p.baseX + p.cosT * len).toFixed(2)},${(p.baseY + p.sinT * len).toFixed(2)}`;
  }
  artistRingPolyEl.setAttribute("points", coords.join(" "));
  artistRingPolyEl.setAttribute("stroke", mixWithWhite(WAVE_COLOR, maxBoosted));
  artistRingPolyEl.style.opacity = (0.6 + 0.4 * maxBoosted).toFixed(2);
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
  const desiredBottom = controlsTop - 60;
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
  const canvasCenterY = centerY + 40 - 15 + 5 + 10; // visualiser nudged 5px back down
  const top = canvasCenterY - height / 2;
  canvas.style.top = top + "px";
  canvas.style.height = height + "px";
  metaRow.style.top = (centerY + 40 + 10) + "px"; // +10: song-title device nudged 10px lower
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
      gl_FragColor.rgb *= mix(mix(0.75, 1.0, aqaiScan), 1.0, uGate);
      // vignette baked into the video layer itself: a smooth, continuous
      // blend starting from full brightness at dead center all the way
      // out to the corners (aqaiR2 already holds the squared UV distance
      // from center, 0 at the middle up to ~0.5 at a corner)
      float aqaiVignette = clamp(1.0 - smoothstep(0.0, 0.5, aqaiR2) * 0.984375, 0.0, 1.0);
      gl_FragColor.rgb *= mix(aqaiVignette, 1.0, uGate);
      // overall sphere/background brightness - 30% darker than the
      // original footage, then another 30% darker on top of that (0.7 * 0.7)
      gl_FragColor.rgb *= mix(0.49, 1.0, uGate);`);
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
  scene.add(panoMesh);
  computePanoDistRange(panoMesh);
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

// the intro/gate screen shows this specific clip (17.mp4 from the original
// panoramas folder, served at /panorama/) on the shared panorama sphere until
// the listener taps in, at which point load() picks a per-track background
loadPanoFile("17.mp4", "/panorama/");

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
    const beat = panoUniforms.uIntensity.value; // smoothed audio level 0..1
    // always start from the centre (mouse-in-the-middle) and ease the drift
    // in - identical to the reset that happens when manual control is
    // switched off. No mouse offset here, so its resting point stays centred.
    // music sway: long, slow strokes - a wide travel that changes direction
    // gradually rather than a tight jitter, scaled by the ramp above
    targetYaw = ramp * (Math.sin(time * 0.25) * 0.42 + Math.sin(time * 1.0) * 0.30 * beat);
    targetPitch = ramp * (Math.sin(time * 0.19) * 0.26 + Math.cos(time * 1.2) * 0.22 * beat);
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
  renderMeta(); renderList(); syncButtons();
  ensureLyricsLoaded(cur);
  if (TRACKS.length) applyTheme(themeIndexForTrack(TRACKS[cur]));
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

$("#gate-btn").onclick = () => {
  $("#gate").classList.add("hidden");
  document.body.classList.remove("gate-active");
  panoUniforms.uGate.value = 0; // restore the sphere's shader effects for the music screen
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

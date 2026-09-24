/* Video export "glue" script - export.html loads the REAL player (three.js,
   themes.js, app.js) verbatim, exactly like index.html does, so the 3D
   creature/panorama scene, waveform, karaoke and everything else genuinely
   is the live tool, not a re-implementation. This file's only job is to:
   read which track/aspect to show from the URL, skip the gate straight to
   that track once app.js finishes loading the library, and signal
   playback state back to video_export/__init__.py's headless Playwright
   recording via document.title (which has no other way to know what's on
   screen). All 2D-chrome hiding (nav/controls/edit buttons/fullscreen) and
   per-aspect layout is handled by export.css's body.export-mode /
   body.aspect-* rules - nothing here touches index.html or app.js. */
const params = new URLSearchParams(location.search);
const TRACK_ID = params.get("id");
const VALID_ASPECTS = ["vertical", "horizontal", "square", "portrait"];
const ASPECT = VALID_ASPECTS.includes(params.get("aspect")) ? params.get("aspect") : "vertical";
// true only for the real headless Playwright recording (video_export.py
// appends &record=1 to the URL it navigates to) - false for a plain
// browser-tab preview, where the manual X/Y/scale control panel should
// still show up so it can be dragged. Recorded output should never
// contain that panel, so buildControlPanel() below skips creating it
// (but still applies whatever's already saved) when this is true.
const IS_RECORDING = params.get("record") === "1";
document.body.classList.add("export-mode", `aspect-${ASPECT}`);
// index.html's markup starts every page with <body class="gate-active">
// (see styles.css's body.gate-active rules), which hides .home-top/
// #lyrics/#wave-canvas/.player until app.js's own dismissGate() removes
// it - that only happens once the track library has finished loading, a
// real delay, not an instant one. Removing it here too, before app.js's
// synchronous scene-setup code below ever runs (so every gate-active
// check it makes - camera position/zoom, intro tunnel visibility -
// resolves to the already-dismissed state from the very first frame),
// means an export never shows so much as a blank interstitial while it
// waits: dismissGate() still runs later (inside startExport()) for the
// rest of its work (releasing focus, resetting camera/pano state), this
// class removal is just a no-op by the time it gets there.
document.body.classList.remove("gate-active");

// audio visualiser drawn as one continuous line, not two segments with a
// gap between them - drawWaveCanvas() in app.js clips out a fixed 108px
// gap centered on the canvas (originally so the logo, which used to sit
// there, wasn't drawn over - the logo lives elsewhere in this layout now,
// see export.css's own logo positioning, so that gap is just empty dead
// space here). This is drawWaveCanvas() copied verbatim minus the two
// clip lines - a plain `function` declaration, so reassigning it here
// replaces what every future call (the audio-reactive animation loop)
// resolves to, without touching app.js itself.
function overrideDrawWaveCanvas(){
  if (typeof drawWaveCanvas !== "function") return;
  drawWaveCanvas = function(){
    const canvas = document.querySelector("#wave-canvas");
    if (!canvas) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const dctx = canvas.getContext("2d");
    dctx.clearRect(0, 0, canvas.width, canvas.height);
    dctx.save();
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
  };
}
overrideDrawWaveCanvas();

// background title watermark - Y/scale slider support (see the
// "Background title" block in buildControlPanel() below). 1:1's default
// vertical anchor is dead-centered on the frame; the other 3 aspects keep
// tracking the karaoke lyrics carousel's own live position, same as
// app.js's originals - wmYOffset/wmScale (updated live by the slider) are
// layered on top of either. resetBgTitleWatermark/animateBgTitleWatermark
// are plain `function` declarations (not const/let), so reassigning them
// here - after app.js has defined the originals - replaces what every
// future call (including app.js's own transitionend sweep-restart loop)
// resolves to, without touching app.js itself. Defined here, before
// waitForTracks() below (which may call startExport() -> load() ->
// app.js's own resetBgTitleWatermark() SYNCHRONOUSLY if tracksReady is
// already true by that point), not after it - an override placed after
// that IIFE would miss the very first synchronous call.
let wmYOffset = 0, wmScale = 1;
function frameCenterY(){
  const app = document.querySelector("#app");
  const rect = app ? app.getBoundingClientRect() : null;
  return rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
}
function watermarkTargetY(){
  return watermarkBaselineY() + wmYOffset;
}
resetBgTitleWatermark = function(){
  const el = document.querySelector("#bg-title-watermark");
  if (!el) return;
  el.textContent = "";
  const targetY = watermarkTargetY();
  const elWidth = el.getBoundingClientRect().width;
  const startX = window.innerWidth + elWidth;
  el.style.transition = "none";
  el.style.transform = `translate(calc(${startX}px - 50%), calc(${targetY}px - 100%)) scale(${wmScale})`;
  el.getBoundingClientRect();
  el.style.transition = "";
};
animateBgTitleWatermark = function(){
  const el = document.querySelector("#bg-title-watermark");
  if (!el) return;
  el.textContent = TRACKS[cur].title;
  const targetY = watermarkTargetY();
  const elWidth = el.getBoundingClientRect().width;
  // first sweep of a track starts already on screen (title visible from 0s)
  const firstSweep = watermarkSweepTrack !== cur;
  const startX = firstSweep ? window.innerWidth * 0.05 + elWidth / 2 : window.innerWidth + elWidth;
  const endX = -elWidth;
  watermarkSweepTrack = cur;
  el.style.transition = "none";
  el.style.transform = `translate(calc(${startX}px - 50%), calc(${targetY}px - 100%)) scale(${wmScale})`;
  el.getBoundingClientRect();
  el.style.transition = "";
  el.style.transform = `translate(calc(${endX}px - 50%), calc(${targetY}px - 100%)) scale(${wmScale})`;
};
// slider-driven live update - the sweep is mid-flight most of the time
// (a single crossing takes a while, see #bg-title-watermark's own
// 160s transition in styles.css), so dragging can't wait for the next
// natural reset/animate cycle. Instead this reads whatever X the element
// is currently sitting at (still mid-sweep) straight out of its live
// inline transform and only swaps in the new Y/scale, so a drag updates
// instantly without restarting or otherwise disturbing the sweep.
function applyWatermarkOffset(){
  const el = document.querySelector("#bg-title-watermark");
  if (!el) return;
  const targetY = watermarkTargetY();
  const m = el.style.transform.match(/translate\(([^,]+),/);
  const xPart = m ? m[1] : "0px";
  el.style.transition = "none";
  el.style.transform = `translate(${xPart}, calc(${targetY}px - 100%)) scale(${wmScale})`;
  // force this jump to actually apply with no transition, THEN restore the
  // CSS transition - leaving it permanently disabled (as this used to)
  // silently breaks the sweep for good: the sweep's own restart loop is
  // driven by a "transitionend" listener (app.js) that only fires for an
  // ANIMATED transform change, so once transition:none sticks, the very
  // next natural startX->endX sweep jumps instantly instead of animating,
  // transitionend never fires, and the watermark is left stranded off the
  // left edge - which looks exactly like it "disappeared"
  el.getBoundingClientRect();
  el.style.transition = "";
}

function startExport(){
  const idx = TRACKS.findIndex(tr => tr.id === TRACK_ID);
  if (idx === -1){ document.title = "AQAI_EXPORT_ERROR:track not found"; return; }
  // never show owner-only edit controls on a recording, even when this
  // page is hit locally (where the server would otherwise treat it as
  // the owner, same as visiting index.html locally would)
  EDITABLE = false;
  updateEditControlsVisibility();
  dismissGate();
  load(idx, true);
  window.__exportCurrentTime = () => (audioEls[idx] ? audioEls[idx].currentTime : 0);
  const el = getAudio(idx);
  // muted for preview only - the real recording has no audio of its own
  // regardless (Playwright's screen capture doesn't grab it), the actual
  // track audio is always muxed in afterward from the original file (see
  // video_export/__init__.py), so this can't affect a real export
  el.volume = 0;
  el.addEventListener("playing", () => { document.title = "AQAI_EXPORT_PLAYING"; }, { once: true });
  el.addEventListener("ended", () => { document.title = "AQAI_EXPORT_DONE"; });
  el.addEventListener("error", () => { document.title = "AQAI_EXPORT_ERROR:audio failed"; });
}

// square/portrait/vertical (not 16:9, which already fits fine): song
// title scaled down to fit within 90% of the frame's own width (5%
// margin left/right) if it would otherwise overflow - never scaled up
// past its normal size, only down, and re-measured/re-applied on every
// track change since title length varies per song. Wraps load() (defined
// in app.js, a plain `function` so this reassignment is a normal
// writable binding) and must happen before waitForTracks() below, which
// may call startExport() -> load() synchronously if tracksReady is
// already true by this point in the script.
function fitSongTitleWidth(){
  const app = document.querySelector("#app");
  const title = document.querySelector("#m-title");
  if (!app || !title) return;
  // #m-title's own CSS (styles.css) carries transform:translateY(var(
  // --title-shift)) - essential to its position relative to
  // .meta-sub-row below it. An inline style.transform REPLACES that
  // stylesheet transform outright rather than composing with it, which
  // silently dropped the shift entirely and threw the title/sub-row
  // order off - baseTransform preserves it, with scale composed on top.
  const baseTransform = "translateY(var(--title-shift))";
  title.style.transform = baseTransform;
  title.style.transformOrigin = "center top";
  title.style.display = "inline-block";
  const frameWidth = app.getBoundingClientRect().width;
  const available = frameWidth * 0.9; // 5% margin each side
  const titleWidth = title.getBoundingClientRect().width;
  if (titleWidth > available){
    const factor = available / titleWidth;
    title.style.transform = `${baseTransform} scale(${factor})`;
  }
}
// artist block (photo/creature + audio visualiser + title/artist row)
// repositioned so its relative placement matches the 4:5 (portrait)
// instance's own NATURAL, unmodified layout - measured there once
// (photo top = 17.206% of frame height) and applied as a shared target
// to all 4 aspects (portrait included - its own delta comes out to ~0,
// a no-op), so every export lands the artist block at the same relative
// spot instead of each aspect's own natural (different) position. Only
// the photo's own top is driven directly; .meta-row/#wave-canvas are
// re-derived from the shifted photo's new position using the exact same
// formula positionWaveCanvas() in app.js already uses (proven correct
// there) - delta-shifting them independently instead measured right but
// visually broke the title/sub-row order (some combination of .meta's
// 1.37x scale and the title/sub-row's own pre-existing translateY(var(
// --title-shift)) offsets, styles.css, doesn't compose the way plain
// arithmetic on .meta-row's own top would suggest).
const PHOTO_TOP_PCT = 0.17206; // measured on 4:5, portrait, natural/unshifted
function positionArtistBlockBottom(){
  const app = document.querySelector("#app");
  const photo = document.querySelector(".artist-photo-wrap");
  const metaRow = document.querySelector(".meta-row");
  const waveCanvas = document.querySelector("#wave-canvas");
  const lyrics = document.querySelector("#lyrics");
  if (!app || !photo || !metaRow || !waveCanvas || !lyrics) return;
  const appRect = app.getBoundingClientRect();
  const photoRectBefore = photo.getBoundingClientRect();
  const currentTop = photoRectBefore.top - appRect.top;
  const delta = appRect.height * PHOTO_TOP_PCT - currentTop;
  photo.style.top = (parseFloat(photo.style.top) || 0) + delta + "px";
  // --- from here down: positionWaveCanvas()'s own formula, verbatim,
  // just using the photo's rect AFTER the shift above ---
  const lyricsTop = lyrics.getBoundingClientRect().top;
  const baseHeight = Math.max(40, Math.min(80, lyricsTop * 0.5)) + 40;
  const heightMul = document.body.classList.contains("scene-sphere") ? 8 : 6;
  const height = baseHeight * heightMul;
  const photoRect = photo.getBoundingClientRect();
  const centerY = photoRect.top + photoRect.height / 2;
  const canvasCenterY = centerY + 40 - 15 + 5 + 10 - 22 + 20 - 20 + 10;
  const baselineY = (canvasCenterY - baseHeight / 2) + baseHeight * 0.65;
  const top = baselineY - height * 0.65;
  waveCanvas.style.top = top + "px";
  waveCanvas.style.height = height + "px";
  metaRow.style.top = (centerY + 150) + "px";
  if (typeof positionFoxCanvas === "function") positionFoxCanvas();
}
// per the reference mockups (all 4 aspects): the audio visualiser's own
// resting baseline (the wave's flat center line - see drawWaveCanvas()
// in app.js, baseline sits at 65% of the canvas's own height) passes
// exactly through the vertical CENTER of the song title - not above or
// below it. Song title nudged to match, on all 4 aspects uniformly.
// Measured live (not a hardcoded px) so it stays correct regardless of
// this song's title height or the frame's actual resolution.
function alignTitleWithVisualiser(){
  const canvas = document.querySelector("#wave-canvas");
  const title = document.querySelector("#m-title");
  const titleFill = document.querySelector("#m-title-fill");
  if (!canvas || !title || !titleFill) return;
  const canvasRect = canvas.getBoundingClientRect();
  const baselineY = canvasRect.top + canvasRect.height * 0.65;
  const titleRect = titleFill.getBoundingClientRect();
  const titleCenterY = titleRect.top + titleRect.height / 2;
  const diff = baselineY - titleCenterY; // positive: baseline sits below title
  title.style.transform = (title.style.transform || "") + ` translateY(${diff}px)`;
}
// per the reference mockups: "BY <artist>" sits cleanly below the title
// with a small clear gap, never overlapping it. .meta-sub-row's own
// pre-existing translateY(var(--title-shift) - 10px) (styles.css) is
// tuned for the live player's own (different) title positioning, not
// this aspect's now-recentered title - measured live and nudged down by
// whatever's missing to reach an 8px gap, independent of the title
// itself (which alignTitleWithVisualiser() above already placed).
const TITLE_SUBROW_GAP = 8;
function separateTitleFromSubRow(){
  // #m-title-fill (the actual text span) rather than #m-title itself -
  // #m-title carries a 40px padding/-40px margin pair (styles.css, room
  // for its drop-shadow blur to bleed into without clipping), which
  // would otherwise inflate its measured bottom edge well past where the
  // text visibly ends
  const titleFill = document.querySelector("#m-title-fill");
  const subRow = document.querySelector(".meta-sub-row");
  if (!titleFill || !subRow) return;
  const titleRect = titleFill.getBoundingClientRect();
  const subRect = subRow.getBoundingClientRect();
  const currentGap = subRect.top - titleRect.bottom;
  const needed = TITLE_SUBROW_GAP - currentGap;
  if (needed > 0){
    subRow.style.transform = (subRow.style.transform || "") + ` translateY(${needed}px)`;
  }
}
// #lyrics' centering transform used to live purely in CSS (styles.css's
// own rule for vertical/horizontal, export.css's !important override for
// square/portrait) - moved here as a plain inline baseline so the Karaoke
// text slider below has something non-empty to compose translateY/scale
// onto (setting style.transform with an empty base would otherwise
// silently DROP this positioning outright - the same gotcha
// fitSongTitleWidth() above already works around for #m-title). Must run
// before buildControlPanel() captures el.style.transform as its zero
// point. export.css's own !important rule for square/portrait was
// removed since this inline style now supersedes it.
function applyLyricsBaseTransform(){
  const lyrics = document.querySelector("#lyrics");
  if (!lyrics) return;
  lyrics.style.transform = (ASPECT === "square" || ASPECT === "portrait")
    ? "translateY(calc(-50% + 27px)) scale(1.5)"
    : "translateY(calc(-50% - 80px)) scale(1.5)";
}

// manual X/Y/scale control panel for the key on-screen elements -
// automated measure-and-correct positioning across this many interacting
// transforms/scales kept landing wrong, so this instead lets a human dial
// in each piece's exact position directly in the browser, with live
// sliders, then Save it. The panel lives on <body>, outside the
// letterboxed #app frame, so it's never part of what gets recorded.
const CONTROL_TARGETS = [
  { label: "Circle/creature", selector: ".artist-photo-wrap", usesTop: true },
  { label: "Visualiser", selector: "#wave-canvas", usesTop: true },
  { label: "Song title", selector: "#m-title", usesTop: false },
  { label: "By/artist", selector: ".meta-sub-row", usesTop: false },
  { label: "AQAI logo", selector: ".home-top .logo-text", usesTop: false },
  { label: "3D object", selector: "#fox-3d-canvas", usesTop: false },
  { label: "Karaoke text", selector: "#lyrics", usesTop: false },
];
// per-aspect save slot - "Save values" below writes every slider's
// current reading here, so it survives reloads/new-track loads on this
// browser (each of the 4 export tabs has its own aspect and its own
// saved set, never shared)
const STORAGE_KEY = "aqai_export_ctrl_" + ASPECT;
function loadSavedControls(){
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
  catch (e){ return {}; }
}
// builds one labeled slider row inside `box` for state[key], calling
// onChange() on every drag - shared by every control block below
function buildSliderRow(box, state, key, min, max, step, text, onChange){
  const row = document.createElement("div");
  row.style.cssText = "display:flex;align-items:center;gap:6px;margin-top:2px";
  const rowLabel = document.createElement("span");
  rowLabel.textContent = text;
  rowLabel.style.cssText = "width:36px;flex:none";
  const input = document.createElement("input");
  input.type = "range";
  input.min = min; input.max = max; input.step = step;
  input.value = state[key];
  input.style.cssText = "flex:1;min-width:0";
  const valueLabel = document.createElement("span");
  valueLabel.textContent = key === "scale" ? state[key].toFixed(2) : state[key];
  valueLabel.style.cssText = "width:36px;flex:none;text-align:right";
  input.addEventListener("input", () => {
    state[key] = parseFloat(input.value);
    valueLabel.textContent = key === "scale" ? state[key].toFixed(2) : state[key];
    onChange();
  });
  row.appendChild(rowLabel);
  row.appendChild(input);
  row.appendChild(valueLabel);
  box.appendChild(row);
}
function buildXYScaleRows(box, state, onChange){
  buildSliderRow(box, state, "x", -300, 300, 1, "X", onChange);
  buildSliderRow(box, state, "y", -900, 900, 1, "Y", onChange);
  buildSliderRow(box, state, "scale", 0.2, 3, 0.01, "Scale", onChange);
}
// background-title watermark only (no X - see its own block below, its
// horizontal position IS the sweep animation, a manual X would fight it)
function buildYScaleRows(box, state, onChange){
  buildSliderRow(box, state, "y", -900, 900, 1, "Y", onChange);
  buildSliderRow(box, state, "scale", 0.2, 3, 0.01, "Scale", onChange);
}
// {label, selector, usesTop, state, baseTransform, baseTop} per generic
// target - built once by buildControlPanel(), then read/refreshed every
// load() by resetControlBaselines()/captureAndReapplyControls() below.
// state persists across track changes (the whole point); baseTransform/
// baseTop are recomputed fresh every load, since they capture whatever
// this NEW track's automated positioning (fitSongTitleWidth() etc, or
// just the plain CSS rule for elements nothing else touches) landed on -
// composing the slider's state onto a stale base from a previous track
// would land in the wrong place, or drift further from it on every
// subsequent track change.
const panelEntries = [];
function applyEntry(entry){
  const el = document.querySelector(entry.selector);
  if (!el) return;
  const { usesTop, state, baseTransform, baseTop } = entry;
  if (usesTop) el.style.top = (baseTop + state.y) + "px";
  el.style.transform =
    `${baseTransform} translateX(${state.x}px) ` +
    (usesTop ? "" : `translateY(${state.y}px) `) +
    `scale(${state.scale})`;
  if (el.classList.contains("artist-photo-wrap") && typeof positionFoxCanvas === "function"){
    positionFoxCanvas();
  }
}
// run first, before this load()'s automated positioning functions -
// clears any inline transform/top a PREVIOUS pass's slider left behind,
// for the elements nothing else ever resets (AQAI logo, 3D object,
// Circle/creature's own transform - its top is handled separately below).
// Elements the automated functions themselves fully overwrite each load
// (Song title, By/artist, Karaoke text, and Circle/creature's/
// Visualiser's own top) don't strictly need this, but clearing first is
// harmless for those too. Skipping this step would make
// captureAndReapplyControls() below capture last pass's ALREADY-offset
// style as this pass's "base", compounding the same offset again on top
// of itself every single track change.
function resetControlBaselines(){
  CONTROL_TARGETS.forEach(({ selector, usesTop }) => {
    const el = document.querySelector(selector);
    if (!el) return;
    el.style.transform = "";
    if (usesTop) el.style.top = "";
  });
}
// run last, after this load()'s automated positioning functions - (re)
// captures each entry's natural base (now clean/fresh for this track)
// and reapplies its CURRENT slider state on top of it. Called on every
// load(), not just the first, which is what actually keeps a slider's
// position/save alive across track changes instead of getting silently
// overwritten by the next automated positioning pass.
function captureAndReapplyControls(){
  panelEntries.forEach(entry => {
    const el = document.querySelector(entry.selector);
    if (!el) return;
    const computed = getComputedStyle(el).transform;
    entry.baseTransform = (computed && computed !== "none") ? computed : "";
    entry.baseTop = parseFloat(el.style.top) || 0;
    applyEntry(entry);
  });
  applyWatermarkOffset();
}
function buildControlPanel(){
  if (panelEntries.length || document.getElementById("export-control-panel")) return;
  // IS_RECORDING (video_export.py's real headless Playwright recording,
  // not a plain browser-tab preview): still populate panelEntries so
  // captureAndReapplyControls() applies whatever's already saved, but
  // skip creating the actual visible panel/sliders/button - that UI must
  // never appear in a recorded video.
  const panel = IS_RECORDING ? null : document.createElement("div");
  if (panel){
    panel.id = "export-control-panel";
    panel.style.cssText = `
      position:fixed;top:8px;right:8px;z-index:999999;
      background:rgba(0,0,0,.85);color:#fff;font:11px/1.4 sans-serif;
      padding:10px;border-radius:8px;width:220px;
      max-height:calc(100vh - 16px);overflow:auto;
    `;
  }
  const saved = loadSavedControls();
  CONTROL_TARGETS.forEach(({ label, selector, usesTop }) => {
    const el = document.querySelector(selector);
    if (!el) return;
    const savedState = saved.targets && saved.targets[label];
    const state = savedState
      ? { x: savedState.x || 0, y: savedState.y || 0, scale: savedState.scale ?? 1 }
      : { x: 0, y: 0, scale: 1 };
    const entry = { label, selector, usesTop, state, baseTransform: "", baseTop: 0 };
    panelEntries.push(entry);
    if (!panel) return;
    const box = document.createElement("div");
    box.style.cssText = "margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,.2)";
    const title = document.createElement("div");
    title.textContent = label;
    title.style.cssText = "font-weight:bold;margin-bottom:4px";
    box.appendChild(title);
    buildXYScaleRows(box, state, () => applyEntry(entry));
    panel.appendChild(box);
  });
  // background song-title watermark - not part of CONTROL_TARGETS above
  // since its position/scale aren't a plain el.style.transform: it's
  // driven by resetBgTitleWatermark()/animateBgTitleWatermark()'s own
  // continuous sweep-across-the-screen animation (see the override below),
  // which would otherwise stomp a generic composed transform on its next
  // cycle. wmYOffset/wmScale are read by that override directly instead.
  const wmEl = document.querySelector("#bg-title-watermark");
  if (wmEl){
    if (saved.watermark){
      wmYOffset = saved.watermark.y || 0;
      wmScale = saved.watermark.scale ?? 1;
    }
    if (panel){
      const box = document.createElement("div");
      box.style.cssText = "margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,.2)";
      const title = document.createElement("div");
      title.textContent = "Background title";
      title.style.cssText = "font-weight:bold;margin-bottom:4px";
      box.appendChild(title);
      const state = { y: wmYOffset, scale: wmScale };
      buildYScaleRows(box, state, () => {
        wmYOffset = state.y;
        wmScale = state.scale;
        applyWatermarkOffset();
      });
      panel.appendChild(box);
    }
  }
  if (!panel) return;
  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save values";
  saveBtn.style.cssText = "width:100%;padding:6px;border:none;border-radius:4px;background:#2e8b57;color:#fff;font:11px/1.4 sans-serif;cursor:pointer;margin-top:2px";
  saveBtn.addEventListener("click", () => {
    const data = { targets: {}, watermark: { y: wmYOffset, scale: wmScale } };
    panelEntries.forEach(({ label, state }) => { data.targets[label] = state; });
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e){}
    const orig = saveBtn.textContent;
    saveBtn.textContent = "Saved!";
    setTimeout(() => { saveBtn.textContent = orig; }, 1200);
  });
  panel.appendChild(saveBtn);
  document.body.appendChild(panel);
}

const _origLoad = load;
load = function(i, autoplay){
  _origLoad(i, autoplay);
  // 300ms, not a couple of rAFs - the photo's underlying <img> and other
  // async positioning (e.g. its onload handler re-running
  // positionArtistPhoto()) can still be settling a frame or two in, and
  // re-fire after a too-early correction, silently undoing it
  setTimeout(() => {
    resetControlBaselines();
    if (ASPECT !== "horizontal") fitSongTitleWidth();
    positionArtistBlockBottom();
    alignTitleWithVisualiser();
    separateTitleFromSubRow();
    applyLyricsBaseTransform();
    buildControlPanel();
    // every load(), not just the first - re-derives each control's
    // natural base from this track's own (just-recomputed-above) layout
    // and reasserts its current slider state on top, so a track change
    // (or a page reload, which re-triggers the very first load()) can
    // never silently wipe a manual adjustment back to the automated
    // default the way it used to
    captureAndReapplyControls();
  }, 300);
};

(function waitForTracks(){
  if (typeof tracksReady !== "undefined" && tracksReady) startExport();
  else setTimeout(waitForTracks, 50);
})();

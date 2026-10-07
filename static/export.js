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
// &scene=<name> (one of ENVIRONMENT_SCENES in app.js: road, mist, maze, tiles, beams, prism, rings, check, cube, portal, domino)
// forces that fully-3D environment as the background of the export: no panorama/animation clips from the anims folder.
// (setBgVideoForTrack is a plain function declaration in app.js, so reassigning it here replaces what load() calls.)
const FORCED_SCENE = params.get("scene");
if (FORCED_SCENE){
  setBgVideoForTrack = function(){ sceneChoice = FORCED_SCENE; };
}
document.body.classList.add("export-mode", `aspect-${ASPECT}`);
if (IS_RECORDING) document.body.classList.add("recording");   // (the black logo/text/stroke styling in export.css is for the video renders only)
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
let _wmCapCtx = null;
function watermarkTargetY(){
  // 16:9 and 9:16: the huge title is centred vertically in the frame (the middle of its capital letters on the middle of the frame); the
  // Y slider (default 0) then moves it from there. Everywhere else it sits on the visualiser line as before.
  if (ASPECT === "horizontal" || ASPECT === "vertical"){
    const el = document.querySelector("#bg-title-watermark");
    if (el){
      const cs = getComputedStyle(el);
      const fs = parseFloat(cs.fontSize) || 0;
      if (!_wmCapCtx) _wmCapCtx = document.createElement("canvas").getContext("2d");
      _wmCapCtx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const cap = _wmCapCtx.measureText("H").actualBoundingBoxAscent * wmScale;   // cap height, after the scale (it scales from the baseline)
      // the transform's reference is the bottom of the line box, which sits watermarkBaselineGap() below the baseline (scaled with the title, since it scales from that bottom edge)
      if (fs && isFinite(cap)) return frameCenterY() + cap / 2 + watermarkBaselineGap() * wmScale + wmYOffset;
    }
  }
  return watermarkBaselineY() + wmYOffset;
}
resetBgTitleWatermark = function(){
  const el = document.querySelector("#bg-title-watermark");
  if (!el) return;
  el.textContent = "";
  const targetY = watermarkTargetY();
  const elWidth = el.getBoundingClientRect().width;
  const startX = window.innerWidth + elWidth / 2; // starts completely outside the screen, on the right
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
  // always right to left: every sweep starts completely outside the screen on the right and travels left until it is clear
  const startX = window.innerWidth + elWidth / 2;
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
  el.volume = IS_RECORDING ? 0 : 1;
  if (!IS_RECORDING){
    // a preview opened in a normal browser: the music plays and the visualiser moves. Browsers keep the audio engine
    // suspended (and may block autoplay) until the page gets a click/key press, so kick it on any such gesture too and
    // show a small hint until the sound is really running
    const kick = () => {
      try {
        initAudio();
        if (ctx.state === "suspended") ctx.resume();
        if (el.paused) el.play().then(() => { playing = true; }).catch(() => {});
      } catch (e){}
      if (ctx && ctx.state === "running" && !el.paused && hint){ hint.remove(); hint = null; }
    };
    let hint = null;
    ["pointerdown", "keydown", "click", "touchstart"].forEach(ev => window.addEventListener(ev, kick, { passive: true }));
    kick();
    setTimeout(() => {
      if (ctx && ctx.state === "running" && !el.paused) return;
      hint = document.createElement("div");
      hint.textContent = "Click anywhere to start the music";
      hint.style.cssText = "position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:99999;padding:8px 14px;border-radius:999px;background:rgba(0,0,0,.75);color:#fff;font:12px/1.2 sans-serif;pointer-events:none";
      document.body.appendChild(hint);
    }, 700);
    const retry = setInterval(() => { kick(); if (ctx && ctx.state === "running" && !el.paused) clearInterval(retry); }, 1000);
  }
  // the very first sweep of the huge background title can start before the page is laid out (font not loaded yet / element not
  // rendered), in which case its transition never runs and it jumps straight to its end spot off the left edge and stays there.
  // A song that has only just started can't have finished a 200s sweep, so if the title is already clear of the left edge,
  // start the sweep again (a few tries at most)
  let wmRetries = 0;
  const wmGuard = setInterval(() => {
    const wm = document.querySelector("#bg-title-watermark"), app = document.querySelector("#app");
    if (!wm || !app || !wm.textContent) return;
    const r = wm.getBoundingClientRect(), a = app.getBoundingClientRect();
    if (el.currentTime < 40 && r.width && r.right < a.left && wmRetries < 4){ wmRetries++; animateBgTitleWatermark(); }
    if (el.currentTime >= 40 || wmRetries >= 4) clearInterval(wmGuard);
  }, 600);
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
    : "translateY(calc(-50% - 43px - 10vh)) scale(1.5)";
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
  // this browser's own saved set wins; otherwise the shared per-aspect defaults (export_defaults.js) -
  // which is what the headless recorder (empty localStorage) uses
  try { const s = JSON.parse(localStorage.getItem(STORAGE_KEY)); if (s) return s; }
  catch (e){}
  return (window.EXPORT_DEFAULTS && window.EXPORT_DEFAULTS[ASPECT]) || {};
}
// The sliders' X/Y values are pixel offsets, so they only mean the same thing in a frame of the SAME size they were tuned in
// (the preview window is ~992px high, the headless recording is 640px / 1080px / ... high in CSS pixels). A saved set therefore
// carries the size of the frame it was made in ("frame": {w, h}); when it is loaded into a frame of another size, every X/Y
// offset (and the background title's Y) is multiplied by current-frame-height / saved-frame-height, so the layout scales
// RELATIVE to the frame. Scales (the 0.2-3 factors) are already relative and stay as they are. A set without "frame" is used as is.
function currentFrameSize(){
  const app = document.querySelector("#app");
  return app && app.clientHeight ? { w: app.clientWidth, h: app.clientHeight } : null;
}
function scaleSavedToFrame(saved){
  const cur = currentFrameSize();
  if (!saved || !saved.frame || !saved.frame.h || !cur) return saved;
  const k = cur.h / saved.frame.h;
  if (Math.abs(k - 1) < 0.001) return saved;
  const out = JSON.parse(JSON.stringify(saved));
  Object.values(out.targets || {}).forEach(t => { t.x = Math.round((t.x || 0) * k * 10) / 10; t.y = Math.round((t.y || 0) * k * 10) / 10; });
  if (out.watermark) out.watermark.y = Math.round((out.watermark.y || 0) * k * 10) / 10;
  return out;
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
  const saved = scaleSavedToFrame(loadSavedControls());
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
      wmYOffset = (saved.watermark.y >= 900 ? 0 : saved.watermark.y) || 0; // 900 was the old way of parking the title off-screen: it is shown again
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
    const data = { targets: {}, watermark: { y: wmYOffset, scale: wmScale }, frame: currentFrameSize() };
    panelEntries.forEach(({ label, state }) => { data.targets[label] = state; });
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e){}
    // ...and as the shared defaults for every fresh browser (the headless recorder included) - see export_defaults.js
    fetch("/api/export-defaults", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ aspect: ASPECT, data }) }).catch(() => {});
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

/* 9:16 only: a light shade over the bottom of the frame - in FRONT of the 3D animal, BEHIND the song title and the
   by/artist row (inside .player: the animal is layer 1, the title/by block layer 3, this layer 2). It starts 10px above
   the song title (0%) and fades to ~33% black at the bottom edge (it was 25%; made 33% more solid); its top edge is a circular arc (a wide ellipse centred
   on the bottom edge) rather than a straight line. The title's own position (slider offset included) drives it, so it
   follows the title wherever it sits. */
if (ASPECT === "vertical"){
  (function bottomShade(){
    const app = document.querySelector("#app");
    const player = document.querySelector(".player");
    const title = document.querySelector("#m-title");
    if (!app || !player || !title){ requestAnimationFrame(bottomShade); return; }
    let shade = document.getElementById("export-bottom-shade");
    if (!shade){
      shade = document.createElement("div");
      shade.id = "export-bottom-shade";
      shade.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:2;pointer-events:none;"
        + "background:linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,.3325) 100%);"
        + "clip-path:ellipse(130% 100% at 50% 100%);";
      player.appendChild(shade);
    }
    const a = app.getBoundingClientRect(), t = title.getBoundingClientRect();
    if (t.height){
      const top = Math.max(0, t.top - a.top - 10);
      shade.style.top = top + "px";
    }
    cutBelowVisualiser();
    requestAnimationFrame(bottomShade);
  })();
}

/* 9:16 only: a small radial gradient (black in the middle, fading out) behind the song title and the by/artist row: it starts
   just above the song title and runs down to the bottom of the circle behind the animal. Layer: in FRONT of the 3D animal,
   BEHIND the title/by/artist (inside .player, like the shade above: animal 1, this 2, title block 3). Re-measured every frame so
   it follows the sliders. */
if (ASPECT === "vertical"){
  (function titleGlow(){
    const app = document.querySelector("#app"), player = document.querySelector(".player");
    const title = document.querySelector("#m-title"), circle = document.querySelector(".artist-photo-fill");
    if (!app || !player || !title || !circle){ requestAnimationFrame(titleGlow); return; }
    let g = document.getElementById("export-title-glow");
    if (!g){
      g = document.createElement("div");
      g.id = "export-title-glow";
      g.style.cssText = "position:fixed;z-index:2;pointer-events:none;"
        + "background:radial-gradient(ellipse closest-side, rgba(0,0,0,.6) 0%, rgba(0,0,0,.35) 45%, rgba(0,0,0,0) 100%);";
      player.appendChild(g);
    }
    const a = app.getBoundingClientRect(), t = title.getBoundingClientRect(), c = circle.getBoundingClientRect();
    if (t.height && c.height){
      const top = t.top - 14, bottom = c.bottom;               // just above the song title ... bottom of the circle
      const h = Math.max(40, bottom - top), w = a.width * 0.78;
      g.style.top = (top - a.top) + "px";
      g.style.height = h + "px";
      g.style.width = w + "px";
      g.style.left = ((a.width - w) / 2) + "px";
    }
    requestAnimationFrame(titleGlow);
  })();
}

/* 9:16 only: a subtle call-to-action at the bottom of the frame, over the shade: ONE sentence on one line, "More songs at
   aqaimusic.com", in capitals, condensed Brice, widely letter-spaced, in black on a rounded rectangle in the artist's color
   (like a button) - the address two weights heavier (Black) than the rest (Semi-Bold) - with a little pointing hand beside
   it that taps and lights up (a soft pulsing glow and an expanding ring at the fingertip). Sizes are in em of one font size
   that is a fraction of the frame height, so it looks the same at every export size. It sits ~5.5% up from the bottom edge (15px lower than before, at a 992px frame) so
   phone UI (captions, buttons) that covers the very bottom doesn't hide it. */
const EXPORT_CTA_TEXT = "More songs at ";
const EXPORT_CTA_URL = "aqaimusic.com";
if (ASPECT === "vertical" || ASPECT === "square" || ASPECT === "horizontal"){ // 9:16, 1:1 and 16:9 (not 4:5)
  (function bottomCta(){
    const app = document.querySelector("#app");
    if (!app){ requestAnimationFrame(bottomCta); return; }
    let box = document.getElementById("export-cta");
    if (!box){
      const st = document.createElement("style");
      st.textContent = `
        @keyframes exportCtaHand{0%{transform:translate(4.5em,4em) scale(1);opacity:0}10%{opacity:1}34%{transform:translate(0,0) scale(1);opacity:1}42%{transform:translate(-.1em,-.2em) scale(1.04)}48%{transform:translate(.03em,.08em) scale(.96)}56%{transform:translate(0,0) scale(1);opacity:1}62%{opacity:1}100%{transform:translate(4.5em,4em) scale(1);opacity:0}}
        @keyframes exportCtaGlow{0%,38%{filter:drop-shadow(0 0 .1em rgba(255,255,255,.1))}48%{filter:drop-shadow(0 0 .6em rgba(255,255,255,.95))}66%,100%{filter:drop-shadow(0 0 .1em rgba(255,255,255,.1))}}
        @keyframes exportCtaRing{0%,46%{transform:translate(-50%,-50%) scale(.2);opacity:0}50%{opacity:.85}78%,100%{transform:translate(-50%,-50%) scale(2.6);opacity:0}}
        @keyframes exportCtaLight{0%,78%{background-position:160% 0}100%{background-position:-60% 0}}
        #export-cta-pill::after{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;
          background:linear-gradient(110deg,rgba(255,255,255,0) 38%,rgba(255,255,255,.5) 50%,rgba(255,255,255,0) 62%);background-size:220% 100%;background-repeat:no-repeat;background-position:160% 0;
          animation:exportCtaLight 17s ease-in-out 9s infinite}
        @keyframes exportCtaPill{0%,44%{box-shadow:0 0 0 rgba(255,255,255,0)}50%{box-shadow:0 0 1.1em rgba(255,255,255,.28)}70%,100%{box-shadow:0 0 0 rgba(255,255,255,0)}}`;
      document.head.appendChild(st);
      box = document.createElement("div");
      box.id = "export-cta";
      box.style.cssText = "position:absolute;left:0;right:0;bottom:5.5%;z-index:6;pointer-events:none;text-align:center;white-space:nowrap;"
        + "font-family:'Brice Condensed','Brice',sans-serif;font-weight:600;text-transform:uppercase;line-height:1.15;"
        + "letter-spacing:.26em;";
      const pill = document.createElement("div");
      pill.id = "export-cta-pill";
      pill.style.cssText = "position:relative;display:inline-block;background:color-mix(in srgb, var(--artist-color, #fff) 80%, transparent);border-radius:.75em;padding:.841em 1.25em .559em 1.5em;"
        + "animation:exportCtaPill 3.4s ease-in-out 2s 1 both;";
      const lead = document.createElement("span");
      lead.id = "export-cta-lead";
      lead.textContent = EXPORT_CTA_TEXT;
      lead.style.cssText = "color:#000;opacity:.75;";
      const url = document.createElement("span");
      url.id = "export-cta-url";
      url.textContent = EXPORT_CTA_URL;
      url.style.cssText = "color:#000;font-weight:900;";
      // the pointing hand: sits on the bottom-right corner of the button; the ring is centred on its fingertip
      const hand = document.createElement("span");
      hand.id = "export-cta-hand";
      hand.style.cssText = "position:absolute;right:-.9em;bottom:-1.05em;width:2.1em;height:2.1em;display:block;"
        + "animation:exportCtaHand 3.4s ease-in-out 2s 1 both;opacity:0;";
      hand.innerHTML = `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;overflow:visible;animation:exportCtaGlow 3.4s linear 2s 1 both">`
        + `<path d="M9 3.6a1.55 1.55 0 0 1 3.1 0v6.6l1.1-.35a1.5 1.5 0 0 1 1.9.95l.15.45 1-.3a1.5 1.5 0 0 1 1.8 1.05l.1.4.85-.2a1.5 1.5 0 0 1 1.7 1.3l.2 3.3c.1 2.8-1.7 5.2-4.4 5.9h-3.3c-1.7 0-3.2-.85-4.1-2.2l-3.1-4.6a1.5 1.5 0 0 1 2.4-1.8L9 15.3z" fill="#fff" stroke="#000" stroke-width=".7" stroke-linejoin="round"/></svg>`;
      const ring = document.createElement("span");
      ring.style.cssText = "position:absolute;left:44%;top:16%;width:1.4em;height:1.4em;border-radius:50%;"
        + "border:.12em solid rgba(255,255,255,.9);box-sizing:border-box;transform:translate(-50%,-50%) scale(.2);opacity:0;"
        + "animation:exportCtaRing 3.4s ease-out 2s 1 both;";
      hand.appendChild(ring);
      pill.appendChild(lead); pill.appendChild(url); pill.appendChild(hand);
      // 9:16 only: the intro's animals animation (the start screen's transparent clip) stands along the bottom of the frame,
      // 67.5% of the frame's width (75% of the earlier 90%; the clip is 16:9, so its height follows), behind the "More songs" button
      if (ASPECT === "vertical"){
        const animals = document.createElement("video");
        animals.id = "export-cta-animals";
        animals.src = "/assets/gate-creatures.webm";
        animals.autoplay = true; animals.muted = true; animals.loop = true; animals.playsInline = true;
        animals.setAttribute("aria-hidden", "true");
        animals.style.cssText = "position:absolute;left:16.25%;width:67.5%;height:auto;bottom:75px;z-index:1;pointer-events:none;-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 25px),transparent 100%);mask-image:linear-gradient(to bottom,#000 calc(100% - 25px),transparent 100%);";   // 75px above the bottom edge
        // a circle behind the animals: full black
        const ring = document.createElement("div");
        ring.id = "export-cta-animals-circle";
        ring.style.cssText = "position:absolute;z-index:1;pointer-events:none;border-radius:50%;background:#000000;";   // full black
        app.appendChild(ring);
        app.appendChild(animals);
      }
      box.appendChild(pill);
      app.appendChild(box);
    }
    const h = app.getBoundingClientRect().height;
    {
      const ring = document.getElementById("export-cta-animals-circle"), an = document.getElementById("export-cta-animals");
      if (ring && an){
        const ar = app.getBoundingClientRect(), nr = an.getBoundingClientRect();
        if (nr.height){
          const d = ar.width * 0.54 * 1.5 * 1.5;           // the circle's diameter: 121.5% of the frame width (150% of the earlier 81%)
          const w = d * 1.25;                              // 125% of the earlier width, same height (an ellipse now)
          ring.style.width = w.toFixed(1) + "px"; ring.style.height = d.toFixed(1) + "px";
          ring.style.left = ((ar.width - w) / 2).toFixed(1) + "px";
          ring.style.bottom = (ar.bottom - nr.bottom + nr.height / 2 - d / 2 - 310).toFixed(1) + "px";   // centred on the animation, then 310px lower (60, 150, then 100 more)
        }
      }
    }
    const ctaK = ASPECT === "vertical" ? 0.75 : 1;   // 9:16: the whole button (rectangle, text, logo) is 75% of its earlier size
    box.style.setProperty("--cta-k", ctaK);
    if (h) box.style.fontSize = (h * 0.01425 * ctaK).toFixed(2) + "px";   // 25% smaller than the earlier .019 (the whole button scales: everything is in em)
    // 16:9: the button is a stroke-only pill that is stretched to the left so it HOLDS the AQAI logo: its left padding grows by the
    // logo's width + a 20px gap, and the logo (placed by the individual `translate` property, so it never fights its slider
    // transform) sits inside, at the pill's normal left padding. The pill itself stays centred in the frame.
    if (ASPECT === "horizontal" || ASPECT === "vertical"){
      let logo = document.querySelector(".home-top .logo-text"), pill = document.getElementById("export-cta-pill");
      let own = false;   // 9:16: the logo in the button is a COPY of the logo; the original stays at the top of the frame
      if (ASPECT === "vertical" && logo){
        let copy = document.querySelector(".home-top .logo-text.export-pill-logo");
        if (!copy){
          copy = logo.cloneNode(true);
          copy.classList.add("export-pill-logo");
          copy.removeAttribute("style");
          logo.parentElement.appendChild(copy);
        }
        logo = copy; own = true;
      }
      if (logo && pill){
        const fs = parseFloat(getComputedStyle(box).fontSize) || 0;
        const lcs = getComputedStyle(logo);
        const cv = document.createElement("canvas").getContext("2d");
        cv.font = `${lcs.fontWeight} ${lcs.fontSize} ${lcs.fontFamily}`;
        const m = cv.measureText("AQAI");
        const asc = m.actualBoundingBoxAscent, desc = m.actualBoundingBoxDescent, fa = m.fontBoundingBoxAscent;
        const sc = own ? (pill.getBoundingClientRect().height * 0.50625) / (asc + desc) : 1;   // 9:16: letters 50.6% as high as the button (75% of the earlier 67.5%)
        if (own && isFinite(sc) && Math.abs((logo._sc || 0) - sc) > 0.002){ logo._sc = sc; logo.style.scale = String(sc); }
        const rg = document.createRange(); rg.selectNodeContents(logo);
        const lr = rg.getBoundingClientRect();
        if (lr.width && fs){
          const padL0 = 1.5 * fs, gap = 20 * ctaK;                  // the pill's own left padding (1.5em) and the gap logo -> text
          const wantPad = padL0 + lr.width + gap;
          if (Math.abs((pill._padL || 0) - wantPad) > 0.05){ pill._padL = wantPad; pill.style.paddingLeft = wantPad + "px"; }
          const pr = pill.getBoundingClientRect();
          const prev = logo._shiftX || 0;
          const bw = parseFloat(getComputedStyle(pill).borderLeftWidth) || 0;
          const target = pr.left + bw + padL0;                 // where the logo's left edge should be
          const shift = Math.round((target - (lr.left - prev)) * 10) / 10;
          if (Math.abs(shift - prev) > 0.05){ logo._shiftX = shift; }
          // 9:16: the copy is also placed vertically: the middle of its letters on the middle of the button
          const prevY = logo._shiftY || 0;
          if (own){
            const s = logo._sc || 1;
            const inkC = lr.top + fa * s + (desc - asc) * s / 2;
            const shiftY = Math.round((pr.top + pr.height / 2 - (inkC - prevY)) * 10) / 10;
            if (Math.abs(shiftY - prevY) > 0.05) logo._shiftY = shiftY;
          }
          logo.style.translate = (logo._shiftX || 0) + "px " + (logo._shiftY || 0) + "px";
        }
      }
    }
    requestAnimationFrame(bottomCta);
  })();
}

/* 9:16 only: the circle behind the animal and the 3D animal itself are cut off below the audio visualiser's resting line
   (65% down its own canvas - see drawWaveCanvas() in app.js), wherever the sliders have put things. Each element is
   clipped with an inset() clip-path in its OWN box: its slider transform is just a scale + translate, so the cut line's
   screen y maps linearly onto a fraction of the element's height, whatever the transform is. */
function cutBelowVisualiser(){
  // DISABLED: the whole circle and the whole 3D animal are shown again (nothing is cut below the visualiser line any more)
  ["#fox-3d-canvas", ".artist-photo-wrap"].forEach(sel => { const el = document.querySelector(sel); if (el && el.style.clipPath) el.style.clipPath = ""; });
  return;
  const wave = document.querySelector("#wave-canvas");
  if (!wave) return;
  const w = wave.getBoundingClientRect();
  if (!w.height) return;
  const cutY = w.top + w.height * 0.65;
  const clipBottom = (el, pad) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r.height) return;
    const f = Math.min(1, Math.max(0, (cutY - r.top) / r.height));      // fraction of the element above the cut
    const p = (pad || 0) + "%";
    el.style.clipPath = `inset(-${p} -${p} ${((1 - f) * 100).toFixed(3)}% -${p})`;
  };
  clipBottom(document.querySelector("#fox-3d-canvas"), 0);
  clipBottom(document.querySelector(".artist-photo-wrap"), 400);       // its soft glow reaches well past its own box
}

(function waitForTracks(){
  if (typeof tracksReady !== "undefined" && tracksReady) startExport();
  else setTimeout(waitForTracks, 50);
})();

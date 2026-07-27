/* ================================================================
   AQAI PLAYER — color themes
   ----------------------------------------------------------------
   Each entry is [backgroundHex, 3D-object-hex]. Text/controls default
   to white, and auto-flip to near-black if a background is too light
   for white to stay readable (see luma check in app.js).

   Add as many combos as you like below — the player deterministically
   picks one per track (same track always shows the same theme, hashed
   from its id) and cycles through whichever are listed here. With a
   single entry, every track just uses that one look.
   ================================================================ */
window.AQAI_THEMES = [
  ["#333333", "#AAAAAA"],
];

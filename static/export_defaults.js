/* Default slider values for the video-export pages, per aspect (see export.js: loadSavedControls()).
   A browser's own "Save values" (localStorage) still wins; this is what a fresh browser - notably the
   headless recorder - starts from. "vertical" (9:16) = the values taken from the open export.html?...&aspect=vertical page on 2026-10-06. */
window.EXPORT_DEFAULTS = {
  vertical: {
    targets: {
      "Circle/creature": { x: 0, y: 448, scale: 1.41 },
      "Visualiser": { x: 0, y: 454, scale: 1 },
      "Song title": { x: 0, y: 376, scale: 1 },
      "By/artist": { x: 0, y: 245, scale: 1.13 },
      "AQAI logo": { x: 0, y: -35, scale: 1.51 },
      "3D object": { x: 0, y: -58, scale: 1.4 },
      "Karaoke text": { x: 0, y: -54, scale: 0.82 }
    },
    watermark: { y: 900, scale: 1.14 }
  }
};

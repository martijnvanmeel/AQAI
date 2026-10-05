/* Default slider values for the video-export pages, per aspect (see export.js: loadSavedControls()).
   A browser's own saved set (localStorage) still wins; this is what a fresh browser - notably the headless recorder -
   starts from. Pressing "Save values" on an export page rewrites this file through /api/export-defaults (server.py),
   so these always follow the last values saved there. Keep it as plain JSON inside the assignment. */
window.EXPORT_DEFAULTS = {
  "vertical": {
    "targets": {
      "Circle/creature": {
        "x": 0.0,
        "y": 502.0,
        "scale": 3.0
      },
      "Visualiser": {
        "x": 0.0,
        "y": 454.0,
        "scale": 0.99
      },
      "Song title": {
        "x": 0.0,
        "y": 334.0,
        "scale": 1.0
      },
      "By/artist": {
        "x": 0.0,
        "y": 246.0,
        "scale": 1.04
      },
      "AQAI logo": {
        "x": 0.0,
        "y": -22.0,
        "scale": 1.51
      },
      "3D object": {
        "x": 0.0,
        "y": -288.0,
        "scale": 2.04
      },
      "Karaoke text": {
        "x": 0.0,
        "y": -54.0,
        "scale": 0.74
      }
    },
    "watermark": {
      "y": 900.0,
      "scale": 1.14
    }
  }
};

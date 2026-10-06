/* Default slider values for the video-export pages, per aspect (see export.js: loadSavedControls()).
   A browser's own saved set (localStorage) still wins; this is what a fresh browser - notably the headless recorder -
   starts from. Pressing "Save values" on an export page rewrites this file through /api/export-defaults (server.py),
   so these always follow the last values saved there. Keep it as plain JSON inside the assignment. */
window.EXPORT_DEFAULTS = {
  "vertical": {
    "targets": {
      "Circle/creature": {
        "x": 0.0,
        "y": 456.0,
        "scale": 0.92
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
        "y": -57.0,
        "scale": 1.17
      },
      "Karaoke text": {
        "x": 0.0,
        "y": -9.0,
        "scale": 0.87
      }
    },
    "watermark": {
      "y": 0.0,
      "scale": 1.14
    }
  },
  "square": {
    "targets": {
      "Circle/creature": {
        "x": 0.0,
        "y": 456.0,
        "scale": 0.92
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
        "y": -57.0,
        "scale": 1.17
      },
      "Karaoke text": {
        "x": 0.0,
        "y": -9.0,
        "scale": 0.87
      }
    },
    "watermark": {
      "y": 0.0,
      "scale": 1.14
    }
  }
};

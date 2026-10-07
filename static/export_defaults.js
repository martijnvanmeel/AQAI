/* Default slider values for the video-export pages, per aspect (see export.js: loadSavedControls()).
   A browser's own saved set (localStorage) still wins; this is what a fresh browser - notably the headless recorder -
   starts from. Pressing "Save values" on an export page rewrites this file through /api/export-defaults (server.py),
   so these always follow the last values saved there. Keep it as plain JSON inside the assignment. */
window.EXPORT_DEFAULTS = {
  "vertical": {
    "targets": {
      "Circle/creature": {
        "x": 0.0,
        "y": 328.0,
        "scale": 0.74
      },
      "Visualiser": {
        "x": 0.0,
        "y": 321.0,
        "scale": 0.99
      },
      "Song title": {
        "x": 0.0,
        "y": 241.0,
        "scale": 0.88
      },
      "By/artist": {
        "x": 0.0,
        "y": 147.0,
        "scale": 1.04
      },
      "AQAI logo": {
        "x": 0.0,
        "y": -22.0,
        "scale": 1.51
      },
      "3D object": {
        "x": 0.0,
        "y": 8.0,
        "scale": 0.8
      },
      "Karaoke text": {
        "x": 0.0,
        "y": -24.0,
        "scale": 1.02
      }
    },
    "watermark": {
      "y": -50.0,
      "scale": 1.14
    },
    "frame": {
      "w": 558.0,
      "h": 992.0
    }
  },
  "square": {
    "targets": {
      "Circle/creature": {
        "x": 2.0,
        "y": 512.0,
        "scale": 0.92
      },
      "Visualiser": {
        "x": 0.0,
        "y": 496.0,
        "scale": 0.99
      },
      "Song title": {
        "x": 0.0,
        "y": 340.0,
        "scale": 1.39
      },
      "By/artist": {
        "x": 0.0,
        "y": 291.0,
        "scale": 1.26
      },
      "AQAI logo": {
        "x": 0.0,
        "y": 17.0,
        "scale": 1.85
      },
      "3D object": {
        "x": -1.0,
        "y": -95.0,
        "scale": 1.24
      },
      "Karaoke text": {
        "x": 0.0,
        "y": -125.0,
        "scale": 1.1
      }
    },
    "watermark": {
      "y": 0.0,
      "scale": 1.14
    },
    "frame": {
      "w": 992.0,
      "h": 992.0
    }
  },
  "portrait": {
    "targets": {
      "Circle/creature": {
        "x": 0.0,
        "y": 430.0,
        "scale": 1.0
      },
      "Visualiser": {
        "x": 0.0,
        "y": 446.0,
        "scale": 1.0
      },
      "Song title": {
        "x": 0.0,
        "y": 325.0,
        "scale": 1.0
      },
      "By/artist": {
        "x": 0.0,
        "y": 243.0,
        "scale": 1.0
      },
      "AQAI logo": {
        "x": 0.0,
        "y": 7.0,
        "scale": 1.73
      },
      "3D object": {
        "x": 0.0,
        "y": 0.0,
        "scale": 1.0
      },
      "Karaoke text": {
        "x": 0.0,
        "y": -116.0,
        "scale": 1.0
      }
    },
    "watermark": {
      "y": -251.0,
      "scale": 1.04
    },
    "frame": {
      "w": 794.0,
      "h": 992.0
    }
  },
  "horizontal": {
    "targets": {
      "Circle/creature": {
        "x": 0.0,
        "y": 373.0,
        "scale": 1.01
      },
      "Visualiser": {
        "x": 0.0,
        "y": 289.0,
        "scale": 1.0
      },
      "Song title": {
        "x": 0.0,
        "y": 147.0,
        "scale": 1.22
      },
      "By/artist": {
        "x": 0.0,
        "y": 43.0,
        "scale": 1.22
      },
      "AQAI logo": {
        "x": -170.4,
        "y": 751.1,
        "scale": 0.624
      },
      "3D object": {
        "x": 0.0,
        "y": -89.0,
        "scale": 0.95
      },
      "Karaoke text": {
        "x": 0.0,
        "y": 60.0,
        "scale": 1.66
      }
    },
    "watermark": {
      "y": -47.2,
      "scale": 1.09
    },
    "frame": {
      "w": 1448.0,
      "h": 815.0
    }
  }
};

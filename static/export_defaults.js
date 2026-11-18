/* Default slider values for the video-export pages, per aspect (see export.js: loadSavedControls()).
   A browser's own saved set (localStorage) still wins; this is what a fresh browser - notably the headless recorder -
   starts from. Pressing "Save values" on an export page rewrites this file through /api/export-defaults (server.py),
   so these always follow the last values saved there. Keep it as plain JSON inside the assignment. */
window.EXPORT_DEFAULTS = {
  "vertical": {
    "targets": {
      "Circle/creature": {
        "x": 0.0,
        "y": -83.0,
        "scale": 1.9
      },
      "Visualiser": {
        "x": 0.0,
        "y": 0.0,
        "scale": 0.71
      },
      "Song title": {
        "x": 0.0,
        "y": 197.3,
        "scale": 0.83
      },
      "By/artist": {
        "x": 0.0,
        "y": -73.0,
        "scale": 0.89
      },
      "AQAI logo": {
        "x": -3.1,
        "y": 677.0,
        "scale": 1.08
      },
      "3D object": {
        "x": 2.0,
        "y": -210.5,
        "scale": 1.34
      },
      "Karaoke text": {
        "x": 0.0,
        "y": 100.8,
        "scale": 0.9
      }
    },
    "watermark": {
      "y": -49.2,
      "scale": 1.05
    },
    "frame": {
      "w": 550.0,
      "h": 978.0
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
        "y": 365.2,
        "scale": 1.01
      },
      "Visualiser": {
        "x": 0.0,
        "y": 0.0,
        "scale": 0.73
      },
      "Song title": {
        "x": 0.0,
        "y": 79.1,
        "scale": 1.1
      },
      "By/artist": {
        "x": 0.0,
        "y": -39.0,
        "scale": 0.97
      },
      "AQAI logo": {
        "x": -1.0,
        "y": 672.0,
        "scale": 0.624
      },
      "3D object": {
        "x": 0.0,
        "y": -924.3,
        "scale": 0.95
      },
      "Karaoke text": {
        "x": 0.0,
        "y": -12.0,
        "scale": 1.32
      }
    },
    "watermark": {
      "y": -46.2,
      "scale": 1.09
    },
    "frame": {
      "w": 1418.0,
      "h": 798.0
    }
  }
};

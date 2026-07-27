/* ================================================================
   AQAI SCENE ENGINE
   ----------------------------------------------------------------
   6 point-cloud backgrounds the viewer sits inside of: the original
   icosahedron plus five environments - tunnel, starfield, box,
   triangle, complex building. Each track deterministically picks one
   (hash of track id), so the backdrop changes per track and stays the
   same on replay.

   Points are small soft round dots (sizeAttenuation on, so nearer dots
   render bigger), connected by faint lines (a bit darker than the dots).
   The flythrough scenes (tunnel/triangle/building/starfield) wrap
   around the camera's actual Z position so dots visibly emerge ahead,
   pass by, and continue a little behind the viewer before recycling
   into the distance again. scene.fog (set in app.js) handles the
   natural soft-blur-with-distance falloff for all of them.

   Nothing scales with the music anymore - instead, brightness glows
   in from the sides toward the middle of the screen, pulsing with the
   beat, and each scene rotates slowly across more than one axis.
   ================================================================ */
(function () {
  const SCALE = 60;
  const CAMERA_Z = 8;
  const BEHIND = 6;

  function hashString(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function disposeObj(obj) {
    obj.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
    });
  }

  let dotTexture = null;
  function getDotTexture() {
    if (dotTexture) return dotTexture;
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.55, "rgba(255,255,255,0.7)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    dotTexture = new THREE.CanvasTexture(canvas);
    return dotTexture;
  }

  function ptsMaterial(opts) {
    return new THREE.PointsMaterial(Object.assign({
      color: 0x9AF7B4, size: 0.5, sizeAttenuation: true, vertexColors: true,
      map: getDotTexture(), alphaTest: 0.02,
      transparent: true, opacity: 0.9, depthWrite: false, fog: true,
    }, opts));
  }

  function lineMaterial() {
    return new THREE.LineBasicMaterial({ color: 0x9AF7B4, transparent: true, opacity: 0.55, fog: true });
  }

  function setXYZ(arr, i, x, y, z) { arr[i] = x; arr[i + 1] = y; arr[i + 2] = z; }

  /* wrap a receding-ring z value so the flythrough passes through and
     a little behind the camera before looping back into the distance */
  function wrapZ(rawZ, depth) {
    let z = rawZ % depth;
    if (z > 0) z -= depth;
    return z + CAMERA_Z + BEHIND;
  }

  /* brightness glows in from the sides toward the middle of the screen,
     pulsing with the beat - localX/halfWidth is how far off-center a
     point sits (0 = dead center, 1+ = at or past the edge) */
  function centerGlow(localX, halfWidth, bass, smooth) {
    const edge = Math.min(1, Math.abs(localX) / halfWidth);
    const center = 1 - edge;
    return 0.3 + center * (0.35 + smooth * 0.7 + bass * 0.35);
  }

  function fillColorsCentered(colors, xs, halfWidth, color, bass, smooth) {
    for (let i = 0; i < xs.length; i++) {
      const bright = centerGlow(xs[i], halfWidth, bass, smooth);
      colors[i * 3] = color.r * bright;
      colors[i * 3 + 1] = color.g * bright;
      colors[i * 3 + 2] = color.b * bright;
    }
  }

  /* ---------- cross-section shape helpers (used by tunnel) ---------- */
  function polyCorners(sides, radius) {
    const c = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2 - Math.PI / 2;
      c.push([Math.cos(a) * radius, Math.sin(a) * radius]);
    }
    return c;
  }
  function starCorners(points, outerR, innerR) {
    const c = [];
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? outerR : innerR;
      const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
      c.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    return c;
  }
  function ringFromCorners(corners, perEdge) {
    const pts = [];
    for (let c = 0; c < corners.length; c++) {
      const a = corners[c], b = corners[(c + 1) % corners.length];
      for (let s = 0; s < perEdge; s++) {
        const u = s / perEdge;
        pts.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
      }
    }
    return pts;
  }
  function ringLineIndices(rings, perRing) {
    const idx = [];
    for (let r = 0; r < rings; r++) {
      for (let i = 0; i < perRing; i++) {
        idx.push(r * perRing + i, r * perRing + ((i + 1) % perRing));
      }
    }
    return idx;
  }

  function addLines(group, sharedPositionAttr, indices, color) {
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", sharedPositionAttr);
    lineGeo.setIndex(indices);
    const mat = lineMaterial();
    mat.color.set(color).multiplyScalar(0.78);
    const lines = new THREE.LineSegments(lineGeo, mat);
    group.add(lines);
    return { lines, material: mat };
  }

  /* ================================================================
     SPHERE — the original icosahedron, now a dense point cloud + wireframe
     ================================================================ */
  function buildSphere() {
    const radius = 2.7 * SCALE;
    const geo = new THREE.IcosahedronGeometry(radius, 5);
    const basePos = geo.attributes.position.array.slice();
    const colors = new Float32Array(basePos.length);
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const mat = ptsMaterial({ size: 0.6 });
    const pts = new THREE.Points(geo, mat);
    const group = new THREE.Group();
    group.add(pts);

    const wireGeo = new THREE.WireframeGeometry(geo);
    const wireMat = lineMaterial();
    const wire = new THREE.LineSegments(wireGeo, wireMat);
    group.add(wire);

    return {
      group,
      update(t, bass, mids, smooth, color) {
        for (let i = 0; i < basePos.length; i += 3) {
          const bright = centerGlow(basePos[i], radius, bass, smooth);
          colors[i] = color.r * bright; colors[i + 1] = color.g * bright; colors[i + 2] = color.b * bright;
        }
        geo.attributes.color.needsUpdate = true;
        group.rotation.y += 0.0006 + smooth * 0.012;
        group.rotation.x += 0.0003 + smooth * 0.006;
        group.rotation.z += 0.00018;
        wireMat.color.set(color).multiplyScalar(0.78);
      },
    };
  }

  /* ================================================================
     TUNNEL — dense rings of points, flying through and past the camera.
     Cross-section varies per track: circle, square, hexagon or star.
     ================================================================ */
  function buildTunnel(seed) {
    const RINGS = 44, GAP = 5.2, DEPTH = RINGS * GAP, RADIUS = 100;
    const variant = seed % 4;
    let ringPts;
    if (variant === 0) {
      const PER_RING = 90;
      ringPts = Array.from({ length: PER_RING }, (_, p) => {
        const a = (p / PER_RING) * Math.PI * 2;
        return [Math.cos(a) * RADIUS, Math.sin(a) * RADIUS];
      });
    } else if (variant === 1) {
      ringPts = ringFromCorners(polyCorners(4, RADIUS * 1.15), 20);
    } else if (variant === 2) {
      ringPts = ringFromCorners(polyCorners(6, RADIUS), 14);
    } else {
      ringPts = ringFromCorners(starCorners(5, RADIUS * 1.25, RADIUS * 0.55), 8);
    }
    const perRing = ringPts.length;
    const count = RINGS * perRing;
    const pos = new Float32Array(count * 3);
    const baseXY = new Float32Array(count * 2);
    const baseRing = new Float32Array(count);
    let k = 0;
    for (let r = 0; r < RINGS; r++) {
      for (let i = 0; i < perRing; i++) {
        baseXY[k * 2] = ringPts[i][0]; baseXY[k * 2 + 1] = ringPts[i][1];
        baseRing[k] = r;
        setXYZ(pos, k * 3, ringPts[i][0], ringPts[i][1], -r * GAP);
        k++;
      }
    }
    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(pos, 3);
    geo.setAttribute("position", posAttr);
    const colors = new Float32Array(count * 3);
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const mat = ptsMaterial({ size: 0.5 });
    const pts = new THREE.Points(geo, mat);
    const group = new THREE.Group();
    group.add(pts);
    addLines(group, posAttr, ringLineIndices(RINGS, perRing), 0x9AF7B4);

    return {
      group,
      update(t, bass, mids, smooth, color) {
        const p = geo.attributes.position.array;
        const scroll = t * (2 + smooth * 5);
        for (let i = 0; i < count; i++) {
          p[i * 3 + 2] = wrapZ(-baseRing[i] * GAP + scroll, DEPTH);
          const bright = centerGlow(baseXY[i * 2], RADIUS, bass, smooth);
          colors[i * 3] = color.r * bright; colors[i * 3 + 1] = color.g * bright; colors[i * 3 + 2] = color.b * bright;
        }
        geo.attributes.position.needsUpdate = true;
        geo.attributes.color.needsUpdate = true;
        pts.rotation.z += 0.0012 + smooth * 0.01;
        group.children[1].material.color.set(color).multiplyScalar(0.78);
      },
    };
  }

  /* ================================================================
     STARFIELD — a full volumetric field, flying past and behind
     ================================================================ */
  function buildStarfield() {
    const COUNT = 6000, SPREAD = 90, FAR = -420;
    const pos = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      setXYZ(pos, i * 3,
        (Math.random() * 2 - 1) * SPREAD,
        (Math.random() * 2 - 1) * SPREAD,
        CAMERA_Z + FAR * Math.random());
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const colors = new Float32Array(COUNT * 3);
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const mat = ptsMaterial({ size: 0.42 });
    const pts = new THREE.Points(geo, mat);
    const group = new THREE.Group();
    group.add(pts);

    return {
      group,
      update(t, bass, mids, smooth, color) {
        const p = geo.attributes.position.array;
        const c = geo.attributes.color.array;
        const speed = 0.25 + smooth * 2.2 + bass * 0.8;
        for (let i = 0; i < COUNT; i++) {
          let z = p[i * 3 + 2] + speed;
          if (z > CAMERA_Z + BEHIND) {
            z = CAMERA_Z + FAR;
            p[i * 3] = (Math.random() * 2 - 1) * SPREAD;
            p[i * 3 + 1] = (Math.random() * 2 - 1) * SPREAD;
          }
          p[i * 3 + 2] = z;
          const bright = centerGlow(p[i * 3], SPREAD, bass, smooth);
          c[i * 3] = color.r * bright; c[i * 3 + 1] = color.g * bright; c[i * 3 + 2] = color.b * bright;
        }
        geo.attributes.position.needsUpdate = true;
        geo.attributes.color.needsUpdate = true;
        group.rotation.y += 0.0002 + smooth * 0.002;
        group.rotation.x += 0.00012;
      },
    };
  }

  /* ================================================================
     BOX — a large room, dense grid of points on the inner walls
     ================================================================ */
  function buildBox() {
    const HALF = 140, GRID = 16;
    const pts_ = [];
    const faceIndexOf = {};
    let faceId = 0;
    for (let axis = 0; axis < 3; axis++) {
      for (let side = -1; side <= 1; side += 2) {
        const startIdx = pts_.length;
        for (let a = 0; a < GRID; a++) {
          for (let b = 0; b < GRID; b++) {
            const u = (a / (GRID - 1)) * 2 - 1, v = (b / (GRID - 1)) * 2 - 1;
            const p = [0, 0, 0];
            p[axis] = side * HALF;
            p[(axis + 1) % 3] = u * HALF;
            p[(axis + 2) % 3] = v * HALF;
            pts_.push(p);
          }
        }
        faceIndexOf[faceId++] = startIdx;
      }
    }
    const count = pts_.length;
    const pos = new Float32Array(count * 3);
    pts_.forEach((p, i) => setXYZ(pos, i * 3, p[0], p[1], p[2]));
    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(pos, 3);
    geo.setAttribute("position", posAttr);
    const colors = new Float32Array(count * 3);
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const mat = ptsMaterial({ size: 0.5 });
    const pts = new THREE.Points(geo, mat);
    const group = new THREE.Group();
    group.add(pts);
    group.position.z = CAMERA_Z - HALF * 0.6;

    const gridIdx = [];
    for (let f = 0; f < 6; f++) {
      const base = faceIndexOf[f];
      for (let a = 0; a < GRID; a++) {
        for (let b = 0; b < GRID; b++) {
          const here = base + a * GRID + b;
          if (a + 1 < GRID) gridIdx.push(here, base + (a + 1) * GRID + b);
          if (b + 1 < GRID) gridIdx.push(here, base + a * GRID + (b + 1));
        }
      }
    }
    addLines(group, posAttr, gridIdx, 0x9AF7B4);

    return {
      group,
      update(t, bass, mids, smooth, color) {
        const c = geo.attributes.color.array;
        for (let i = 0; i < count; i++) {
          const bright = centerGlow(pos[i * 3], HALF, bass, smooth);
          c[i * 3] = color.r * bright; c[i * 3 + 1] = color.g * bright; c[i * 3 + 2] = color.b * bright;
        }
        geo.attributes.color.needsUpdate = true;
        group.rotation.y += 0.0006 + smooth * 0.008;
        group.rotation.x += 0.00025 + smooth * 0.003;
        group.rotation.z += 0.00015;
        group.children[1].material.color.set(color).multiplyScalar(0.78);
      },
    };
  }

  /* ================================================================
     TRIANGLE — a dense triangular tunnel, twisting, past the camera
     ================================================================ */
  function buildTriangle() {
    const RINGS = 44, PER_EDGE = 26, GAP = 5.4, SIZE = 100;
    const DEPTH = RINGS * GAP;
    const ringPts = ringFromCorners(polyCorners(3, SIZE), PER_EDGE);
    const perRing = ringPts.length;
    const count = RINGS * perRing;
    const pos = new Float32Array(count * 3);
    const baseRing = new Float32Array(count);
    const baseXY = new Float32Array(count * 2);
    let k = 0;
    for (let r = 0; r < RINGS; r++) {
      const twist = r * 0.1;
      for (let i = 0; i < perRing; i++) {
        const [x, y] = ringPts[i];
        const cos = Math.cos(twist), sin = Math.sin(twist);
        const rx = x * cos - y * sin, ry = x * sin + y * cos;
        baseXY[k * 2] = rx; baseXY[k * 2 + 1] = ry;
        baseRing[k] = r;
        setXYZ(pos, k * 3, rx, ry, -r * GAP);
        k++;
      }
    }
    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(pos, 3);
    geo.setAttribute("position", posAttr);
    const colors = new Float32Array(count * 3);
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const mat = ptsMaterial({ size: 0.5 });
    const pts = new THREE.Points(geo, mat);
    const group = new THREE.Group();
    group.add(pts);
    addLines(group, posAttr, ringLineIndices(RINGS, perRing), 0x9AF7B4);

    return {
      group,
      update(t, bass, mids, smooth, color) {
        const p = geo.attributes.position.array;
        const c = geo.attributes.color.array;
        const scroll = t * (1.8 + smooth * 4.4);
        for (let i = 0; i < count; i++) {
          p[i * 3 + 2] = wrapZ(-baseRing[i] * GAP + scroll, DEPTH);
          const bright = centerGlow(baseXY[i * 2], SIZE, bass, smooth);
          c[i * 3] = color.r * bright; c[i * 3 + 1] = color.g * bright; c[i * 3 + 2] = color.b * bright;
        }
        geo.attributes.position.needsUpdate = true;
        geo.attributes.color.needsUpdate = true;
        pts.rotation.z += 0.0008 + smooth * 0.006;
        group.children[1].material.color.set(color).multiplyScalar(0.78);
      },
    };
  }

  /* ================================================================
     COMPLEX BUILDING — nested rectangular frames, scaffolding flythrough
     ================================================================ */
  function buildBuilding() {
    const FRAMES = 26, PER_EDGE = 20, GAP = 5.8, DEPTH = FRAMES * GAP;
    const pointsPerFrame = PER_EDGE * 4;
    const rng = (function seeded(seed) {
      let s = seed;
      return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    })(42);

    const frameDefs = [];
    for (let f = 0; f < FRAMES; f++) {
      frameDefs.push({
        w: 60 + rng() * 100,
        h: 45 + rng() * 90,
        rot: (rng() - 0.5) * 0.6,
        ox: (rng() - 0.5) * 50,
        oy: (rng() - 0.5) * 40,
      });
    }
    const edgePts = [];
    frameDefs.forEach((f, fi) => {
      const corners = [
        [-f.w / 2, -f.h / 2], [f.w / 2, -f.h / 2], [f.w / 2, f.h / 2], [-f.w / 2, f.h / 2],
      ];
      for (let c = 0; c < 4; c++) {
        const a = corners[c], b = corners[(c + 1) % 4];
        for (let s = 0; s < PER_EDGE; s++) {
          const u = s / PER_EDGE;
          let x = a[0] + (b[0] - a[0]) * u, y = a[1] + (b[1] - a[1]) * u;
          const cos = Math.cos(f.rot), sin = Math.sin(f.rot);
          const rx = x * cos - y * sin, ry = x * sin + y * cos;
          edgePts.push([rx + f.ox, ry + f.oy, fi]);
        }
      }
    });
    const count = edgePts.length;
    const pos = new Float32Array(count * 3);
    const baseXY = new Float32Array(count * 2);
    const baseFrame = new Float32Array(count);
    edgePts.forEach((p, i) => {
      baseXY[i * 2] = p[0]; baseXY[i * 2 + 1] = p[1]; baseFrame[i] = p[2];
      setXYZ(pos, i * 3, p[0], p[1], -p[2] * GAP);
    });
    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(pos, 3);
    geo.setAttribute("position", posAttr);
    const colors = new Float32Array(count * 3);
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const mat = ptsMaterial({ size: 0.5 });
    const pts = new THREE.Points(geo, mat);
    const group = new THREE.Group();
    group.add(pts);
    addLines(group, posAttr, ringLineIndices(FRAMES, pointsPerFrame), 0x9AF7B4);

    return {
      group,
      update(t, bass, mids, smooth, color) {
        const p = geo.attributes.position.array;
        const c = geo.attributes.color.array;
        const scroll = t * (1.6 + smooth * 3.6);
        for (let i = 0; i < count; i++) {
          p[i * 3 + 2] = wrapZ(-baseFrame[i] * GAP + scroll, DEPTH);
          const bright = centerGlow(baseXY[i * 2], 130, bass, smooth);
          c[i * 3] = color.r * bright; c[i * 3 + 1] = color.g * bright; c[i * 3 + 2] = color.b * bright;
        }
        geo.attributes.position.needsUpdate = true;
        geo.attributes.color.needsUpdate = true;
        pts.rotation.z += 0.0003 + smooth * 0.004;
        group.children[1].material.color.set(color).multiplyScalar(0.78);
      },
    };
  }

  const BUILDERS = {
    sphere: buildSphere,
    tunnel: buildTunnel,
    starfield: buildStarfield,
    box: buildBox,
    triangle: buildTriangle,
    building: buildBuilding,
  };
  const NAMES = Object.keys(BUILDERS);

  let hostScene = null;
  let current = null;
  let smallScreenY = 0;

  window.AQAIScenes = {
    names: NAMES,

    init(scene) {
      hostScene = scene;
    },

    sceneNameForTrack(track) {
      return NAMES[hashString(track.id || track.title || "") % NAMES.length];
    },

    selectForTrack(track) {
      if (!hostScene) return;
      const name = this.sceneNameForTrack(track);
      if (current && current._name === name) return;
      if (current) { hostScene.remove(current.group); disposeObj(current.group); }
      const seed = hashString((track.id || track.title || "") + "#variant");
      current = BUILDERS[name](seed);
      current._name = name;
      current.group.position.y += smallScreenY;
      hostScene.add(current.group);
    },

    setSmallScreenOffset(y) {
      const delta = y - smallScreenY;
      smallScreenY = y;
      if (current) current.group.position.y += delta;
    },

    update(t, bass, mids, smooth, color) {
      if (current) current.update(t, bass, mids, smooth, color);
    },
  };
})();

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { createNoise2D } from 'simplex-noise';

// ── Params ───────────────────────────────────────────────────────────────────
const params = {
  segments:        80,
  noiseScale:      2.5,
  amplitude:       5.0,
  octaves:         5,
  persistence:     0.5,
  lacunarity:      2.0,
  terraceCount:    7,
  islandSize:      0.72,  // 0=tiny speck, 1=fills the whole plane
  islandRoughness: 0.55,  // 0=perfect circle, 1=very jagged coast
  bevelAmount:     2,     // number of bevel cuts/segments (0=sharp)
  bevelScale:      0.30,  // fraction of terrace height used for bevel depth
  subdivideAmount: 3,     // mesh subdivisions per source heightmap cell
  cliffRandomness: 0.18,  // terrace-boundary jitter in terrace-height units
  shadeSmooth:     false,
  seed:            Math.floor(Math.random() * 99999),
  wireframe:       true,
};

// ── Three.js setup ───────────────────────────────────────────────────────────
const viewport = document.getElementById('viewport');
const scene    = new THREE.Scene();
scene.background = new THREE.Color(0x0f1923);
scene.fog = new THREE.FogExp2(0x0f1923, 0.018);

const camera = new THREE.PerspectiveCamera(55, viewport.clientWidth / viewport.clientHeight, 0.01, 500);
camera.position.set(0, 9, 14);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(viewport.clientWidth, viewport.clientHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewport.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.target.set(0, 1.5, 0);
controls.minDistance = 2;
controls.maxDistance = 60;

// Lights
const ambient = new THREE.AmbientLight(0x3a5070, 0.8);
scene.add(ambient);

const sun = new THREE.DirectionalLight(0xfff0d0, 1.4);
sun.position.set(8, 16, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 0.1;
sun.shadow.camera.far = 60;
sun.shadow.camera.left = sun.shadow.camera.bottom = -12;
sun.shadow.camera.right = sun.shadow.camera.top = 12;
scene.add(sun);

const fill = new THREE.DirectionalLight(0x4060a0, 0.4);
fill.position.set(-6, 4, -8);
scene.add(fill);

// Grid
const grid = new THREE.GridHelper(22, 44, 0x1a3050, 0x162840);
grid.position.y = -0.01;
scene.add(grid);

// ── Terrain state ─────────────────────────────────────────────────────────
let terrainGroup = new THREE.Group();
scene.add(terrainGroup);

// Water plane — sits at y=0, always visible beneath the island
const waterGeo = new THREE.PlaneGeometry(11, 11);
waterGeo.rotateX(-Math.PI / 2);
const waterMat = new THREE.MeshStandardMaterial({
  color: 0x0d3d6b,
  roughness: 0.1,
  metalness: 0.2,
  transparent: true,
  opacity: 0.82,
});
const waterMesh = new THREE.Mesh(waterGeo, waterMat);
waterMesh.position.y = 0.02;
waterMesh.receiveShadow = true;
scene.add(waterMesh);

// ── Colour palette (per terrace level, index 0 = lowest) ─────────────────
const PALETTE = [
  [0.06, 0.28, 0.52], // deep water blue
  [0.14, 0.45, 0.26], // dark grass
  [0.22, 0.58, 0.22], // green
  [0.38, 0.58, 0.24], // light green
  [0.50, 0.44, 0.22], // dry/earth
  [0.52, 0.40, 0.30], // brown rock
  [0.62, 0.55, 0.48], // light rock
  [0.75, 0.70, 0.68], // grey stone
  [0.90, 0.90, 0.92], // snow
];

function terraceColor(level) {
  const i = Math.max(0, Math.min(level, PALETTE.length - 1));
  return PALETTE[i];
}

// ── Noise ─────────────────────────────────────────────────────────────────
let noise2D, maskNoise2D;

function initNoise(seed) {
  function mulberry32(s) {
    return function () {
      s |= 0; s = s + 0x6D2B79F5 | 0;
      let t = Math.imul(s ^ s >>> 15, 1 | s);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  noise2D     = createNoise2D(mulberry32(seed));
  maskNoise2D = createNoise2D(mulberry32(seed + 99999)); // independent stream for island shape
}

function fbm(nx, nz) {
  let v = 0, amp = 1, freq = 1, max = 0;
  for (let i = 0; i < params.octaves; i++) {
    v   += noise2D(nx * freq, nz * freq) * amp;
    max += amp;
    amp  *= params.persistence;
    freq *= params.lacunarity;
  }
  return v / max; // -1..1
}

// Island mask: radial falloff distorted by low-frequency noise so the
// coastline is organic rather than a perfect circle or square.
function islandMask(nx, nz) {
  // Warp the distance field with noise so the coast is irregular
  const warpX = maskNoise2D(nx * 1.2 + 5.3, nz * 1.2 - 2.1);
  const warpZ = maskNoise2D(nx * 1.2 - 3.7, nz * 1.2 + 8.4);
  const warp  = params.islandRoughness;
  const wx = nx + warpX * warp;
  const wz = nz + warpZ * warp;

  // Elliptical distance in warped space (slight random squash per seed)
  const dist = Math.sqrt(wx * wx + wz * wz);

  // Map islandSize: 0→coastline at 0, 1→coastline at edge of plane
  const radius = params.islandSize * 0.9 + 0.05;
  const t = 1.0 - dist / radius;

  // Smoothstep so the coast blends to 0 gracefully
  const clamped = Math.max(0, Math.min(1, t));
  return clamped * clamped * (3 - 2 * clamped);
}

// ── Heightmap ─────────────────────────────────────────────────────────────
function generateHeightmap() {
  const s = params.segments;
  const data = new Float32Array((s + 1) * (s + 1));
  for (let z = 0; z <= s; z++) {
    for (let x = 0; x <= s; x++) {
      // Normalised coords: -1..1 in both axes
      const ux = (x / s - 0.5) * 2;
      const uz = (z / s - 0.5) * 2;

      const nx = ux * params.noiseScale * 0.5;
      const nz = uz * params.noiseScale * 0.5;

      const n    = (fbm(nx, nz) + 1) / 2; // 0..1
      const mask = islandMask(ux, uz);

      data[z * (s + 1) + x] = n * mask * params.amplitude;
    }
  }
  return data;
}

// ── Build flat XZ mesh (Y = height) ──────────────────────────────────────
function buildBaseMesh(heights) {
  const s = params.segments;
  const size = 10; // world units
  const verts = new Float32Array((s + 1) * (s + 1) * 3);
  const tris  = [];

  for (let z = 0; z <= s; z++) {
    for (let x = 0; x <= s; x++) {
      const idx = (z * (s + 1) + x) * 3;
      verts[idx]     = (x / s - 0.5) * size;
      verts[idx + 1] = heights[z * (s + 1) + x];
      verts[idx + 2] = (z / s - 0.5) * size;
    }
  }

  for (let z = 0; z < s; z++) {
    for (let x = 0; x < s; x++) {
      const a = z * (s + 1) + x;
      const b = a + 1;
      const c = (z + 1) * (s + 1) + x;
      const d = c + 1;
      tris.push(a, c, b, b, c, d);
    }
  }

  return { verts, tris };
}

// ── Terracing algorithm ───────────────────────────────────────────────────
// Ported from https://icospheric.com/blog/2016/07/17/making-terraced-terrain/
// Modified for a flat XZ plane (Y is up) and parameterised terrace spacing.
function sampleHeight(heights, x, z) {
  const s = params.segments;
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const x1 = Math.min(s, x0 + 1);
  const z1 = Math.min(s, z0 + 1);
  const tx = x - x0;
  const tz = z - z0;

  const h00 = heights[z0 * (s + 1) + x0];
  const h10 = heights[z0 * (s + 1) + x1];
  const h01 = heights[z1 * (s + 1) + x0];
  const h11 = heights[z1 * (s + 1) + x1];
  const hx0 = h00 + (h10 - h00) * tx;
  const hx1 = h01 + (h11 - h01) * tx;
  return hx0 + (hx1 - hx0) * tz;
}

function roundedTerraceHeight(height) {
  const terraceStep = params.amplitude / params.terraceCount;
  const bevelScale = Math.max(0, Math.min(0.95, params.bevelScale));
  const unit = height / terraceStep;
  const level = Math.floor(unit);

  if (params.bevelAmount <= 0 || bevelScale <= 0.001) {
    return level * terraceStep;
  }

  const frac = unit - level;
  const flatSpan = 1 - bevelScale;
  if (frac <= flatSpan) {
    return level * terraceStep;
  }

  const t = (frac - flatSpan) / bevelScale;
  const rounded = t * t * (3 - 2 * t);
  return (level + rounded) * terraceStep;
}

function cliffEdgeNoise(nx, nz) {
  return (
    maskNoise2D(nx * 7.0 + 31.7, nz * 7.0 - 18.9) * 0.60 +
    maskNoise2D(nx * 15.0 - 11.4, nz * 15.0 + 42.2) * 0.30 +
    maskNoise2D(nx * 31.0 + 8.1, nz * 31.0 - 5.6) * 0.10
  );
}

function buildBeveledHeightfieldGeometry(heights) {
  const s = params.segments;
  const cuts = Math.max(0, Math.round(params.bevelAmount));
  const maxEffectiveSegments = 960;
  const requestedSubdivisions = Math.max(1, Math.round(params.subdivideAmount)) * Math.max(1, cuts + 1);
  const subdivisions = Math.max(1, Math.min(requestedSubdivisions, Math.floor(maxEffectiveSegments / s)));
  const n = s * subdivisions;
  const size = 10;
  const positions = [];
  const colors = [];
  const indices = [];
  const terraceStep = params.amplitude / params.terraceCount;
  const randomness = Math.max(0, params.cliffRandomness);

  for (let z = 0; z <= n; z++) {
    for (let x = 0; x <= n; x++) {
      const sourceX = x / subdivisions;
      const sourceZ = z / subdivisions;
      const rawHeight = sampleHeight(heights, sourceX, sourceZ);
      const nx = (sourceX / s - 0.5) * 2;
      const nz = (sourceZ / s - 0.5) * 2;
      const jitteredHeight = Math.max(0, rawHeight + cliffEdgeNoise(nx, nz) * randomness * terraceStep);
      const y = roundedTerraceHeight(jitteredHeight);
      const level = Math.max(0, Math.round(y / terraceStep));
      const c = terraceColor(level);

      positions.push((x / n - 0.5) * size, y, (z / n - 0.5) * size);
      colors.push(c[0], c[1], c[2]);
    }
  }

  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const a = z * (n + 1) + x;
      const b = a + 1;
      const c = (z + 1) * (n + 1) + x;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.userData.subdivisions = subdivisions;
  return geo;
}

function terraceGeometry(verts, tris) {
  const ts = params.amplitude / params.terraceCount; // spacing between terrace levels
  const positions = [];
  const colors    = [];

  function pushVert(x, y, z, level) {
    positions.push(x, y, z);
    const c = terraceColor(level);
    colors.push(c[0], c[1], c[2]);
  }

  function pushTri(ax,ay,az, bx,by,bz, cx,cy,cz, lv) {
    pushVert(ax,ay,az,lv);
    pushVert(bx,by,bz,lv);
    pushVert(cx,cy,cz,lv);
  }

  function pushQuad(ax,ay,az, bx,by,bz, cx,cy,cz, dx,dy,dz, lv) {
    pushTri(ax,ay,az, bx,by,bz, cx,cy,cz, lv);
    pushTri(ax,ay,az, cx,cy,cz, dx,dy,dz, lv);
  }

  for (let i = 0; i < tris.length; i += 3) {
    const i1 = tris[i]     * 3;
    const i2 = tris[i + 1] * 3;
    const i3 = tris[i + 2] * 3;

    // Original vertex positions
    let x1=verts[i1], y1=verts[i1+1], z1=verts[i1+2];
    let x2=verts[i2], y2=verts[i2+1], z2=verts[i2+2];
    let x3=verts[i3], y3=verts[i3+1], z3=verts[i3+2];

    // Heights in terrace units
    let h1=y1/ts, h2=y2/ts, h3=y3/ts;

    const hMin = Math.floor(Math.min(h1, h2, h3));
    const hMax = Math.floor(Math.max(h1, h2, h3));

    for (let h = hMin; h <= hMax; h++) {
      // Rearrange so the "lone" vertex is always c (index 3):
      //   pa=1 → c is alone ABOVE h
      //   pa=2 → c is alone BELOW h
      let ax=x1,ay=y1,az=z1,ah=h1;
      let bx=x2,by=y2,bz=z2,bh=h2;
      let cx=x3,cy=y3,cz=z3,ch=h3;
      let pa = 0;

      if (ah < h) {
        if (bh < h) {
          if (ch >= h) { pa = 1; /* c alone above – already correct */ }
          // else all below → skip (pa stays 0)
        } else if (ch < h) {
          // b alone above → rotate so b becomes c
          pa = 1;
          [ax,ay,az,ah, bx,by,bz,bh, cx,cy,cz,ch] =
            [cx,cy,cz,ch, ax,ay,az,ah, bx,by,bz,bh];
        } else {
          // a alone below → rotate so a becomes c
          pa = 2;
          [ax,ay,az,ah, bx,by,bz,bh, cx,cy,cz,ch] =
            [bx,by,bz,bh, cx,cy,cz,ch, ax,ay,az,ah];
        }
      } else if (bh < h) {
        if (ch < h) {
          // a alone above → rotate so a becomes c
          pa = 1;
          [ax,ay,az,ah, bx,by,bz,bh, cx,cy,cz,ch] =
            [bx,by,bz,bh, cx,cy,cz,ch, ax,ay,az,ah];
        } else {
          // b alone below → rotate so b becomes c
          pa = 2;
          [ax,ay,az,ah, bx,by,bz,bh, cx,cy,cz,ch] =
            [cx,cy,cz,ch, ax,ay,az,ah, bx,by,bz,bh];
        }
      } else if (ch < h) {
        pa = 2; // c already alone below – correct
      } else {
        pa = 3;
      }

      if (pa === 0) continue;

      const ceilY  = h * ts;       // flat top of this terrace
      const floorY = (h - 1) * ts; // bottom of wall down to next terrace

      if (pa === 3) {
        // Whole triangle above this level – flat roof
        pushTri(ax,ceilY,az, bx,ceilY,bz, cx,ceilY,cz, h);
        continue;
      }

      // Interpolation factors for where plane h crosses edges a→c and b→c
      const t1 = (ah === ch) ? 0 : (ah - h) / (ah - ch);
      const t2 = (bh === ch) ? 0 : (bh - h) / (bh - ch);

      // Edge intersection points (XZ lerped, Y = ceilY / floorY)
      const e1x = ax + (cx - ax) * t1,  e1z = az + (cz - az) * t1;
      const e2x = bx + (cx - bx) * t2,  e2z = bz + (cz - bz) * t2;

      // ── Bevel ──────────────────────────────────────────────────────────
      // Compute inward perpendicular from the edge midpoint toward the roof
      // interior. This lets us inset the roof edge and create an angled strip.
      const bevelCuts = Math.max(0, Math.round(params.bevelAmount));
      const bevelH = Math.min(params.bevelScale * ts, ts * 0.95);
      const bevelW = bevelH;
      const hasBevel = bevelCuts > 0 && bevelH > 0.001 && bevelW > 0.001;

      let e1ix = e1x, e1iz = e1z; // inset edge points (default = no inset)
      let e2ix = e2x, e2iz = e2z;
      let wallTopY = ceilY; // top of vertical wall (drops when bevel is active)

      if (hasBevel) {
        // Centre of the roof region for this case
        const roofCX = pa === 1 ? cx          : (ax + bx) / 2;
        const roofCZ = pa === 1 ? cz          : (az + bz) / 2;
        const midX   = (e1x + e2x) / 2;
        const midZ   = (e1z + e2z) / 2;

        // Unit vector pointing from edge midpoint into the roof
        let pX = roofCX - midX, pZ = roofCZ - midZ;
        const pLen = Math.sqrt(pX * pX + pZ * pZ);
        if (pLen > 0.001) { pX /= pLen; pZ /= pLen; }

        e1ix = e1x + pX * bevelW;  e1iz = e1z + pZ * bevelW;
        e2ix = e2x + pX * bevelW;  e2iz = e2z + pZ * bevelW;
        wallTopY = ceilY - bevelH;

        // Angled bevel strip: from inset roof edge → original edge at wallTopY
        for (let i = 0; i < bevelCuts; i++) {
          const t0 = i / bevelCuts;
          const t1 = (i + 1) / bevelCuts;
          const a0x = e2ix + (e2x - e2ix) * t0;
          const a0y = ceilY + (wallTopY - ceilY) * t0;
          const a0z = e2iz + (e2z - e2iz) * t0;
          const b0x = e1ix + (e1x - e1ix) * t0;
          const b0y = ceilY + (wallTopY - ceilY) * t0;
          const b0z = e1iz + (e1z - e1iz) * t0;
          const a1x = e2ix + (e2x - e2ix) * t1;
          const a1y = ceilY + (wallTopY - ceilY) * t1;
          const a1z = e2iz + (e2z - e2iz) * t1;
          const b1x = e1ix + (e1x - e1ix) * t1;
          const b1y = ceilY + (wallTopY - ceilY) * t1;
          const b1z = e1iz + (e1z - e1iz) * t1;
          pushQuad(a0x,a0y,a0z, a1x,a1y,a1z, b1x,b1y,b1z, b0x,b0y,b0z, h);
        }
      }
      // ───────────────────────────────────────────────────────────────────

      if (pa === 1) {
        // c alone above: roof triangle (inset if bevelled) + wall
        pushTri(cx,ceilY,cz, e1ix,ceilY,e1iz, e2ix,ceilY,e2iz, h);
        pushQuad(e2x,wallTopY,e2z, e1x,wallTopY,e1z, e1x,floorY,e1z, e2x,floorY,e2z, h);
      } else {
        // pa === 2: a,b above, c below: roof quad (inset if bevelled) + wall
        pushQuad(ax,ceilY,az, bx,ceilY,bz, e2ix,ceilY,e2iz, e1ix,ceilY,e1iz, h);
        pushQuad(e1x,wallTopY,e1z, e2x,wallTopY,e2z, e2x,floorY,e2z, e1x,floorY,e1z, h);
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    colors:    new Float32Array(colors),
  };
}

// ── Build Three.js geometry from terrace output ───────────────────────────
// Build a single indexed terraced mesh from grid cells. Each visible surface
// shares vertices with its neighbours, and only real height boundaries get
// walls, so exported meshes can be bevelled cleanly in DCC tools.
function buildConnectedTerraceGeometry(heights) {
  const s = params.segments;
  const size = 10;
  const half = size / 2;
  const cell = size / s;
  const terraceStep = params.amplitude / params.terraceCount;
  const bevelCuts = Math.max(0, Math.round(params.bevelAmount));
  const bevelH = Math.min(params.bevelScale * terraceStep, terraceStep * 0.95);
  const bevelW = Math.min(bevelH, cell * 0.45);
  const hasBevel = bevelCuts > 0 && bevelH > 0.001 && bevelW > 0.001;

  const levels = new Int16Array(s * s);
  const positions = [];
  const colors = [];
  const indices = [];
  const vertexCache = new Map();

  function heightAt(x, z) {
    return heights[z * (s + 1) + x];
  }

  for (let z = 0; z < s; z++) {
    for (let x = 0; x < s; x++) {
      const h =
        (heightAt(x, z) +
         heightAt(x + 1, z) +
         heightAt(x, z + 1) +
         heightAt(x + 1, z + 1)) * 0.25;
      levels[z * s + x] = Math.max(0, Math.round(h / terraceStep));
    }
  }

  function getLevel(x, z) {
    if (x < 0 || z < 0 || x >= s || z >= s) return 0;
    return levels[z * s + x];
  }

  function pushVertex(x, y, z, level) {
    const key = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
    const cached = vertexCache.get(key);
    if (cached !== undefined) return cached;

    const idx = positions.length / 3;
    const c = terraceColor(level);
    positions.push(x, y, z);
    colors.push(c[0], c[1], c[2]);
    vertexCache.set(key, idx);
    return idx;
  }

  function pushTri(a, b, c) {
    indices.push(a, b, c);
  }

  function pushQuad(a, b, c, d) {
    pushTri(a, b, c);
    pushTri(a, c, d);
  }

  function addSide(level, neighborLevel, side, x0, x1, z0, z1, topMinX, topMaxX, topMinZ, topMaxZ) {
    if (level <= neighborLevel) return;

    const topY = level * terraceStep;
    const lowerY = neighborLevel * terraceStep;
    const wallTopY = hasBevel ? topY - bevelH : topY;

    let aTop, bTop, aOuter, bOuter;
    if (side === 'north') {
      aTop = [topMinX, topY, topMinZ];
      bTop = [topMaxX, topY, topMinZ];
      aOuter = [x0, wallTopY, z0];
      bOuter = [x1, wallTopY, z0];
    } else if (side === 'east') {
      aTop = [topMaxX, topY, topMinZ];
      bTop = [topMaxX, topY, topMaxZ];
      aOuter = [x1, wallTopY, z0];
      bOuter = [x1, wallTopY, z1];
    } else if (side === 'south') {
      aTop = [topMaxX, topY, topMaxZ];
      bTop = [topMinX, topY, topMaxZ];
      aOuter = [x1, wallTopY, z1];
      bOuter = [x0, wallTopY, z1];
    } else {
      aTop = [topMinX, topY, topMaxZ];
      bTop = [topMinX, topY, topMinZ];
      aOuter = [x0, wallTopY, z1];
      bOuter = [x0, wallTopY, z0];
    }

    if (hasBevel) {
      for (let i = 0; i < bevelCuts; i++) {
        const t0 = i / bevelCuts;
        const t1 = (i + 1) / bevelCuts;
        const ax0 = aTop[0] + (aOuter[0] - aTop[0]) * t0;
        const ay0 = aTop[1] + (aOuter[1] - aTop[1]) * t0;
        const az0 = aTop[2] + (aOuter[2] - aTop[2]) * t0;
        const bx0 = bTop[0] + (bOuter[0] - bTop[0]) * t0;
        const by0 = bTop[1] + (bOuter[1] - bTop[1]) * t0;
        const bz0 = bTop[2] + (bOuter[2] - bTop[2]) * t0;
        const ax1 = aTop[0] + (aOuter[0] - aTop[0]) * t1;
        const ay1 = aTop[1] + (aOuter[1] - aTop[1]) * t1;
        const az1 = aTop[2] + (aOuter[2] - aTop[2]) * t1;
        const bx1 = bTop[0] + (bOuter[0] - bTop[0]) * t1;
        const by1 = bTop[1] + (bOuter[1] - bTop[1]) * t1;
        const bz1 = bTop[2] + (bOuter[2] - bTop[2]) * t1;

        pushQuad(
          pushVertex(ax0, ay0, az0, level),
          pushVertex(bx0, by0, bz0, level),
          pushVertex(bx1, by1, bz1, level),
          pushVertex(ax1, ay1, az1, level)
        );
      }
    }

    const aWallTop = pushVertex(...aOuter, level);
    const bWallTop = pushVertex(...bOuter, level);
    const bWallBottom = pushVertex(bOuter[0], lowerY, bOuter[2], level);
    const aWallBottom = pushVertex(aOuter[0], lowerY, aOuter[2], level);
    pushQuad(aWallTop, bWallTop, bWallBottom, aWallBottom);
  }

  for (let z = 0; z < s; z++) {
    for (let x = 0; x < s; x++) {
      const level = getLevel(x, z);
      if (level <= 0) continue;

      const y = level * terraceStep;
      const x0 = -half + x * cell;
      const x1 = x0 + cell;
      const z0 = -half + z * cell;
      const z1 = z0 + cell;

      const lowerNorth = getLevel(x, z - 1) < level;
      const lowerEast = getLevel(x + 1, z) < level;
      const lowerSouth = getLevel(x, z + 1) < level;
      const lowerWest = getLevel(x - 1, z) < level;

      const topMinX = x0 + (hasBevel && lowerWest ? bevelW : 0);
      const topMaxX = x1 - (hasBevel && lowerEast ? bevelW : 0);
      const topMinZ = z0 + (hasBevel && lowerNorth ? bevelW : 0);
      const topMaxZ = z1 - (hasBevel && lowerSouth ? bevelW : 0);

      const nw = pushVertex(topMinX, y, topMinZ, level);
      const ne = pushVertex(topMaxX, y, topMinZ, level);
      const se = pushVertex(topMaxX, y, topMaxZ, level);
      const sw = pushVertex(topMinX, y, topMaxZ, level);
      pushQuad(nw, sw, se, ne);

      addSide(level, getLevel(x, z - 1), 'north', x0, x1, z0, z1, topMinX, topMaxX, topMinZ, topMaxZ);
      addSide(level, getLevel(x + 1, z), 'east', x0, x1, z0, z1, topMinX, topMaxX, topMinZ, topMaxZ);
      addSide(level, getLevel(x, z + 1), 'south', x0, x1, z0, z1, topMinX, topMaxX, topMinZ, topMaxZ);
      addSide(level, getLevel(x - 1, z), 'west', x0, x1, z0, z1, topMinX, topMaxX, topMinZ, topMaxZ);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function weldByPosition(geo, tolerance = 1e-5) {
  const srcPosition = geo.getAttribute('position');
  const srcColor = geo.getAttribute('color');
  const positions = [];
  const colors = [];
  const indices = [];
  const cache = new Map();
  const invTolerance = 1 / tolerance;

  for (let i = 0; i < srcPosition.count; i++) {
    const x = srcPosition.getX(i);
    const y = srcPosition.getY(i);
    const z = srcPosition.getZ(i);
    const key = `${Math.round(x * invTolerance)},${Math.round(y * invTolerance)},${Math.round(z * invTolerance)}`;
    let idx = cache.get(key);

    if (idx === undefined) {
      idx = positions.length / 3;
      positions.push(x, y, z);
      colors.push(srcColor.getX(i), srcColor.getY(i), srcColor.getZ(i));
      cache.set(key, idx);
    }

    indices.push(idx);
  }

  const welded = new THREE.BufferGeometry();
  welded.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  welded.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  welded.setIndex(indices);
  return welded;
}

function buildGeometry(positions, colors) {
  let geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
  geo = weldByPosition(geo);

  geo.computeVertexNormals();
  return geo;
}

// ── Full regeneration ─────────────────────────────────────────────────────
function regenerate() {
  setStatus('Generating…');
  showLoading(true);

  // Defer to next frame so the loading indicator renders first
  requestAnimationFrame(() => requestAnimationFrame(() => {
    try {
      initNoise(params.seed);
      const heights = generateHeightmap();
      const geo = buildBeveledHeightfieldGeometry(heights);

      // Clear old mesh
      while (terrainGroup.children.length) {
        const m = terrainGroup.children[0];
        m.geometry.dispose();
        if (m.material) m.material.dispose();
        terrainGroup.remove(m);
      }

      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.85,
        metalness: 0.0,
        flatShading: !params.shadeSmooth,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      terrainGroup.add(mesh);

      if (params.wireframe) {
        const wireMat = new THREE.MeshBasicMaterial({
          color: 0x203040,
          wireframe: true,
          transparent: true,
          opacity: 0.18,
        });
        terrainGroup.add(new THREE.Mesh(geo, wireMat));
      }

      const triCount = geo.index ? Math.floor(geo.index.count / 3) : Math.floor(geo.attributes.position.count / 3);
      setStatus(`Seed ${params.seed} · ${triCount.toLocaleString()} triangles · ${geo.userData.subdivisions}x bevel topology`);
    } catch (e) {
      setStatus('Error: ' + e.message);
      console.error(e);
    }
    showLoading(false);
  }));
}

// ── Export ────────────────────────────────────────────────────────────────
function exportGLB() {
  if (!terrainGroup.children.length) return;
  setStatus('Exporting…');

  const exporter = new GLTFExporter();
  const exportScene = new THREE.Scene();

  // Only export the solid mesh (first child), not the wireframe overlay
  const solidMesh = terrainGroup.children[0];
  exportScene.add(solidMesh.clone());

  exporter.parse(
    exportScene,
    (buffer) => {
      window.electronAPI.saveGlb(buffer).then(({ ok, filePath, error }) => {
        if (ok) setStatus('Saved: ' + filePath.split('\\').pop());
        else     setStatus(error ? 'Error: ' + error : 'Cancelled');
      });
    },
    (err) => { setStatus('Export error: ' + err.message); console.error(err); },
    { binary: true }
  );
}

// ── UI wiring ─────────────────────────────────────────────────────────────
function bindSlider(id, key, decimals = 0) {
  const el  = document.getElementById(id);
  const val = document.getElementById('val-' + id);
  el.value  = params[key];
  val.textContent = Number(params[key]).toFixed(decimals);
  el.addEventListener('input', () => {
    params[key]    = parseFloat(el.value);
    val.textContent = Number(params[key]).toFixed(decimals);
  });
}

bindSlider('segments',        'segments',        0);
bindSlider('noiseScale',      'noiseScale',      1);
bindSlider('amplitude',       'amplitude',       1);
bindSlider('octaves',         'octaves',         0);
bindSlider('persistence',     'persistence',     2);
bindSlider('lacunarity',      'lacunarity',      1);
bindSlider('islandSize',      'islandSize',      2);
bindSlider('islandRoughness', 'islandRoughness', 2);
bindSlider('terraceCount',    'terraceCount',    0);
bindSlider('bevelAmount',     'bevelAmount',     0);
bindSlider('bevelScale',      'bevelScale',      2);
bindSlider('subdivideAmount', 'subdivideAmount', 0);
bindSlider('cliffRandomness', 'cliffRandomness', 2);

document.getElementById('shadeSmooth').addEventListener('change', (e) => {
  params.shadeSmooth = e.target.checked;
  regenerate();
});

document.getElementById('wireframe').addEventListener('change', (e) => {
  params.wireframe = e.target.checked;
  regenerate();
});

document.getElementById('btn-generate').addEventListener('click', regenerate);

document.getElementById('btn-seed').addEventListener('click', () => {
  params.seed = Math.floor(Math.random() * 99999);
  regenerate();
});

document.getElementById('btn-export').addEventListener('click', exportGLB);

// ── Helpers ───────────────────────────────────────────────────────────────
function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

function showLoading(on) {
  const el = document.getElementById('loading');
  el.classList.toggle('hidden', !on);
}

// ── Resize ────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = viewport.clientWidth / viewport.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
});

// ── Render loop ───────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

animate();
regenerate();

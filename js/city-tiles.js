import * as THREE from 'three/webgpu';
import { Fn, uv, float, vec3, mix, step, fract, floor, sin, smoothstep, attribute, positionWorld, positionView } from 'three/tsl';
import { cityUniforms } from './tsl-materials.js';

// js/city-tiles.js
// The rest of the island beyond the detailed city: its land, and its buildings and main roads streamed in tiles around
// the camera (tools/city/tiles.mjs writes tiles/<city>/index.json and a JSON file per tile). Kept cheap: one merged
// mesh of walls, one of roofs and one of roads per tile, sharing three materials across all tiles (the walls' windows
// drawn by their shader, lit at night); no colliders, traffic or street furniture. A tile is fetched when the camera
// comes within `radius` of it (further when flying high), built one per frame, and dropped once well out of range.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const hash = (a, b) => {
  const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return s - Math.floor(s);
};

// Building colours by type: Singapore's HDB estates in their painted pastels, factories in grey and blue steel
const PASTELS = [0xf2efe6, 0xefe6d2, 0xdfe9ef, 0xe5efdf, 0xf3e2d4, 0xe9e1ee, 0xf4f1ea, 0xd9e4e8, 0xf0dccb];
const INDUSTRIAL = [0xb8bcc0, 0xa6b2bd, 0xc6c6be, 0x9aa7b3];
const CONCRETE = [0xd2cec4, 0xc8c3b8, 0xdcd8cf, 0xbfbab0];
const HOME = new Set(['residential', 'apartments', 'house', 'terrace', 'detached', 'semidetached_house', 'dormitory', 'bungalow']);
const WORKS = new Set(['industrial', 'warehouse', 'factory', 'manufacture', 'hangar', 'storage_tank']);

const nightNode = () => smoothstep(0.35, 1.3, cityUniforms.uInteriorGlow);
const hash1 = Fn(([x]) => fract(sin(x.mul(12.9898)).mul(43758.5453)));

// Walls: the building's colour, windows in rows of storeys (3 m) and bays (2.4 m); at night a share of them lit
function wallMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0.05 });
  const p = uv();
  const tint = attribute('color', 'vec3');
  const storey = floor(p.y.div(3.0));
  const fy = fract(p.y.div(3.0));
  const fx = fract(p.x.div(2.4));
  const pane = step(0.32, fy).mul(step(fy, 0.82)).mul(step(0.18, fx)).mul(step(fx, 0.82)).mul(step(2.2, p.y));
  const glass = vec3(0.16, 0.2, 0.24);
  // the windows fade into the wall's average tone with distance (no shimmering moiré across an estate)
  const near = smoothstep(1600, 350, positionView.z.negate());
  m.colorNode = mix(mix(tint, glass, 0.22), mix(tint, glass, pane.mul(0.8)), near);
  m.roughnessNode = mix(float(0.85), float(0.2), pane);
  const room = hash1(storey.mul(31.7).add(floor(p.x.div(2.4))));
  m.emissiveNode = vec3(1.0, 0.82, 0.58).mul(pane.mul(step(0.6, room)).mul(room.mul(0.7).add(0.15))).mul(nightNode());
  return m;
}
function roofMaterial() {
  return new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0.05, vertexColors: true });
}
function roadMaterial() {
  return new THREE.MeshStandardNodeMaterial({ color: 0x3b3d41, roughness: 0.92, metalness: 0.02 });
}
// The island's ground: green with grey patches (estates, car parks, industry), mottled at a few hundred metres
function landMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
  const p = positionWorld.xz;
  const n = sin(p.x.mul(0.0071).add(sin(p.y.mul(0.0053)).mul(2.1))).mul(sin(p.y.mul(0.0067).add(sin(p.x.mul(0.0047)).mul(1.7))));
  m.colorNode = mix(vec3(0.33, 0.42, 0.26), vec3(0.5, 0.5, 0.47), smoothstep(-0.2, 0.5, n));
  return m;
}

// Decoding a tile (tools/city/tiles.mjs): buildings [rings=1, top dm, bottom dm, type, n, dx dz (dm)...] and road runs
function decodeBuildings(B) {
  const out = [];
  const d = B.data;
  let fx = 0, fz = 0;
  for (let i = 0; i < d.length;) {
    const rings = d[i];
    const b = { top: d[i + 1] / 10, bottom: d[i + 2] / 10, type: B.types[d[i + 3]], pts: null };
    i += 4;
    for (let r = 0; r < rings; r++) {
      const n = d[i++];
      const pts = new Float32Array(n * 2);
      let px = fx, pz = fz;
      for (let k = 0; k < n; k++) {
        px += d[i++]; pz += d[i++];
        pts[k * 2] = px / 10; pts[k * 2 + 1] = pz / 10;
        if (!k) { fx = px; fz = pz; }
      }
      if (!r) b.pts = pts;
    }
    out.push(b);
  }
  return out;
}

// A triangle on the ground (y), wound to face up
function upTri(out, p, q, r, y) {
  const cy = (q[1] - p[1]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[1] - p[1]);
  if (cy < 0) [q, r] = [r, q];
  out.push(p[0], y, p[1], q[0], y, q[1], r[0], y, r[1]);
}

// One tile's meshes (positions relative to its corner)
function buildTileGeometry(tile, materials) {
  const walls = { pos: [], nrm: [], uv: [], col: [] };
  const roofs = { pos: [], col: [] };
  const color = new THREE.Color();
  const contour = [];
  for (const b of decodeBuildings(tile.buildings)) {
    const pts = b.pts;
    const n = pts.length / 2;
    const r = hash(pts[0], pts[1]);
    const palette = HOME.has(b.type) ? PASTELS : WORKS.has(b.type) ? INDUSTRIAL : CONCRETE;
    color.setHex(palette[Math.floor(r * palette.length)]);
    // walls: each edge a quad, its uv in metres along the walls (from a random start) and up from the ground
    let along = r * 37;
    if (b.type !== 'roof') {
      for (let k = 0; k < n; k++) {
        const ax = pts[k * 2], az = pts[k * 2 + 1];
        const bx = pts[((k + 1) % n) * 2], bz = pts[((k + 1) % n) * 2 + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.3) continue;
        const nx = -(bz - az) / len, nz = (bx - ax) / len; // outward for clockwise rings
        walls.pos.push(ax, b.bottom, az, bx, b.bottom, bz, bx, b.top, bz, ax, b.bottom, az, bx, b.top, bz, ax, b.top, az);
        for (let v = 0; v < 6; v++) { walls.nrm.push(nx, 0, nz); walls.col.push(color.r, color.g, color.b); }
        const u0 = along, u1 = along + len;
        walls.uv.push(u0, b.bottom, u1, b.bottom, u1, b.top, u0, b.bottom, u1, b.top, u0, b.top);
        along = u1;
      }
    }
    // roof, a little darker
    contour.length = 0;
    for (let k = 0; k < n; k++) contour.push(new THREE.Vector2(pts[k * 2], pts[k * 2 + 1]));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    const shade = 0.72 + r * 0.18;
    for (const [i0, i1, i2] of tris) {
      const p0 = contour[i0], p1 = contour[i1], p2 = contour[i2];
      const cross = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x);
      const [q1, q2] = cross < 0 ? [p1, p2] : [p2, p1];
      roofs.pos.push(p0.x, b.top, p0.y, q1.x, b.top, q1.y, q2.x, b.top, q2.y);
      for (let v = 0; v < 3; v++) roofs.col.push(color.r * shade, color.g * shade, color.b * shade);
    }
  }
  // main roads: a ribbon per run, its segments overlapping at the joints
  const roads = [];
  for (const run of tile.roads) {
    const [, wdm, level, n] = run;
    const w = wdm / 20;
    const y = level ? 0.04 : -0.02;
    let px = 0, pz = 0;
    const P = [];
    for (let k = 0; k < n; k++) {
      px += run[4 + k * 2]; pz += run[5 + k * 2];
      P.push(px / 10, pz / 10);
    }
    for (let k = 0; k + 1 < n; k++) {
      const ax = P[k * 2], az = P[k * 2 + 1], bx = P[k * 2 + 2], bz = P[k * 2 + 3];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.1) continue;
      const ux = (bx - ax) / len, uz = (bz - az) / len;
      const ex = ux * w * 0.5, ez = uz * w * 0.5; // overlap the joints by half a width
      const sx = -uz * w, sz = ux * w;
      const a0 = [ax - ex + sx, az - ez + sz], a1 = [ax - ex - sx, az - ez - sz];
      const b0 = [bx + ex + sx, bz + ez + sz], b1 = [bx + ex - sx, bz + ez - sz];
      upTri(roads, a0, b0, b1, y);
      upTri(roads, a0, b1, a1, y);
    }
  }

  const group = new THREE.Group();
  if (walls.pos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(walls.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(walls.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(walls.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(walls.col, 3));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, materials.walls);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  if (roofs.pos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(roofs.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(roofs.col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, materials.roofs);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  if (roads.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(roads, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, materials.roads);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return { group, walls: walls.pos.length / 18, roofs: roofs.pos.length / 9, roads: roads.length / 18 };
}

// The island's land (index.json land: [[outer, ...holes]] flat x, z) as a ground just under the city's own, over a
// sea wall down to the water
function buildLand(land, material, wallMaterial) {
  const group = new THREE.Group();
  group.name = 'IslandLand';
  const toPath = (flat, P) => {
    const path = new P();
    for (let k = 0; k < flat.length; k += 2) (k ? path.lineTo(flat[k], -flat[k + 1]) : path.moveTo(flat[k], -flat[k + 1]));
    path.closePath();
    return path;
  };
  for (const [outer, ...holes] of land) {
    const shape = toPath(outer, THREE.Shape);
    for (const h of holes) shape.holes.push(toPath(h, THREE.Path));
    const top = new THREE.ShapeGeometry(shape, 1).rotateX(-Math.PI / 2).translate(0, -0.1, 0);
    const mesh = new THREE.Mesh(top, material);
    mesh.receiveShadow = true;
    const side = new THREE.ExtrudeGeometry(shape, { depth: 2.2, bevelEnabled: false, curveSegments: 1 }).rotateX(-Math.PI / 2).translate(0, -2.35, 0);
    const wall = new THREE.Mesh(side, wallMaterial);
    group.add(mesh, wall);
  }
  return group;
}

class CityTiles {
  // `url`: the tiles' directory; `radius` (m) of tiles kept around the camera at street level
  constructor(scene, { url, radius = 3500 } = {}) {
    this.scene = scene;
    this.url = url;
    this.radius = radius;
    this.group = new THREE.Group();
    this.group.name = 'CityTiles';
    scene.add(this.group);
    this.materials = { walls: wallMaterial(), roofs: roofMaterial(), roads: roadMaterial() };
    this.loaded = new Map(); // key -> { group } | { pending: true }
    this.queue = [];
    this.inflight = 0;
    this.index = null;
    this.stats = { tiles: 0, walls: 0 };
    // a stand-in using each material, so the shaders compile behind the loading screen with the rest
    const stand = new THREE.BufferGeometry();
    stand.setAttribute('position', new THREE.Float32BufferAttribute([0, -50, 0, 1, -50, 0, 0, -50, 1], 3));
    stand.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    stand.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
    stand.setAttribute('color', new THREE.Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1], 3));
    for (const mat of Object.values(this.materials)) this.group.add(new THREE.Mesh(stand, mat));
  }

  async init() {
    try {
      const r = await fetch(`${this.url}index.json`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.index = await r.json();
    } catch (e) {
      console.warn(`[tiles] no island tiles at ${this.url}: ${e.message}`);
      return false;
    }
    const seawall = new THREE.MeshStandardNodeMaterial({ color: 0x5c5a55, roughness: 0.82, metalness: 0.1 });
    this.land = buildLand(this.index.land, landMaterial(), seawall);
    this.group.add(this.land);
    this.byKey = new Map(this.index.tiles.map((t) => [`${t.i},${t.j}`, t]));
    console.info(`[tiles] ${this.index.tiles.length} island tiles of ${this.index.tile} m (${this.index.tiles.reduce((n, t) => n + t.buildings, 0)} buildings)`);
    return true;
  }

  // Which tiles to keep for a camera at (x, y, z): those within the radius (wider with altitude) of it
  wanted(x, y, z) {
    const T = this.index.tile;
    const R = clamp(this.radius + Math.max(0, y) * 12, this.radius, 12000);
    const out = [];
    const i0 = Math.floor((x - R) / T), i1 = Math.floor((x + R) / T);
    const j0 = Math.floor((z - R) / T), j1 = Math.floor((z + R) / T);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const t = this.byKey.get(`${i},${j}`);
        if (!t) continue;
        const d = Math.hypot(clamp(x, i * T, (i + 1) * T) - x, clamp(z, j * T, (j + 1) * T) - z);
        if (d <= R) out.push([d, t]);
      }
    }
    out.sort((a, b) => a[0] - b[0]);
    return { R, tiles: out.map(([, t]) => t) };
  }

  update(camera) {
    if (!this.index) return;
    const { x, y, z } = camera.position;
    const { R, tiles } = this.wanted(x, y, z);
    const T = this.index.tile;
    // fetch the nearest missing tiles, two at a time
    for (const t of tiles) {
      if (this.inflight >= 2) break;
      const key = `${t.i},${t.j}`;
      if (this.loaded.has(key)) continue;
      this.loaded.set(key, { pending: true });
      this.inflight++;
      fetch(`${this.url}${t.file}`).then((r) => r.json()).then((data) => {
        this.queue.push({ key, t, data });
      }).catch((e) => {
        console.warn(`[tiles] ${t.file}: ${e.message}`);
        this.loaded.delete(key);
      }).finally(() => { this.inflight--; });
    }
    // build at most one a frame
    const job = this.queue.shift();
    if (job && this.loaded.has(job.key)) {
      const built = buildTileGeometry(job.data, this.materials);
      built.group.position.set(job.t.i * T, 0, job.t.j * T);
      built.group.name = `tile_${job.key}`;
      this.group.add(built.group);
      this.loaded.set(job.key, { group: built.group, walls: built.walls });
      this.stats.tiles++;
      this.stats.walls += built.walls;
    }
    // drop the tiles well out of range
    for (const [key, entry] of this.loaded) {
      if (!entry.group) continue;
      const t = this.byKey.get(key);
      const d = Math.hypot(clamp(x, t.i * T, (t.i + 1) * T) - x, clamp(z, t.j * T, (t.j + 1) * T) - z);
      if (d > R + T) {
        this.group.remove(entry.group);
        for (const mesh of entry.group.children) mesh.geometry.dispose();
        this.loaded.delete(key);
        this.stats.tiles--;
        this.stats.walls -= entry.walls;
      }
    }
  }
}

export { CityTiles, decodeBuildings, buildTileGeometry };

import * as THREE from 'three/webgpu';
import { Fn, uv, float, vec3, mix, step, fract, floor, sin, smoothstep, attribute, positionWorld, positionView } from 'three/tsl';
import { cityUniforms } from './tsl-materials.js';
import { buildTileArrays } from './city-tiles-build.js';

// js/city-tiles.js
// The rest of the island beyond the detailed city: its land, and its buildings and main roads streamed in tiles around
// the camera (tools/city/tiles.mjs writes tiles/<city>/index.json and a JSON file per tile). Kept cheap: one merged
// mesh of walls, one of roofs and one of roads per tile, sharing three materials across all tiles (the walls' windows
// drawn by their shader, lit at night); no colliders, traffic or street furniture. A tile is fetched and built in a
// worker (js/city-tiles-worker.js, js/city-tiles-build.js) when the camera comes within `radius` of it (further when
// flying high), handed over as typed arrays, and dropped once well out of range.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
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

// A built tile (js/city-tiles-build.js) as meshes, positions relative to its corner
function tileMeshes(built, materials) {
  const group = new THREE.Group();
  for (const [part, material] of [[built.walls, materials.walls], [built.roofs, materials.roofs], [built.roads, materials.roads]]) {
    if (!part) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(part.position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(part.normal, 3));
    if (part.uv) g.setAttribute('uv', new THREE.BufferAttribute(part.uv, 2));
    if (part.color) g.setAttribute('color', new THREE.BufferAttribute(part.color, 3));
    const [x, y, z, r] = part.sphere;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(x, y, z), r);
    const mesh = new THREE.Mesh(g, material);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
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
    this.queue = []; // built tiles waiting to be added, one a frame
    this.inflight = 0;
    this.requests = new Map(); // worker request id -> { key, t }
    this.nextId = 1;
    // the worker fetches & builds; without one (or if it fails to start) the main thread does
    try {
      this.worker = new Worker(new URL('./city-tiles-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }) => this.received(data);
      this.worker.onerror = (e) => {
        console.warn(`[tiles] worker failed (${e.message || 'error'}): building tiles on the main thread`);
        this.worker = null;
        for (const { key } of this.requests.values()) this.loaded.delete(key);
        this.requests.clear();
        this.inflight = 0;
      };
    } catch {
      this.worker = null;
    }
    this.index = null;
    this.stats = { tiles: 0, walls: 0 };
    // called with (tile corner x, z, outlines) as each tile is added (the maps draw its buildings)
    this.onTileOutlines = null;
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

  // A tile back from the worker (or the main-thread fallback)
  received({ id, key, t, built, error }) {
    if (id !== undefined) {
      const request = this.requests.get(id);
      if (!request) return; // (the worker was replaced)
      this.requests.delete(id);
      ({ key, t } = request);
    }
    this.inflight = Math.max(0, this.inflight - 1);
    if (error) {
      console.warn(`[tiles] ${t.file}: ${error}`);
      this.loaded.delete(key);
      return;
    }
    // dropped while it was being built: forget it
    if (!this.loaded.has(key)) return;
    this.queue.push({ key, t, built });
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
  }

  update(camera) {
    if (!this.index) return;
    const { x, y, z } = camera.position;
    const { R, tiles } = this.wanted(x, y, z);
    const T = this.index.tile;
    // fetch & build the nearest missing tiles, a few at a time
    for (const t of tiles) {
      if (this.inflight >= (this.worker ? 3 : 1)) break;
      const key = `${t.i},${t.j}`;
      if (this.loaded.has(key)) continue;
      this.loaded.set(key, { pending: true });
      this.inflight++;
      const url = new URL(`${this.url}${t.file}`, location.href).href;
      if (this.worker) {
        const id = this.nextId++;
        this.requests.set(id, { key, t });
        this.worker.postMessage({ id, url });
      } else {
        fetch(url).then((r) => r.json()).then((data) => this.received({ key, t, built: buildTileArrays(data) }))
          .catch((e) => this.received({ key, t, error: e.message }));
      }
    }
    // add at most one built tile a frame (a few typed arrays: cheap)
    const job = this.queue.shift();
    if (job && this.loaded.has(job.key)) {
      const group = tileMeshes(job.built, this.materials);
      group.position.set(job.t.i * T, 0, job.t.j * T);
      group.name = `tile_${job.key}`;
      this.group.add(group);
      this.loaded.set(job.key, { group, walls: job.built.counts.walls });
      this.stats.tiles++;
      this.stats.walls += job.built.counts.walls;
      if (this.onTileOutlines && job.built.outlines) this.onTileOutlines(job.key, job.t.i * T, job.t.j * T, job.built.outlines);
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

export { CityTiles, tileMeshes };

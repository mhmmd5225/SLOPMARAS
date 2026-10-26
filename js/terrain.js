import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, vec4, ivec2, uniform, texture, floor, clamp, min, select, positionLocal, modelWorldMatrix, modelWorldMatrixInverse } from 'three/tsl';
import { GEO } from './geodata.js';
import { decodeGrid, linearAt, groundTriangle, cutSoup, raiseVertices } from './terrain-cut.js';

// js/terrain.js
// The ground under a city built with its heights (GEO.terrain, tools/city/terrain.mjs): a fine grid under the city
// (20 m; it eases into the coarse one at its edge) and a coarse one over the region around it (100 m), in metres above
// the origin's ground. The ground is linear over each grid cell's two triangles (split along the diagonal from its
// (i + 1, j) corner to its (i, j + 1) one), on the CPU (heightAt) and the GPU (terrainHeightNode) alike, so whatever is
// cut along those lines lies exactly on it. Only the drawing follows the ground: the simulation (traffic, pedestrians,
// the player's physics, colliders, culling's cells) stays on the flat plane it always had, and the ground lifts what
// is drawn:
// - the static city (the ground layers, buildings, trees, road paint) once at load, on the CPU (bakeTerrain): meshes
//   cut along the fine grid's lines and diagonals and raised (the road deck, sidewalks and lawns then follow the same
//   triangles: none pokes through another), instances raised whole, so bounds, culling and the shadow stand-ins see
//   the city where it is drawn
// - what moves (vehicles, people, the player, the signals) in its vertex stage (liftMaterials): every vertex raised by
//   the ground under it, so a car on a slope leans with it
// - the camera (cameras.js) and the moving lamps (liftLights) each frame
// deckY(positionWorld) is a world position's height above the ground (the facades' storeys count from it). With no
// GEO.terrain all of it is flat (0).

const T = GEO.terrain || null;

const FINE = T ? decodeGrid(T.fine) : null;
const COARSE = T ? decodeGrid(T.coarse) : null;

const inFine = (x, z) => x >= FINE.x0 && x <= FINE.x1 && z >= FINE.z0 && z <= FINE.z1;

/** The ground's height (m above the origin's) at world (x, z): 0 in a city without terrain */
function heightAt(x, z) {
  if (!T) return 0;
  return inFine(x, z) ? linearAt(FINE, x, z) : linearAt(COARSE, x, z);
}

// The ground's slope at (x, z) across `d` m each way (a cell's width smooths the triangles' facets): [∂h/∂x, ∂h/∂z]
function slopeAt(x, z, d = T ? FINE.cell : 1) {
  return [(heightAt(x + d, z) - heightAt(x - d, z)) / (2 * d), (heightAt(x, z + d) - heightAt(x, z - d)) / (2 * d)];
}

// --- GPU -----------------------------------------------------------------------------------------------------------
// Each grid as a float map read texel by texel (float textures aren't filterable everywhere WebGL2 runs), linear over
// the cells' triangles like linearAt()
function gridNode(G) {
  const data = new THREE.DataTexture(G.h, G.cols, G.rows, THREE.RedFormat, THREE.FloatType);
  data.magFilter = data.minFilter = THREE.NearestFilter;
  data.generateMipmaps = false;
  data.needsUpdate = true;
  const map = texture(data);
  const origin = vec2(G.x0, G.z0), last = vec2(G.cols - 1, G.rows - 1), cellMax = vec2(G.cols - 2, G.rows - 2);
  return (xz) => {
    const g = clamp(xz.sub(origin).div(G.cell), vec2(0), last).toVar();
    const c = min(floor(g), cellMax).toVar();
    const t = g.sub(c).toVar();
    const i = ivec2(c).toVar();
    const h00 = map.load(i).r, h10 = map.load(i.add(ivec2(1, 0))).r, h01 = map.load(i.add(ivec2(0, 1))).r, h11 = map.load(i.add(ivec2(1, 1))).r;
    const lower = h00.add(h10.sub(h00).mul(t.x)).add(h01.sub(h00).mul(t.y));
    const upper = h11.add(h01.sub(h11).mul(t.x.oneMinus())).add(h10.sub(h11).mul(t.y.oneMinus()));
    return select(t.x.add(t.y).lessThanEqual(1), lower, upper);
  };
}
const fineNode = T ? gridNode(FINE) : null;
const coarseNode = T ? gridNode(COARSE) : null;

/** The ground's height at a world xz (vec2 node), on the GPU */
const terrainHeightNode = Fn(([xz]) => {
  if (!T) return float(0);
  const inside = xz.x.greaterThanEqual(FINE.x0).and(xz.x.lessThanEqual(FINE.x1)).and(xz.y.greaterThanEqual(FINE.z0)).and(xz.y.lessThanEqual(FINE.z1));
  return select(inside, fineNode(xz), coarseNode(xz));
});

/** A world position's height above the ground under it (positionWorld.y in a flat city) */
const deckY = (positionWorldNode) => (T ? positionWorldNode.y.sub(terrainHeightNode(positionWorldNode.xz)) : positionWorldNode.y);

// --- The static city, baked ----------------------------------------------------------------------------------------
const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _v = new THREE.Vector3();
const IDENTITY = new THREE.Matrix4();

// An attribute's values as a plain array of itemSize-tuples (works for interleaved attributes too)
function readAttribute(attr) {
  if (!attr.isInterleavedBufferAttribute && attr.array instanceof Float32Array && !attr.normalized) return attr.array.slice(0, attr.count * attr.itemSize);
  const n = attr.count, s = attr.itemSize, out = new Float32Array(n * s);
  for (let i = 0; i < n; i++) for (let c = 0; c < s; c++) out[i * s + c] = attr.getComponent(i, c);
  return out;
}

// The workers cutting the ground layers (terrain-worker.js), up to four beside this thread, each sent the grids once;
// none where workers can't run (the cutting then runs here)
let pool = null;
function workers() {
  if (pool) return pool;
  pool = [];
  try {
    const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
    for (let k = 0; k < n; k++) {
      const w = new Worker(new URL('./terrain-worker.js', import.meta.url), { type: 'module' });
      w.jobs = new Map();
      w.load = 0;
      w.onmessage = ({ data }) => {
        const job = w.jobs.get(data.id);
        w.jobs.delete(data.id);
        w.load -= job.size;
        if (data.error) job.fallback(data.error); else job.resolve(data);
      };
      // (a worker that can't start: its jobs, and the ones after them, are cut here)
      w.onerror = (e) => {
        e.preventDefault?.();
        console.warn(`[terrain] a worker failed (${e.message || 'it would not start'}): its share is cut on the main thread`);
        pool = pool.filter((o) => o !== w);
        for (const job of w.jobs.values()) job.fallback(e.message || 'worker failed');
        w.jobs.clear();
        w.terminate();
      };
      w.postMessage({ grids: { fine: FINE, coarse: COARSE } });
      pool.push(w);
    }
  } catch (e) {
    console.warn(`[terrain] no workers (${e.message}): the ground is cut on the main thread`);
  }
  return pool;
}
let nextJob = 0;
// (started at once: a module worker only boots while this thread is free, and the city is built in one long run)
if (T && typeof Worker !== 'undefined') workers();

// One piece of cutting: a triangle soup cut, welded and laid on the ground, by the least loaded worker (or here)
function cutJob(soup, stride, dropUndersides, normalOffset) {
  const here = () => {
    const cut = cutSoup(FINE, soup, stride, dropUndersides);
    raiseVertices(FINE, COARSE, cut.unique, cut.count, stride, normalOffset);
    return cut;
  };
  const ws = workers();
  if (!ws.length) return Promise.resolve().then(here);
  const w = ws.reduce((a, b) => (b.load < a.load ? b : a));
  const id = nextJob++;
  return new Promise((resolve) => {
    const fallback = (why) => { console.warn(`[terrain] cut here instead: ${why}`); resolve(here()); };
    w.jobs.set(id, { resolve, fallback, size: soup.length });
    w.load += soup.length;
    // (the soup is copied, not transferred: it is cut here should the worker fail)
    w.postMessage({ id, soup, stride, dropUndersides, normalOffset });
  });
}

// Triangles per piece of cutting: the big layers (sidewalks, curbs, road paint: ~150 000 triangles each) are shared
// out among the workers
const PIECE = 20000;

/**
 * Cuts a ground layer (its geometry `geo`, world positions `world`) along the fine grid's lines and its cells'
 * diagonals in pieces on the workers, every attribute interpolated, groups keeping their ranges: each piece lies over
 * one triangle of the ground, so raising its vertices lays it on the ground exactly. The pieces come back raised, the
 * up-facing normals tilted with the ground when `tilt`. Resolves to { geometry (indexed, raised world positions) }, or
 * null at once if no triangle crosses a ground triangle's edge
 */
function cutLayer(geo, world, dropUndersides, tilt) {
  const G = FINE;
  const index = geo.index;
  const pos = geo.attributes.position;
  const triCount = (index ? index.count : pos.count) / 3;
  const vtx = index ? (t, k) => index.getX(t * 3 + k) : (t, k) => t * 3 + k;
  let needs = false;
  for (let t = 0; t < triCount && !needs; t++) {
    const a = vtx(t, 0), b = vtx(t, 1), c = vtx(t, 2);
    const ka = groundTriangle(G, world[a * 3], world[a * 3 + 2]);
    needs = ka < 0 || ka !== groundTriangle(G, world[b * 3], world[b * 3 + 2]) || ka !== groundTriangle(G, world[c * 3], world[c * 3 + 2]);
  }
  if (!needs) return null;
  // each vertex: its world position, then its other attributes (its position comes back raised, in world space)
  const attrs = Object.keys(geo.attributes).filter((name) => name !== 'position')
    .map((name) => ({ name, s: geo.attributes[name].itemSize, a: readAttribute(geo.attributes[name]), src: geo.attributes[name] }));
  let stride = 3;
  for (const a of attrs) { a.offset = stride; stride += a.s; }
  const normalOffset = tilt ? (attrs.find((a) => a.name === 'normal')?.offset ?? -1) : -1;
  const ranges = geo.groups.length ? geo.groups : [{ start: 0, count: triCount * 3, materialIndex: 0 }];
  const pieces = [];
  ranges.forEach((r, g) => {
    for (let t0 = r.start / 3, end = Math.min(triCount, (r.start + r.count) / 3); t0 < end; t0 += PIECE) {
      const t1 = Math.min(end, t0 + PIECE);
      const soup = new Float32Array((t1 - t0) * 3 * stride);
      let o = 0;
      for (let t = t0; t < t1; t++) {
        for (let k = 0; k < 3; k++) {
          const i = vtx(t, k);
          soup[o++] = world[i * 3]; soup[o++] = world[i * 3 + 1]; soup[o++] = world[i * 3 + 2];
          for (const { s, a } of attrs) for (let c = 0; c < s; c++) soup[o++] = a[i * s + c];
        }
      }
      pieces.push({ g, cut: cutJob(soup, stride, dropUndersides, normalOffset) });
    }
  });
  return Promise.all(pieces.map((p) => p.cut)).then((cuts) => {
    // the pieces' vertices one after another, their indices offset to match, each group the run of its pieces'
    let count = 0, emitted = 0;
    for (const c of cuts) { count += c.count; emitted += c.indices.length; }
    const u = new Float32Array(count * stride);
    const indices = count > 65535 ? new Uint32Array(emitted) : new Uint16Array(emitted);
    const groups = ranges.map((r) => ({ start: 0, count: 0, materialIndex: r.materialIndex }));
    let base = 0, at = 0;
    cuts.forEach((c, k) => {
      u.set(c.unique, base * stride);
      for (let i = 0; i < c.indices.length; i++) indices[at + i] = c.indices[i] + base;
      const group = groups[pieces[k].g];
      if (!group.count) group.start = at;
      group.count += c.indices.length;
      base += c.count;
      at += c.indices.length;
    });
    const result = new THREE.BufferGeometry();
    for (const { name, s, src, offset } of [{ name: 'position', s: 3, src: pos, offset: 0 }, ...attrs]) {
      const arr = new Float32Array(count * s);
      for (let k = 0; k < count; k++) for (let c = 0; c < s; c++) arr[k * s + c] = u[k * stride + offset + c];
      const Arr = src.array && !src.isInterleavedBufferAttribute ? src.array.constructor : Float32Array;
      result.setAttribute(name, new THREE.BufferAttribute(Arr === Float32Array ? arr : Arr.from(arr), s, src.normalized));
    }
    result.setIndex(new THREE.BufferAttribute(indices, 1));
    if (geo.groups.length) for (const g of groups) result.addGroup(g.start, g.count, g.materialIndex);
    return { geometry: result };
  });
}

// Raises a static mesh's vertices by the ground under each, up-facing normals tilted with the slope so it is lit as
// one. A ground layer is cut along the ground's triangles first, on the workers: then a promise, settled once it is
// cut, raised and in place. Returns how many triangles the cutting added (or a promise of it)
function bakeMesh(mesh, shared) {
  let geo = mesh.geometry;
  if (!geo || !geo.attributes.position) return 0;
  if (shared.get(geo) > 1) geo = geo.clone(); // (a geometry drawn at several places is baked for each)
  mesh.updateWorldMatrix(true, false);
  _m.copy(mesh.matrixWorld);
  const identity = _m.equals(IDENTITY);
  const pos = geo.attributes.position;
  const world = readAttribute(pos);
  if (!identity) for (let i = 0; i < pos.count; i++) _v.fromArray(world, i * 3).applyMatrix4(_m).toArray(world, i * 3);
  const before = (geo.index ? geo.index.count : pos.count) / 3;
  // The ground layers (the road deck, sidewalks & curbs, lawns, road paint: all within a metre or so of the street)
  // are cut along the ground's triangles so each lies on it exactly; the rest (buildings, roofs) stand on the ground
  // at their corners, raised vertex by vertex. Lines & points are raised point by point
  let lo = Infinity, hi = -Infinity;
  for (let i = 1; i < world.length; i += 3) { lo = Math.min(lo, world[i]); hi = Math.max(hi, world[i]); }
  const ground = mesh.isMesh && lo > -3 && hi < 1.5;
  const material = [].concat(mesh.material)[0];
  const cutting = ground ? cutLayer(geo, world, material && material.side === THREE.FrontSide, identity) : null;
  if (cutting) {
    const inv = _m.clone().invert();
    return cutting.then(({ geometry }) => {
      // (raised in world space by the workers: back into the mesh's own frame unless the two are the same)
      if (!identity) {
        const p = geometry.attributes.position;
        for (let i = 0; i < p.count; i++) { _v.fromBufferAttribute(p, i).applyMatrix4(inv); p.setXYZ(i, _v.x, _v.y, _v.z); }
      }
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      mesh.geometry = geometry;
      return geometry.index.count / 3 - before;
    });
  }
  _inv.copy(_m).invert();
  const p = geo.attributes.position, n = identity ? geo.attributes.normal : null;
  for (let i = 0; i < p.count; i++) {
    const x = world[i * 3], z = world[i * 3 + 2];
    const y = world[i * 3 + 1] + heightAt(x, z);
    if (identity) p.setY(i, y);
    else { _v.set(x, y, z).applyMatrix4(_inv); p.setXYZ(i, _v.x, _v.y, _v.z); }
    if (n && n.getY(i) > 0.7) {
      const [gx, gz] = slopeAt(x, z);
      _v.set(n.getX(i) - gx * n.getY(i), n.getY(i), n.getZ(i) - gz * n.getY(i)).normalize();
      n.setXYZ(i, _v.x, _v.y, _v.z);
    }
  }
  p.needsUpdate = true;
  if (n) n.needsUpdate = true;
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  mesh.geometry = geo;
  return 0;
}

// Raises an instanced mesh's instances, each as a whole, by the ground under its origin
function bakeInstances(mesh) {
  mesh.updateWorldMatrix(true, false);
  _inv.copy(mesh.matrixWorld).invert();
  const im = mesh.instanceMatrix;
  for (let i = 0; i < im.count; i++) {
    _m.fromArray(im.array, i * 16);
    _v.setFromMatrixPosition(_m).applyMatrix4(mesh.matrixWorld);
    const h = heightAt(_v.x, _v.z);
    _v.set(0, 1, 0).transformDirection(_inv).multiplyScalar(h); // the lift, in the mesh's own frame
    im.array[i * 16 + 12] += _v.x;
    im.array[i * 16 + 13] += _v.y;
    im.array[i * 16 + 14] += _v.z;
  }
  im.needsUpdate = true;
  mesh.boundingSphere = mesh.boundingBox = null;
  mesh.computeBoundingSphere();
  mesh.computeBoundingBox();
}

// Raises an object (a lamp, a spot's target) by the ground under it: once, or each frame (liftLights) undoing the
// last frame's lift unless the simulation has placed it since. `fresh`: bring the parents' world matrices up to date
// first (each frame, last frame's are near enough)
function liftObject(o, fresh = true) {
  const u = o.userData;
  if (u.terrainY !== undefined && o.position.y === u.terrainY) o.position.y -= u.terrainLift;
  if (o.parent && fresh) o.parent.updateWorldMatrix(true, false);
  _v.copy(o.position);
  if (o.parent) _v.applyMatrix4(o.parent.matrixWorld);
  const h = heightAt(_v.x, _v.z);
  o.position.y += h;
  u.terrainLift = h;
  u.terrainY = o.position.y;
}

// What startTerrainBake has set going: the ground layers being cut, and the count so far
const baking = { pending: [], stats: { meshes: 0, instanced: 0, lights: 0, triangles: 0, ms: 0 } };

/**
 * Starts baking the ground into the static city under `roots`, as soon as it is built (bakeTerrain finishes it): the
 * ground layers go to the workers to be cut along the ground's triangles while this thread builds the rest of the
 * city; the rest (buildings, instances, lamps) is raised here and now. Marks each object (userData.terrainBaked) so
 * it is baked once and liftMaterials() leaves it be
 */
function startTerrainBake(roots) {
  if (!T) return;
  const stats = baking.stats;
  const shared = new Map();
  for (const root of roots) root.traverse((o) => { if (o.isMesh && !o.isInstancedMesh && o.geometry) shared.set(o.geometry, (shared.get(o.geometry) || 0) + 1); });
  for (const root of roots) {
    root.traverse((o) => {
      if (o.userData.terrainBaked) return;
      if (o.isPointLight || o.isSpotLight) {
        liftObject(o);
        if (o.target && !o.target.parent) liftObject(o.target);
        stats.lights++;
      } else if (o.isInstancedMesh) {
        bakeInstances(o);
        stats.instanced++;
      } else if (o.isMesh || o.isLine || o.isPoints) {
        const added = bakeMesh(o, shared);
        if (added instanceof Promise) baking.pending.push(added.then((n) => (stats.triangles += n)));
        else stats.triangles += added;
        stats.meshes++;
      } else return;
      o.userData.terrainBaked = true;
    });
  }
}

/**
 * Bakes the ground into the static city under `roots` (once, after it is built and before the culling is set up),
 * with what startTerrainBake started: meshes cut along the ground's triangles and raised, instances raised whole,
 * lamps raised. Resolves to what it did, `ms` the time spent here
 */
async function bakeTerrain(roots) {
  const t0 = performance.now();
  if (!T) return baking.stats;
  startTerrainBake(roots);
  await Promise.all(baking.pending);
  baking.pending = [];
  baking.stats.ms = Math.round(performance.now() - t0);
  return baking.stats;
}

// --- What moves, lifted in the shader --------------------------------------------------------------------------------
// 1 for an object the ground lifts in its vertex stage, 0 for one baked (a material may serve both) or made from the
// baked city (scene-culling.js's shadow stand-ins)
const isBaked = (o) => !!(o.userData.terrainBaked || o.userData.shadowProxy);
const liftOn = uniform(1).onObjectUpdate(({ object }) => (isBaked(object) ? 0 : 1));

function liftMaterial(material) {
  const inner = material.positionNode;
  material.positionNode = Fn(() => {
    // (a sprite's positionNode is its centre: none, the object's origin)
    const p = inner ?? (material.isSpriteNodeMaterial ? vec3(0) : positionLocal);
    const w = modelWorldMatrix.mul(vec4(p, 1.0));
    const h = terrainHeightNode(w.xz).mul(liftOn);
    return p.add(modelWorldMatrixInverse.mul(vec4(0.0, h, 0.0, 0.0)).xyz);
  })();
  if (material.castShadowPositionNode) {
    const shadowInner = material.castShadowPositionNode;
    material.castShadowPositionNode = Fn(() => {
      const w = modelWorldMatrix.mul(vec4(shadowInner, 1.0));
      return shadowInner.add(modelWorldMatrixInverse.mul(vec4(0.0, terrainHeightNode(w.xz).mul(liftOn), 0.0, 0.0)).xyz);
    })();
  }
  material.needsUpdate = true;
}

/**
 * Lifts, in their vertex stage, the materials of everything in the scene not baked (what moves), once, after the
 * culling is set up and before the shaders compile. Materials that place their own vertices (vertexNode: the sky) and
 * objects marked userData.noTerrain (and what is under them) are left as they are. Returns how many it lifted
 */
function liftMaterials(scene) {
  if (!T) return 0;
  const lifted = new Set();
  const visit = (o) => {
    if (o.userData.noTerrain) return;
    if (!isBaked(o) && (o.isMesh || o.isSprite || o.isPoints || o.isLine)) {
      // (its bounds are on the flat plane, its drawing over the ground: the camera's frustum would cull it wrongly)
      o.frustumCulled = false;
      for (const m of [].concat(o.material || [])) {
        if (!m || !m.isNodeMaterial || m.vertexNode || lifted.has(m)) continue;
        liftMaterial(m);
        lifted.add(m);
      }
    }
    for (const c of o.children) visit(c);
  };
  visit(scene);
  return lifted.size;
}

/** The moving lamps (point & spot lights not baked) under `roots` */
function collectLights(roots) {
  const lights = [];
  for (const root of roots.filter(Boolean)) {
    root.traverse((o) => { if ((o.isPointLight || o.isSpotLight) && !o.userData.terrainBaked) lights.push(o); });
  }
  return lights;
}

/** Each frame, before the moving roots' matrices are updated: each moving lamp (and its target) over the ground */
function liftLights(lights) {
  if (!T) return;
  for (const l of lights) {
    liftObject(l, false);
    if (l.target && !l.target.parent) liftObject(l.target, false);
  }
}

// --- The ground beyond the city ----------------------------------------------------------------------------------------
/**
 * The region's ground as one mesh on the coarse grid's points (its heights baked in, its quads split along the same
 * diagonal as the ground's), from the edge of the city's land out to the horizon: the quads that `covered(x, z)` (the
 * city's own ground) covers at all four corners are left out, and a skirt runs from the grid's edge out to `reach` m
 * at its edge's heights. `sink`: how far below the ground it lies (under the city's land where they overlap). Null
 * without terrain
 */
function createRegionGround(material, covered, { reach = 30000, sink = 0.6 } = {}) {
  if (!T) return null;
  const G = COARSE;
  const { cols, rows, cell } = G;
  const pos = [], nor = [], uv = [], idx = [];
  const vert = (x, z, y) => {
    const [gx, gz] = slopeAt(x, z, cell);
    _v.set(-gx, 1, -gz).normalize();
    pos.push(x, y, z);
    nor.push(_v.x, _v.y, _v.z);
    uv.push(x / 50, z / 50);
    return pos.length / 3 - 1;
  };
  const id = new Int32Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const x = G.x0 + i * cell, z = G.z0 + j * cell;
    id[j * cols + i] = vert(x, z, G.h[j * cols + i] - sink);
  }
  for (let j = 0; j + 1 < rows; j++) for (let i = 0; i + 1 < cols; i++) {
    const x = G.x0 + i * cell, z = G.z0 + j * cell;
    if (covered(x, z) && covered(x + cell, z) && covered(x, z + cell) && covered(x + cell, z + cell)) continue;
    const a = id[j * cols + i], b = id[j * cols + i + 1], c = id[(j + 1) * cols + i], d = id[(j + 1) * cols + i + 1];
    idx.push(a, c, b, b, c, d);
  }
  // The skirt: each edge point out to `reach` along its side's outward direction
  const ring = [];
  for (let i = 0; i < cols; i++) ring.push([i, 0]);
  for (let j = 1; j < rows; j++) ring.push([cols - 1, j]);
  for (let i = cols - 2; i >= 0; i--) ring.push([i, rows - 1]);
  for (let j = rows - 2; j > 0; j--) ring.push([0, j]);
  const cx = G.x0 + ((cols - 1) * cell) / 2, cz = G.z0 + ((rows - 1) * cell) / 2;
  const outer = ring.map(([i, j]) => {
    const x = G.x0 + i * cell, z = G.z0 + j * cell;
    const s = reach / Math.max(Math.abs(x - cx), Math.abs(z - cz));
    return vert(cx + (x - cx) * s, cz + (z - cz) * s, pos[id[j * cols + i] * 3 + 1]);
  });
  for (let k = 0; k < ring.length; k++) {
    const k1 = (k + 1) % ring.length;
    const a = id[ring[k][1] * cols + ring[k][0]], b = id[ring[k1][1] * cols + ring[k1][0]];
    idx.push(a, b, outer[k], b, outer[k1], outer[k]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'RegionGround';
  mesh.receiveShadow = false; // (the sun's shadow cascades only reach a few hundred metres: beyond them it is noise)
  mesh.userData.terrainBaked = true;
  return mesh;
}

const HAS_TERRAIN = !!T;
export { HAS_TERRAIN, heightAt, slopeAt, terrainHeightNode, deckY, startTerrainBake, bakeTerrain, liftMaterials, collectLights, liftLights, createRegionGround };

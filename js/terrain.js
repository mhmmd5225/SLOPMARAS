import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, vec4, ivec2, uniform, texture, floor, clamp, min, select, positionLocal, modelWorldMatrix, modelWorldMatrixInverse } from 'three/tsl';
import { GEO } from './geodata.js';

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

function decodeGrid(g) {
  const h = new Float32Array(g.cols * g.rows);
  let prev = 0;
  for (let j = 0, k = 0; j < g.rows; j++) {
    let p = prev;
    for (let i = 0; i < g.cols; i++, k++) {
      p += g.data[k];
      h[k] = p / 10;
      if (!i) prev = p;
    }
  }
  return { x0: g.x0, z0: g.z0, cell: g.cell, cols: g.cols, rows: g.rows, x1: g.x0 + (g.cols - 1) * g.cell, z1: g.z0 + (g.rows - 1) * g.cell, h };
}
const FINE = T ? decodeGrid(T.fine) : null;
const COARSE = T ? decodeGrid(T.coarse) : null;

// A grid's height at (x, z): linear over the triangle of the cell it is in, clamped to the grid's edge
function linearAt(G, x, z) {
  const gx = Math.min(Math.max((x - G.x0) / G.cell, 0), G.cols - 1), gz = Math.min(Math.max((z - G.z0) / G.cell, 0), G.rows - 1);
  const i = Math.min(Math.floor(gx), G.cols - 2), j = Math.min(Math.floor(gz), G.rows - 2);
  const tx = gx - i, tz = gz - j, k = j * G.cols + i;
  const h00 = G.h[k], h10 = G.h[k + 1], h01 = G.h[k + G.cols], h11 = G.h[k + G.cols + 1];
  return tx + tz <= 1 ? h00 + (h10 - h00) * tx + (h01 - h00) * tz : h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
}
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

// A growable typed array
class Grow {
  constructor(cap) { this.a = new Float32Array(Math.max(64, cap)); this.n = 0; }
  reserve(k) { if (this.n + k > this.a.length) { const b = new Float32Array(Math.max(this.a.length * 2, this.n + k)); b.set(this.a.subarray(0, this.n)); this.a = b; } }
  view() { return this.a.subarray(0, this.n); }
}

// Sutherland–Hodgman: the part of a convex polygon (vertices: Float32Arrays [x, y, z, ...attributes]) where f(v) >= 0,
// f linear, its new vertices interpolated along the edges it cuts
function clipPolygon(poly, f) {
  const out = [];
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k], b = poly[(k + 1) % poly.length];
    const fa = f(a), fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) {
      const t = fa / (fa - fb), v = new Float32Array(a.length);
      for (let c = 0; c < a.length; c++) v[c] = a[c] + (b[c] - a[c]) * t;
      out.push(v);
    }
  }
  return out;
}

// Cuts a geometry (world positions `world`) along the fine grid's lines and its cells' diagonals, every attribute
// interpolated, groups keeping their ranges: each piece lies over one triangle of the ground, so raising its vertices
// lays it on the ground exactly. Triangles already inside one ground triangle are kept whole. Returns { geometry
// (indexed), world } or null if none is cut
function cutToGrid(geo, world, dropUndersides) {
  const G = FINE;
  const index = geo.index;
  const pos = geo.attributes.position;
  const triCount = (index ? index.count : pos.count) / 3;
  const vtx = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);
  const cell = G.cell;
  // the ground triangle (cell i, j and its half) a point lies in, -1 outside the grid
  const where = (x, z) => {
    const gx = (x - G.x0) / cell, gz = (z - G.z0) / cell;
    if (gx < 0 || gz < 0 || gx > G.cols - 1 || gz > G.rows - 1) return -1;
    const i = Math.min(Math.floor(gx), G.cols - 2), j = Math.min(Math.floor(gz), G.rows - 2);
    return ((j * G.cols + i) << 1) | (gx - i + (gz - j) > 1 ? 1 : 0);
  };
  const same = (t) => {
    const a = vtx(t, 0), b = vtx(t, 1), c = vtx(t, 2);
    const ka = where(world[a * 3], world[a * 3 + 2]);
    return ka >= 0 && ka === where(world[b * 3], world[b * 3 + 2]) && ka === where(world[c * 3], world[c * 3 + 2]);
  };
  // a triangle facing straight down (a slab's underside: nobody sees the ground from below)
  const facesDown = (a, b, c) => {
    const ux = world[b * 3] - world[a * 3], uy = world[b * 3 + 1] - world[a * 3 + 1], uz = world[b * 3 + 2] - world[a * 3 + 2];
    const vx = world[c * 3] - world[a * 3], vy = world[c * 3 + 1] - world[a * 3 + 1], vz = world[c * 3 + 2] - world[a * 3 + 2];
    const ny = uz * vx - ux * vz;
    return ny < -0.9 * Math.hypot(uy * vz - uz * vy, ny, ux * vy - uy * vx);
  };
  let needs = false;
  for (let t = 0; t < triCount && !needs; t++) if (!same(t)) needs = true;
  if (!needs) return null;

  const names = Object.keys(geo.attributes);
  const attrs = names.map((name) => ({ name, s: geo.attributes[name].itemSize, a: readAttribute(geo.attributes[name]), src: geo.attributes[name] }));
  const stride = 3 + attrs.reduce((n, a) => n + a.s, 0);
  const vertexOf = (i) => {
    const v = new Float32Array(stride);
    v[0] = world[i * 3]; v[1] = world[i * 3 + 1]; v[2] = world[i * 3 + 2];
    let o = 3;
    for (const { s, a } of attrs) for (let c = 0; c < s; c++) v[o++] = a[i * s + c];
    return v;
  };
  const out = new Grow(triCount * 3 * stride * 2);
  const emit = (a, b, c) => {
    out.reserve(stride * 3);
    out.a.set(a, out.n); out.a.set(b, out.n + stride); out.a.set(c, out.n + stride * 2);
    out.n += stride * 3;
  };
  // (a source vertex straight into the output)
  const copyVertex = (i) => {
    const d = out.a;
    let o = out.n;
    d[o++] = world[i * 3]; d[o++] = world[i * 3 + 1]; d[o++] = world[i * 3 + 2];
    for (const { s, a } of attrs) for (let c = 0; c < s; c++) d[o++] = a[i * s + c];
    out.n = o;
  };
  const ranges = geo.groups.length ? geo.groups : [{ start: 0, count: triCount * 3, materialIndex: 0 }];
  const groups = [];
  for (const r of ranges) {
    const start = out.n / stride;
    for (let t = r.start / 3; t < (r.start + r.count) / 3; t++) {
      if (dropUndersides && facesDown(vtx(t, 0), vtx(t, 1), vtx(t, 2))) continue;
      if (same(t)) { out.reserve(stride * 3); copyVertex(vtx(t, 0)); copyVertex(vtx(t, 1)); copyVertex(vtx(t, 2)); continue; }
      const tri = [vertexOf(vtx(t, 0)), vertexOf(vtx(t, 1)), vertexOf(vtx(t, 2))];
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const v of tri) { x0 = Math.min(x0, v[0]); x1 = Math.max(x1, v[0]); z0 = Math.min(z0, v[2]); z1 = Math.max(z1, v[2]); }
      const i0 = Math.max(0, Math.floor((x0 - G.x0) / cell)), i1 = Math.min(G.cols - 2, Math.floor((x1 - G.x0) / cell));
      const j0 = Math.max(0, Math.floor((z0 - G.z0) / cell)), j1 = Math.min(G.rows - 2, Math.floor((z1 - G.z0) / cell));
      if (i0 > i1 || j0 > j1) { emit(...tri); continue; } // (beyond the grid: whole)
      for (let j = j0; j <= j1; j++) {
        const cz0 = G.z0 + j * cell, cz1 = cz0 + cell;
        // the cut lines at the grid's outer edges reach past it, so nothing there falls between two cells
        const zLo = j === 0 ? -Infinity : cz0, zHi = j === G.rows - 2 ? Infinity : cz1;
        let row = clipPolygon(clipPolygon(tri, (v) => v[2] - zLo), (v) => zHi - v[2]);
        if (row.length < 3) continue;
        for (let i = i0; i <= i1; i++) {
          const cx0 = G.x0 + i * cell, cx1 = cx0 + cell;
          const xLo = i === 0 ? -Infinity : cx0, xHi = i === G.cols - 2 ? Infinity : cx1;
          const box = clipPolygon(clipPolygon(row, (v) => v[0] - xLo), (v) => xHi - v[0]);
          if (box.length < 3) continue;
          // the cell's diagonal: u + v = 1 in the cell's own (u, v)
          const diag = (v) => 1 - (v[0] - cx0) / cell - (v[2] - cz0) / cell;
          for (const half of [clipPolygon(box, diag), clipPolygon(box, (v) => -diag(v))]) {
            for (let k = 1; k + 1 < half.length; k++) emit(half[0], half[k], half[k + 1]);
          }
        }
      }
    }
    groups.push({ start, count: out.n / stride - start, materialIndex: r.materialIndex });
  }
  // Back to attributes, the pieces' vertices welded (the same position & attributes, to 1 mm / 1e-4: one vertex,
  // indexed), which keeps the cut ground's memory near its triangle count rather than three vertices each
  const n = out.n / stride, data = out.a;
  const Q = (c, v) => Math.round(c < 3 ? v * 1000 : v * 10000);
  let size = 1;
  while (size < n * 2) size <<= 1;
  const table = new Int32Array(size).fill(-1); // open addressing: slot -> unique vertex
  const unique = new Grow(n * stride * 0.5);
  const indices = new Uint32Array(n);
  const key = new Int32Array(stride);
  let count = 0;
  for (let k = 0; k < n; k++) {
    const o = k * stride;
    let h = 0x811c9dc5;
    for (let c = 0; c < stride; c++) { key[c] = Q(c, data[o + c]); h = Math.imul(h ^ key[c], 16777619); }
    let slot = (h >>> 0) & (size - 1), found = -1;
    for (;;) {
      const u = table[slot];
      if (u < 0) break;
      let eq = true;
      for (let c = 0; c < stride && eq; c++) eq = Q(c, unique.a[u * stride + c]) === key[c];
      if (eq) { found = u; break; }
      slot = (slot + 1) & (size - 1);
    }
    if (found < 0) {
      found = count++;
      table[slot] = found;
      unique.reserve(stride);
      unique.a.set(data.subarray(o, o + stride), unique.n);
      unique.n += stride;
    }
    indices[k] = found;
  }
  const u = unique.a;
  const w = new Float32Array(count * 3);
  const result = new THREE.BufferGeometry();
  for (let k = 0; k < count; k++) { w[k * 3] = u[k * stride]; w[k * 3 + 1] = u[k * stride + 1]; w[k * 3 + 2] = u[k * stride + 2]; }
  let off = 3;
  for (const { name, s, src } of attrs) {
    const arr = new Float32Array(count * s);
    for (let k = 0; k < count; k++) for (let c = 0; c < s; c++) arr[k * s + c] = u[k * stride + off + c];
    off += s;
    const Arr = src.array && !src.isInterleavedBufferAttribute ? src.array.constructor : Float32Array;
    result.setAttribute(name, new THREE.BufferAttribute(Arr === Float32Array ? arr : Arr.from(arr), s, src.normalized));
  }
  result.setIndex(new THREE.BufferAttribute(count > 65535 ? indices : Uint16Array.from(indices), 1));
  if (geo.groups.length) for (const g of groups) result.addGroup(g.start, g.count, g.materialIndex);
  return { geometry: result, world: w };
}

// Raises a static mesh's vertices by the ground under each (a ground layer cut along the ground's triangles first):
// up-facing normals tilt with the slope so it is lit as one. Returns how many triangles the cutting added
function bakeMesh(mesh, shared) {
  let geo = mesh.geometry;
  if (!geo || !geo.attributes.position) return 0;
  if (shared.get(geo) > 1) geo = geo.clone(); // (a geometry drawn at several places is baked for each)
  mesh.updateWorldMatrix(true, false);
  _m.copy(mesh.matrixWorld);
  const identity = _m.equals(IDENTITY);
  const pos = geo.attributes.position;
  let world = readAttribute(pos);
  if (!identity) for (let i = 0; i < pos.count; i++) _v.fromArray(world, i * 3).applyMatrix4(_m).toArray(world, i * 3);
  const before = (geo.index ? geo.index.count : pos.count) / 3;
  // The ground layers (the road deck, sidewalks & curbs, lawns, road paint: all within a metre or so of the street)
  // are cut along the ground's triangles so each lies on it exactly; the rest (buildings, roofs) stand on the ground
  // at their corners, raised vertex by vertex. Lines & points are raised point by point
  let lo = Infinity, hi = -Infinity;
  for (let i = 1; i < world.length; i += 3) { lo = Math.min(lo, world[i]); hi = Math.max(hi, world[i]); }
  const ground = mesh.isMesh && lo > -3 && hi < 1.5;
  const material = [].concat(mesh.material)[0];
  const cut = ground ? cutToGrid(geo, world, material && material.side === THREE.FrontSide) : null;
  if (cut) { geo = cut.geometry; world = cut.world; }
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
  return (geo.index ? geo.index.count : p.count) / 3 - before;
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

/**
 * Bakes the ground into the static city under `roots` (once, after it is built and before the culling is set up):
 * meshes cut along the ground's triangles and raised, instances raised whole, lamps raised. Marks each baked object
 * (userData.terrainBaked) so liftMaterials() leaves it be. Returns what it did
 */
function bakeTerrain(roots) {
  const stats = { meshes: 0, instanced: 0, lights: 0, triangles: 0, ms: 0, heavy: [] };
  const triangles = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;
  if (!T) return stats;
  const t0 = performance.now();
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
        const before = triangles(o.geometry);
        const added = bakeMesh(o, shared);
        stats.triangles += added;
        stats.meshes++;
        if (added > 100000) stats.heavy.push(`${o.material?.name || o.material?.type}#${o.material?.color?.getHexString?.()} ${before}->${before + added} tris/${o.geometry.attributes.position.count} verts`);
      } else return;
      o.userData.terrainBaked = true;
    });
  }
  stats.ms = Math.round(performance.now() - t0);
  return stats;
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
export { HAS_TERRAIN, heightAt, slopeAt, terrainHeightNode, deckY, bakeTerrain, liftMaterials, collectLights, liftLights, createRegionGround };

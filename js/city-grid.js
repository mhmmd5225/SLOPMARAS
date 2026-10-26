import * as THREE from 'three/webgpu';
import {
  color,
  uv
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  ISLAND_BOUNDS,
  BLOCKS,
  CITY,
  LAND_REGIONS
} from './city-config.js';
import {
  createRoadSurfaceMaterial,
  createSidewalkMaterial,
  createCurbMaterial,
  createWaterMaterial,
  createParkLawnMaterial,
  createRegionGroundMaterial
} from './tsl-materials.js';
import { GEO } from './geodata.js';
import { createRegionGround } from './terrain.js';

// js/city-grid.js
// Builds the city's ground: the land regions (or the region's terrain), the raised sidewalk and curb blocks, the bridge
// decks carrying streets over water, and the lawns inside the blocks' property lines.

function batchStaticGroupMeshes(rootGroup, excludeMaterials = null) {
  if (!mergeGeometries) return;
  rootGroup.updateMatrixWorld(true);
  const invRoot = new THREE.Matrix4().copy(rootGroup.matrixWorld).invert();
  const buckets = new Map();

  rootGroup.traverse((obj) => {
    if (!obj.isMesh || obj.isInstancedMesh || !obj.geometry || !obj.material) return;
    if (excludeMaterials && excludeMaterials.has(obj.material)) return;
    const attrs = obj.geometry.attributes;
    if (!attrs.position || !attrs.normal || !attrs.uv) return;
    if (!buckets.has(obj.material)) {
      buckets.set(obj.material, []);
    }
    buckets.get(obj.material).push(obj);
  });

  for (const [mat, meshes] of buckets.entries()) {
    if (meshes.length < 2) continue;
    const geos = [];
    let anyCast = false;
    let anyReceive = false;

    for (const m of meshes) {
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      for (const key of Object.keys(g.attributes)) {
        if (key !== 'position' && key !== 'normal' && key !== 'uv') {
          g.deleteAttribute(key);
        }
      }
      const relMat = new THREE.Matrix4().multiplyMatrices(invRoot, m.matrixWorld);
      g.applyMatrix4(relMat);
      geos.push(g);
      if (m.castShadow) anyCast = true;
      if (m.receiveShadow) anyReceive = true;
      if (m.parent) m.parent.remove(m);
    }

    const merged = mergeGeometries(geos, false);
    if (merged) {
      const batchedMesh = new THREE.Mesh(merged, mat);
      batchedMesh.castShadow = anyCast;
      batchedMesh.receiveShadow = anyReceive;
      rootGroup.add(batchedMesh);
    }
  }
}

/**
 * Helper to convert an array of world {x, z} polygon vertices into a horizontal THREE.Shape
 * in (x, -z) space so that rotating by rotateX(-Math.PI / 2) maps (x, -z, 0) -> (x, 0, z)
 * with an upward (+Y) surface normal.
 */
function createWorldXZShape(pts, holes = []) {
  const shape = new THREE.Shape();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i === 0) shape.moveTo(p.x, -p.z);
    else shape.lineTo(p.x, -p.z);
  }
  shape.closePath();
  for (const hole of holes) {
    const path = new THREE.Path();
    hole.forEach((p, i) => (i === 0 ? path.moveTo(p.x, -p.z) : path.lineTo(p.x, -p.z)));
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

// A land region ({ outer, holes }, city-config.js LAND_REGIONS) as a slab from bottomY up `height`, or a flat surface
function createRegionMesh({ outer, holes }, bottomY, height, material) {
  const shape = createWorldXZShape(outer, holes);
  const geo = height > 0 ? new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 1 }) : new THREE.ShapeGeometry(shape, 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, bottomY, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  return mesh;
}

function createExtrudedPolygonMesh(pts, bottomY, height, material, receiveShadow = true, castShadow = false) {
  const shape = createWorldXZShape(pts);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: false,
    curveSegments: 1
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, bottomY, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = receiveShadow;
  mesh.castShadow = castShadow;
  return mesh;
}

function createFlatPolygonMesh(pts, y, material, receiveShadow = true) {
  const shape = createWorldXZShape(pts);
  const geo = new THREE.ShapeGeometry(shape, 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = receiveShadow;
  return mesh;
}

/**
 * Sutherland-Hodgman clip of polygon [{x, z}] to the half-plane nx * x + nz * z >= c.
 */

function offsetPolygonInward(pts, d) {
  const n = pts.length;
  if (n < 3) return null;
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += pts[j].x * pts[i].z - pts[i].x * pts[j].z;
  const s = area > 0 ? 1 : -1; // positive area: the inside lies left of each edge, i.e. along (-dz, dx)
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[(i + n - 1) % n];
    const q = pts[i];
    const r = pts[(i + 1) % n];
    let ax = q.x - p.x, az = q.z - p.z;
    let bx = r.x - q.x, bz = r.z - q.z;
    const la = Math.hypot(ax, az) || 1e-9;
    const lb = Math.hypot(bx, bz) || 1e-9;
    ax /= la; az /= la; bx /= lb; bz /= lb;
    const n1x = -az * s, n1z = ax * s; // inward normals of the two edges
    const n2x = -bz * s, n2z = bx * s;
    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { out.push({ x: q.x + n1x * d, z: q.z + n1z * d }); continue; }
    mx /= ml; mz /= ml;
    const cos = mx * n1x + mz * n1z; // miter length = d / cos(half angle)
    const len = Math.min(3 * d, d / Math.max(1e-3, cos));
    out.push({ x: q.x + mx * len, z: q.z + mz * len });
  }
  let a2 = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a2 += out[j].x * out[i].z - out[i].x * out[j].z;
  return a2 * area > 0 && Math.abs(a2) < Math.abs(area) ? out : null;
}

function pointInPolygonXZ(pts, x, z) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Polygon offset by d (d > 0 inward, d < 0 outward), mitred corners clamped to 3|d|; null if it degenerates */

function buildBlockSidewalks(group, blocks, { sidewalkMat, curbMat, medianHedgeMat }, { addFootprint, skip, cover, outlines = false }) {
  const dummy = new THREE.Object3D();
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const blockSidewalks = []; // { cx, cz, w, d, block } axis-aligned slabs (irregular islands: their lot cover)
  const roadSidewalks = []; // the curbs road-network.js bounds the roads with (medians go in as footprints)
  const slabGeos = [];
  const curbGeos = [];
  const hedgeGeos = [];
  const SW_TOP = 0.22;
  for (const b of blocks) {
    if (skip(b)) continue;
    if (b.rect) {
      const slab = { cx: (b.minX + b.maxX) * 0.5, cz: (b.minZ + b.maxZ) * 0.5, w: b.maxX - b.minX, d: b.maxZ - b.minZ, block: b };
      blockSidewalks.push(slab);
      if (b.median) addFootprint(slab.cx, slab.cz, slab.w, slab.d);
      else roadSidewalks.push({ minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ });
    } else {
      // curb (granite) ring under a sidewalk slab inset by 0.25 m, like the instanced pair below
      const curb = createExtrudedPolygonMesh(b.poly, 0.0, 0.18, curbMat).geometry;
      curbGeos.push(curb);
      const inner = offsetPolygonInward(b.poly, 0.25);
      if (inner) slabGeos.push(createExtrudedPolygonMesh(inner, 0.03, SW_TOP - 0.03, sidewalkMat).geometry);
      // rect cover for the consumers that work on rectangles: the lot rects grown back out to the curb
      for (const [x0, x1, z0, z1] of b.rects) {
        const r = { minX: x0 - cover, maxX: x1 + cover, minZ: z0 - cover, maxZ: z1 + cover };
        blockSidewalks.push({ cx: (r.minX + r.maxX) * 0.5, cz: (r.minZ + r.maxZ) * 0.5, w: r.maxX - r.minX, d: r.maxZ - r.minZ, block: b, cover: true });
        if (!b.median && !outlines) roadSidewalks.push(r);
      }
      if (!b.median && outlines && b.rects.length) roadSidewalks.push({ minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ, poly: b.poly });
      if (b.median) addFootprint((b.minX + b.maxX) * 0.5, (b.minZ + b.maxZ) * 0.5, b.maxX - b.minX, b.maxZ - b.minZ);
    }
    // Planted malls down the middle of Park Ave, Broadway (Upper West Side), Allen St...: a clipped hedge on the slab
    if (b.median && Math.min(b.maxX - b.minX, b.maxZ - b.minZ) > 2.2) {
      const hedge = offsetPolygonInward(b.poly, 1.0);
      if (hedge) hedgeGeos.push(createExtrudedPolygonMesh(hedge, SW_TOP, 0.55, medianHedgeMat).geometry);
    }
  }
  const mergeInto = (geos, mat, cast = false) => {
    for (let i = 0; i < geos.length; i += 400) {
      const m = new THREE.Mesh(mergeGeometries(geos.slice(i, i + 400), false), mat);
      m.receiveShadow = true;
      m.castShadow = cast;
      group.add(m);
    }
  };
  mergeInto(curbGeos, curbMat, true);
  mergeInto(slabGeos, sidewalkMat);
  mergeInto(hedgeGeos, medianHedgeMat, true);

  const rectSlabs = blockSidewalks.filter((s) => !s.cover);
  const swInstanced = new THREE.InstancedMesh(unitBox, sidewalkMat, rectSlabs.length);
  const curbInstanced = new THREE.InstancedMesh(unitBox, curbMat, rectSlabs.length);
  swInstanced.receiveShadow = true;
  curbInstanced.receiveShadow = true;
  curbInstanced.castShadow = true;

  rectSlabs.forEach((blk, i) => {
    dummy.rotation.set(0, 0, 0);
    dummy.position.set(blk.cx, 0.125, blk.cz);
    dummy.scale.set(blk.w - 0.5, 0.19, blk.d - 0.5);
    dummy.updateMatrix();
    swInstanced.setMatrixAt(i, dummy.matrix);

    dummy.position.set(blk.cx, 0.095, blk.cz);
    dummy.scale.set(blk.w, 0.17, blk.d);
    dummy.updateMatrix();
    curbInstanced.setMatrixAt(i, dummy.matrix);
  });
  swInstanced.instanceMatrix.needsUpdate = true;
  curbInstanced.instanceMatrix.needsUpdate = true;
  group.add(swInstanced, curbInstanced);
  return { blockSidewalks, roadSidewalks };
}

function buildCityGrid(scene) {
  const group = new THREE.Group();
  group.name = 'CityGrid';
  const footprints = [];
  const addFootprint = (x, z, w, d) => footprints.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });

  const waterMat = createWaterMaterial();
  // A city with its ground's heights (terrain.js) stands among the region's hills and mountains instead of on the sea:
  // their ground runs from the edge of the city's land out to the horizon
  const regionGround = createRegionGround(createRegionGroundMaterial(), (x, z) => LAND_REGIONS.some((r) => pointInPolygonXZ(r.outer, x, z)));
  if (regionGround) {
    group.add(regionGround);
  } else {
    const waterGeo = new THREE.PlaneGeometry(60000, 60000, 1, 1);
    waterGeo.rotateX(-Math.PI / 2);
    const water = new THREE.Mesh(waterGeo, waterMat);
    water.position.set(0, ISLAND_BOUNDS.waterLevel, 0);
    group.add(water);
  }

  const seawallMat = new THREE.MeshStandardNodeMaterial({ color: 0x5c5a55, roughness: 0.82, metalness: 0.1 });
  const roadMat = createRoadSurfaceMaterial();
  for (const region of LAND_REGIONS) {
    if (!regionGround) group.add(createRegionMesh(region, -2.35, 2.31, seawallMat)); // (the seawall: none inland)
    group.add(createRegionMesh(region, 0.0, 0, roadMat));
  }

  const sidewalkMat = createSidewalkMaterial();
  const curbMat = createCurbMaterial();
  const medianHedgeMat = new THREE.MeshStandardNodeMaterial({ color: 0x366e3b, roughness: 0.82 });
  const sidewalk = GEO.frame.sidewalk || 4.6;
  const { blockSidewalks, roadSidewalks } = buildBlockSidewalks(group, BLOCKS, { sidewalkMat, curbMat, medianHedgeMat }, {
    addFootprint,
    skip: () => false,
    cover: sidewalk - 0.2,
    outlines: true
  });
  // Bridges carrying streets across the water at grade (open-city-config.js: the street graph's links flagged over
  // water): a concrete deck under the roadway with a parapet along each edge, segment by segment
  const deckMat = new THREE.MeshStandardNodeMaterial({ color: 0x8a8780, roughness: 0.8, metalness: 0.05 });
  const deckGeos = [];
  const RG = GEO.roadGraph;
  const deckBox = (ax, az, bx, bz, w, y0, h, side) => {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.5) return;
    const ux = (bx - ax) / len, uz = (bz - az) / len;
    const g = new THREE.BoxGeometry(len + (side ? 0 : w), h, side ? 0.35 : w);
    g.rotateY(-Math.atan2(uz, ux));
    g.translate((ax + bx) / 2 - uz * side, y0 + h / 2, (az + bz) / 2 + ux * side);
    deckGeos.push(g);
  };
  for (const l of RG.links) {
    if (l[9] !== 1) continue;
    const pts = [[RG.nodes[l[0] * 2], RG.nodes[l[0] * 2 + 1]]];
    for (let k = 0; k < l[6].length; k += 2) pts.push([l[6][k], l[6][k + 1]]);
    pts.push([RG.nodes[l[1] * 2], RG.nodes[l[1] * 2 + 1]]);
    const w = l[3] + 3; // the roadway and a walk each side
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
      deckBox(ax, az, bx, bz, w, -1.1, 1.08, 0);
      for (const side of [-w / 2, w / 2]) deckBox(ax, az, bx, bz, w, -0.02, 1.1, side);
    }
  }
  if (deckGeos.length) {
    const deck = new THREE.Mesh(mergeGeometries(deckGeos, false), deckMat);
    deck.receiveShadow = deck.castShadow = true;
    group.add(deck);
  }

  // Lawn over the sidewalk slab inside every block's property line (GEO.lawns, traced by tools/city/build.mjs: the
  // ground the buildings and the trees stand on)
  const lawnMat = createParkLawnMaterial(false);
  const lawnGeos = [];
  const L = GEO.lawns || [];
  for (let i = 0, fx = 0, fz = 0; i < L.length;) {
    const n = L[i++];
    const ring = [];
    let px = fx, pz = fz;
    for (let k = 0; k < n; k++) {
      px += L[i++];
      pz += L[i++];
      ring.push({ x: px / 10, z: pz / 10 });
      if (!k) { fx = px; fz = pz; }
    }
    lawnGeos.push(createFlatPolygonMesh(ring, 0.235, lawnMat).geometry);
  }
  for (let i = 0; i < lawnGeos.length; i += 400) {
    const m = new THREE.Mesh(mergeGeometries(lawnGeos.slice(i, i + 400), false), lawnMat);
    m.receiveShadow = true;
    group.add(m);
  }

  batchStaticGroupMeshes(group, new Set([waterMat, roadMat, lawnMat]));
  scene.add(group);
  console.info(`[cityGrid] ${CITY.name}: ${LAND_REGIONS.length} land masses, ${BLOCKS.length} blocks, ${lawnGeos.length} lawns, ${deckGeos.length / 3} bridge deck segments`);
  return { group, sidewalks: roadSidewalks, footprints, highwayLanes: [], colliders: [] };
}

export { buildCityGrid, batchStaticGroupMeshes };

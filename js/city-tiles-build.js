// js/city-tiles-build.js
// One island tile's geometry as plain typed arrays (tools/city/tiles.mjs writes the tiles), with no three.js: run in
// js/city-tiles-worker.js so building a tile never stalls a frame, or on the main thread where workers aren't available.
// buildTileArrays(tile) -> { walls, roofs, roads } each { position, normal, uv?, color?, sphere: [x, y, z, r] } or null,
// positions relative to the tile's corner. Their arrays are transferable.

// Building colours by type: Singapore's HDB estates in their painted pastels, factories in grey and blue steel
const PASTELS = [0xf2efe6, 0xefe6d2, 0xdfe9ef, 0xe5efdf, 0xf3e2d4, 0xe9e1ee, 0xf4f1ea, 0xd9e4e8, 0xf0dccb];
const INDUSTRIAL = [0xb8bcc0, 0xa6b2bd, 0xc6c6be, 0x9aa7b3];
const CONCRETE = [0xd2cec4, 0xc8c3b8, 0xdcd8cf, 0xbfbab0];
const HOME = new Set(['residential', 'apartments', 'house', 'terrace', 'detached', 'semidetached_house', 'dormitory', 'bungalow']);
const WORKS = new Set(['industrial', 'warehouse', 'factory', 'manufacture', 'hangar', 'storage_tank']);

const hash = (a, b) => {
  const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return s - Math.floor(s);
};
// sRGB hex -> linear rgb (what THREE.Color.setHex gives with colour management on)
const toLinear = (c) => (c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4));
const rgb = (hex) => [toLinear(((hex >> 16) & 255) / 255), toLinear(((hex >> 8) & 255) / 255), toLinear((hex & 255) / 255)];

// Buildings [rings=1, top dm, bottom dm, type, n, dx dz (dm)...]: [{ top, bottom, type, pts: Float32Array x, z }]
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

// Ear-clipping triangulation of a simple polygon (flat x, z), any winding: [i0, i1, i2, ...]. Footprints are small
// (tens of points), so O(n²) is fine; a polygon it can't clip (self-touching) falls back to a fan.
function triangulate(pts) {
  const n = pts.length / 2;
  if (n < 3) return [];
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += pts[j * 2] * pts[i * 2 + 1] - pts[i * 2] * pts[j * 2 + 1];
  const sign = area > 0 ? 1 : -1;
  const idx = Array.from({ length: n }, (_, i) => i);
  const out = [];
  const X = (i) => pts[i * 2], Z = (i) => pts[i * 2 + 1];
  const cross = (a, b, c) => ((X(b) - X(a)) * (Z(c) - Z(a)) - (Z(b) - Z(a)) * (X(c) - X(a))) * sign;
  const inside = (p, a, b, c) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = n * n;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const a = idx[(k + idx.length - 1) % idx.length], b = idx[k], c = idx[(k + 1) % idx.length];
      if (cross(a, b, c) <= 1e-9) continue; // reflex or flat
      let ear = true;
      for (const p of idx) if (p !== a && p !== b && p !== c && inside(p, a, b, c)) { ear = false; break; }
      if (!ear) continue;
      out.push(a, b, c);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  else for (let k = 1; k + 1 < idx.length; k++) out.push(idx[0], idx[k], idx[k + 1]);
  return out;
}

function sphereOf(position) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < position.length; i += 3) {
    const x = position[i], y = position[i + 1], z = position[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2];
}

// A triangle on the ground (y), wound to face up
function upTri(out, p, q, r, y) {
  const cy = (q[1] - p[1]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[1] - p[1]);
  if (cy < 0) [q, r] = [r, q];
  out.push(p[0], y, p[1], q[0], y, q[1], r[0], y, r[1]);
}

function buildTileArrays(tile) {
  const walls = { pos: [], nrm: [], uv: [], col: [] };
  const roofs = { pos: [], col: [] };
  for (const b of decodeBuildings(tile.buildings)) {
    const pts = b.pts;
    const n = pts.length / 2;
    const r = hash(pts[0], pts[1]);
    const palette = HOME.has(b.type) ? PASTELS : WORKS.has(b.type) ? INDUSTRIAL : CONCRETE;
    const [cr, cg, cb] = rgb(palette[Math.floor(r * palette.length)]);
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
        for (let v = 0; v < 6; v++) { walls.nrm.push(nx, 0, nz); walls.col.push(cr, cg, cb); }
        const u0 = along, u1 = along + len;
        walls.uv.push(u0, b.bottom, u1, b.bottom, u1, b.top, u0, b.bottom, u1, b.top, u0, b.top);
        along = u1;
      }
    }
    // roof, a little darker, facing up
    const shade = 0.72 + r * 0.18;
    const tris = triangulate(pts);
    for (let t = 0; t < tris.length; t += 3) {
      const p0 = [pts[tris[t] * 2], pts[tris[t] * 2 + 1]];
      const p1 = [pts[tris[t + 1] * 2], pts[tris[t + 1] * 2 + 1]];
      const p2 = [pts[tris[t + 2] * 2], pts[tris[t + 2] * 2 + 1]];
      upTri(roofs.pos, p0, p1, p2, b.top);
      for (let v = 0; v < 3; v++) roofs.col.push(cr * shade, cg * shade, cb * shade);
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
  const up = (count) => {
    const a = new Float32Array(count * 3);
    for (let i = 1; i < a.length; i += 3) a[i] = 1;
    return a;
  };
  const pack = (pos, extra) => {
    if (!pos.length) return null;
    const position = new Float32Array(pos);
    return { position, sphere: sphereOf(position), ...extra(position.length / 3) };
  };
  return {
    walls: pack(walls.pos, () => ({ normal: new Float32Array(walls.nrm), uv: new Float32Array(walls.uv), color: new Float32Array(walls.col) })),
    roofs: pack(roofs.pos, (count) => ({ normal: up(count), color: new Float32Array(roofs.col) })),
    roads: pack(roads, (count) => ({ normal: up(count) })),
    counts: { walls: walls.pos.length / 18, roofs: roofs.pos.length / 9, roads: roads.length / 18 }
  };
}

// The typed arrays of a built tile, to transfer to the main thread rather than copy
function transferables(built) {
  const list = [];
  for (const part of [built.walls, built.roofs, built.roads]) {
    if (!part) continue;
    for (const k of ['position', 'normal', 'uv', 'color']) if (part[k]) list.push(part[k].buffer);
  }
  return list;
}

export { buildTileArrays, decodeBuildings, triangulate, transferables };

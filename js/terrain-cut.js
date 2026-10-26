// js/terrain-cut.js
// The ground's grids and the cutting of the static city's ground layers along them, without three.js, for terrain.js
// and its workers (terrain-worker.js) alike: a grid's heights (decodeGrid, linearAt, groundAt), and a triangle soup
// cut along the fine grid's lines and its cells' diagonals, welded and laid on the ground (cutSoup, raiseVertices).

/** A GEO.terrain grid decoded: { x0, z0, cell, cols, rows, x1, z1, h (m) } */
export function decodeGrid(g) {
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

// A grid's height at (x, z): linear over the triangle of the cell it is in, clamped to the grid's edge
export function linearAt(G, x, z) {
  const gx = Math.min(Math.max((x - G.x0) / G.cell, 0), G.cols - 1), gz = Math.min(Math.max((z - G.z0) / G.cell, 0), G.rows - 1);
  const i = Math.min(Math.floor(gx), G.cols - 2), j = Math.min(Math.floor(gz), G.rows - 2);
  const tx = gx - i, tz = gz - j, k = j * G.cols + i;
  const h00 = G.h[k], h10 = G.h[k + 1], h01 = G.h[k + G.cols], h11 = G.h[k + G.cols + 1];
  return tx + tz <= 1 ? h00 + (h10 - h00) * tx + (h01 - h00) * tz : h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
}

/** The ground's height at (x, z): the fine grid's inside it, the coarse one's beyond */
export function groundAt(F, C, x, z) {
  return x >= F.x0 && x <= F.x1 && z >= F.z0 && z <= F.z1 ? linearAt(F, x, z) : linearAt(C, x, z);
}

// A growable typed array
class Grow {
  constructor(cap) { this.a = new Float32Array(Math.max(64, cap)); this.n = 0; }
  reserve(k) { if (this.n + k > this.a.length) { const b = new Float32Array(Math.max(this.a.length * 2, this.n + k)); b.set(this.a.subarray(0, this.n)); this.a = b; } }
}

// Sutherland–Hodgman on flat buffers: the part of a convex polygon (n vertices of `stride` floats, [x, y, z, ...
// attributes], in src) where a·x + b·z + c >= 0, written to dst with its new vertices interpolated along the edges it
// cuts. Returns the vertex count of the result (< 3: nothing left). No allocation: the buffers are reused
function clipInto(src, n, dst, stride, a, b, c) {
  let m = 0;
  let pf = a * src[(n - 1) * stride] + b * src[(n - 1) * stride + 2] + c;
  for (let k = 0, p = n - 1; k < n; p = k++) {
    const o = k * stride, q = p * stride;
    const f = a * src[o] + b * src[o + 2] + c;
    if ((f >= 0) !== (pf >= 0)) {
      const t = pf / (pf - f), d = m++ * stride;
      for (let i = 0; i < stride; i++) dst[d + i] = src[q + i] + (src[o + i] - src[q + i]) * t;
    }
    if (f >= 0) { const d = m++ * stride; for (let i = 0; i < stride; i++) dst[d + i] = src[o + i]; }
    pf = f;
  }
  return m;
}

/** The ground triangle (cell i, j and its half) a point lies in on grid G, -1 outside it */
export function groundTriangle(G, x, z) {
  const gx = (x - G.x0) / G.cell, gz = (z - G.z0) / G.cell;
  if (gx < 0 || gz < 0 || gx > G.cols - 1 || gz > G.rows - 1) return -1;
  const i = Math.min(Math.floor(gx), G.cols - 2), j = Math.min(Math.floor(gz), G.rows - 2);
  return ((j * G.cols + i) << 1) | (gx - i + (gz - j) > 1 ? 1 : 0);
}

/**
 * Cuts a triangle soup (`soup`: three vertices of `stride` floats per triangle, [x, y, z (world), ...attributes]) along
 * the fine grid F's lines and its cells' diagonals, every attribute interpolated: each piece lies over one triangle of
 * the ground, so raising its vertices lays it on the ground exactly. Triangles already inside one ground triangle are
 * kept whole; with `dropUndersides`, those facing straight down (a slab's underside: nobody sees the ground from below)
 * are dropped. The pieces' vertices are welded as they are made (the same position & attributes, to 1 mm / 1e-4: one
 * vertex, indexed). Returns { unique (count × stride floats), count, indices }
 */
export function cutSoup(F, soup, stride, dropUndersides) {
  const G = F, cell = G.cell;
  const triCount = soup.length / (stride * 3);
  const bufs = Array.from({ length: 6 }, () => new Float32Array(stride * 24));
  // Positions are quantised to 1 mm, the rest to 1e-4, once per vertex into `key`, kept for each unique one; an
  // open-addressing table maps them to the unique vertices, doubling as it fills
  const unique = new Grow(triCount * stride * 2);
  let ukeys = new Int32Array(Math.max(64, triCount * stride * 2));
  let indices = new Uint32Array(Math.max(64, triCount * 6)), emitted = 0;
  let size = 1 << 12;
  while (size < triCount * 4) size <<= 1;
  let mask = size - 1;
  let table = new Int32Array(size).fill(-1);
  const key = new Int32Array(stride);
  let count = 0;
  const hashOf = (k, o) => {
    let h = 0x811c9dc5;
    for (let c = 0; c < stride; c++) h = Math.imul(h ^ k[o + c], 16777619);
    return (h ^ (h >>> 15)) & mask;
  };
  const grow = () => {
    size <<= 1;
    mask = size - 1;
    table = new Int32Array(size).fill(-1);
    for (let u = 0; u < count; u++) {
      let slot = hashOf(ukeys, u * stride);
      while (table[slot] >= 0) slot = (slot + 1) & mask;
      table[slot] = u;
    }
  };
  // One vertex (stride floats of `src` from `o`) into the output: its unique vertex's index
  const emit = (src, o) => {
    for (let c = 0; c < 3; c++) key[c] = Math.round(src[o + c] * 1000);
    for (let c = 3; c < stride; c++) key[c] = Math.round(src[o + c] * 10000);
    let slot = hashOf(key, 0), found = -1;
    for (;;) {
      const u = table[slot];
      if (u < 0) break;
      const uo = u * stride;
      let c = 0;
      while (c < stride && ukeys[uo + c] === key[c]) c++;
      if (c === stride) { found = u; break; }
      slot = (slot + 1) & mask;
    }
    if (found < 0) {
      found = count++;
      table[slot] = found;
      unique.reserve(stride);
      unique.a.set(src.subarray(o, o + stride), unique.n);
      unique.n += stride;
      if (unique.n > ukeys.length) { const g = new Int32Array(ukeys.length * 2); g.set(ukeys); ukeys = g; }
      ukeys.set(key, found * stride);
      if (count * 2 > size) grow();
    }
    if (emitted === indices.length) { const g = new Uint32Array(indices.length * 2); g.set(indices); indices = g; }
    indices[emitted++] = found;
  };
  for (let t = 0; t < triCount; t++) {
    const o0 = t * 3 * stride, o1 = o0 + stride, o2 = o1 + stride;
    if (dropUndersides) {
      const ux = soup[o1] - soup[o0], uy = soup[o1 + 1] - soup[o0 + 1], uz = soup[o1 + 2] - soup[o0 + 2];
      const vx = soup[o2] - soup[o0], vy = soup[o2 + 1] - soup[o0 + 1], vz = soup[o2 + 2] - soup[o0 + 2];
      const ny = uz * vx - ux * vz;
      if (ny < -0.9 * Math.hypot(uy * vz - uz * vy, ny, ux * vy - uy * vx)) continue;
    }
    const ka = groundTriangle(G, soup[o0], soup[o0 + 2]);
    if (ka >= 0 && ka === groundTriangle(G, soup[o1], soup[o1 + 2]) && ka === groundTriangle(G, soup[o2], soup[o2 + 2])) {
      emit(soup, o0); emit(soup, o1); emit(soup, o2);
      continue;
    }
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const o of [o0, o1, o2]) { const x = soup[o], z = soup[o + 2]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const i0 = Math.max(0, Math.floor((x0 - G.x0) / cell)), i1 = Math.min(G.cols - 2, Math.floor((x1 - G.x0) / cell));
    const j0 = Math.max(0, Math.floor((z0 - G.z0) / cell)), j1 = Math.min(G.rows - 2, Math.floor((z1 - G.z0) / cell));
    if (i0 > i1 || j0 > j1) { emit(soup, o0); emit(soup, o1); emit(soup, o2); continue; } // (beyond the grid: whole)
    // (bufs: 0 the triangle, 1-2 a row between its z cuts, 3-4 a cell between its x cuts, 5 a half)
    bufs[0].set(soup.subarray(o0, o0 + stride * 3));
    for (let j = j0; j <= j1; j++) {
      const cz0 = G.z0 + j * cell;
      // the cut lines at the grid's outer edges reach past it, so nothing there falls between two cells
      let n = 3, src = bufs[0], dst = bufs[1];
      if (j > 0) { n = clipInto(src, n, dst, stride, 0, 1, -cz0); src = dst; dst = bufs[2]; }
      if (n >= 3 && j < G.rows - 2) { n = clipInto(src, n, dst, stride, 0, -1, cz0 + cell); src = dst; }
      if (n < 3) continue;
      const row = src, rowN = n;
      let rx0 = Infinity, rx1 = -Infinity;
      for (let k = 0; k < rowN; k++) { const x = row[k * stride]; if (x < rx0) rx0 = x; if (x > rx1) rx1 = x; }
      for (let i = i0; i <= i1; i++) {
        const cx0 = G.x0 + i * cell;
        let m = rowN, s2 = row, d2 = bufs[3];
        if (i > 0 && rx0 < cx0) { m = clipInto(s2, m, d2, stride, 1, 0, -cx0); s2 = d2; d2 = bufs[4]; }
        if (m >= 3 && i < G.cols - 2 && rx1 > cx0 + cell) { m = clipInto(s2, m, d2, stride, -1, 0, cx0 + cell); s2 = d2; }
        if (m < 3) continue;
        // the cell's diagonal: u + v = 1 in the cell's own (u, v); f > 0 on the lower-left half. A polygon wholly on
        // one side is kept as it is
        const dc = 1 + cx0 / cell + cz0 / cell;
        let lo = false, hi = false;
        for (let k = 0; k < m; k++) {
          const f = dc - (s2[k * stride] + s2[k * stride + 2]) / cell;
          if (f > 1e-6) lo = true; else if (f < -1e-6) hi = true;
        }
        for (let side = 0; side < 2; side++) {
          if (side === 0 ? !lo && hi : !hi && lo) continue; // (nothing on this side)
          let h, hb;
          if (side === 0 ? !hi : !lo) { h = m; hb = s2; } // (all of it is on this side)
          else { const sg = side === 0 ? 1 : -1; h = clipInto(s2, m, bufs[5], stride, -sg / cell, -sg / cell, sg * dc); hb = bufs[5]; }
          for (let k = 1; k + 1 < h; k++) { emit(hb, 0); emit(hb, k * stride); emit(hb, (k + 1) * stride); }
        }
      }
    }
  }
  return { unique: unique.a.slice(0, count * stride), count, indices: indices.slice(0, emitted) };
}

/**
 * Lays vertices (count × stride floats, world positions first) on the ground: each raised by the ground's height under
 * it, and, with `normalOffset` ≥ 0, an up-facing normal there (y > 0.7) tilted with the ground's slope across a cell,
 * so the surface is lit as one with the ground
 */
export function raiseVertices(F, C, data, count, stride, normalOffset = -1) {
  const d = F.cell;
  for (let k = 0; k < count; k++) {
    const o = k * stride, x = data[o], z = data[o + 2];
    data[o + 1] += groundAt(F, C, x, z);
    if (normalOffset < 0) continue;
    const n = o + normalOffset, ny = data[n + 1];
    if (!(ny > 0.7)) continue;
    const gx = (groundAt(F, C, x + d, z) - groundAt(F, C, x - d, z)) / (2 * d);
    const gz = (groundAt(F, C, x, z + d) - groundAt(F, C, x, z - d)) / (2 * d);
    const nx = data[n] - gx * ny, nz = data[n + 2] - gz * ny, l = Math.hypot(nx, ny, nz);
    data[n] = nx / l; data[n + 1] = ny / l; data[n + 2] = nz / l;
  }
}

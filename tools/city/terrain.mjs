// tools/city/terrain.mjs — a city's ground heights (config.terrain): AWS's public Terrarium elevation tiles
// (https://registry.opendata.aws/terrain-tiles/, PNGs whose red, green & blue spell metres: r·256 + g + b/256 − 32768)
// downloaded by tools/city/fetch.mjs, and baked by tools/city/build.mjs into two grids in the world frame: a fine one
// under the city (its fetched box) and a coarse one over the country around it (config.terrain.region), the
// mountains on the horizon. Heights are metres above the origin's ground, so the city's origin stays at y = 0.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const URL_OF = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const tileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const tileY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

// The tiles covering [south, west, north, east] at zoom z: [[x, y]]
function tilesOver([s, w, n, e], z) {
  const out = [];
  for (let x = Math.floor(tileX(w, z)); x <= Math.floor(tileX(e, z)); x++) {
    for (let y = Math.floor(tileY(n, z)); y <= Math.floor(tileY(s, z)); y++) out.push([x, y]);
  }
  return out;
}

// The two layers a config's terrain fetches: the city's box (detail grown by margin) and the region around it
function layers(city) {
  const t = city.terrain;
  const [s, w, n, e] = city.detail;
  const m = city.margin + 0.002;
  return [
    { name: 'city', box: [s - m, w - m, n + m, e + m], zoom: t.zoom || 14 },
    { name: 'region', box: t.region, zoom: t.regionZoom || 12 }
  ];
}

const tileFile = (dir, z, x, y) => path.join(dir, 'terrain', `${z}_${x}_${y}.png`);

// Downloads the tiles a city's terrain needs into <dir>/terrain/ (keeping those already there unless `force`)
export async function fetchTerrain(city, dir, { force = false } = {}) {
  fs.mkdirSync(path.join(dir, 'terrain'), { recursive: true });
  let got = 0, had = 0;
  for (const { box, zoom } of layers(city)) {
    for (const [x, y] of tilesOver(box, zoom)) {
      const file = tileFile(dir, zoom, x, y);
      if (fs.existsSync(file) && !force) { had++; continue; }
      let r;
      for (let tries = 0; tries < 4; tries++) {
        try { r = await fetch(URL_OF(zoom, x, y)); if (r.ok) break; } catch { r = null; }
        await new Promise((res) => setTimeout(res, 1000 * (tries + 1)));
      }
      if (!r || !r.ok) throw new Error(`terrain tile ${zoom}/${x}/${y}: ${r ? `HTTP ${r.status}` : 'no response'}`);
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      got++;
    }
  }
  return { got, had };
}

// An 8-bit RGB or RGBA, non-interlaced PNG: { w, h, bpp, data }
function decodePNG(buf) {
  let p = 8, w = 0, h = 0, bpp = 3;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = d.readUInt32BE(0);
      h = d.readUInt32BE(4);
      if (d[8] !== 8 || d[12] !== 0 || (d[9] !== 2 && d[9] !== 6)) throw new Error('unsupported PNG (8-bit RGB/RGBA only)');
      bpp = d[9] === 6 ? 4 : 3;
    }
    if (type === 'IDAT') idat.push(d);
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[row + x - bpp] : 0;
      const b = y ? out[row - stride + x] : 0;
      const c = x >= bpp && y ? out[row - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[row + x] = v & 255;
    }
  }
  return { w, h, bpp, data: out };
}

// Elevation (m) at any lon / lat inside a layer's tiles: bilinear between the pixels' centres
function makeSampler(dir, zoom) {
  const tiles = new Map();
  const tile = (x, y) => {
    const key = `${x},${y}`;
    if (!tiles.has(key)) {
      const file = tileFile(dir, zoom, x, y);
      if (!fs.existsSync(file)) throw new Error(`missing ${file}: run node tools/city/fetch.mjs <city>`);
      const png = decodePNG(fs.readFileSync(file));
      const m = new Float32Array(png.w * png.h);
      for (let i = 0; i < m.length; i++) {
        const o = i * png.bpp;
        m[i] = png.data[o] * 256 + png.data[o + 1] + png.data[o + 2] / 256 - 32768;
      }
      tiles.set(key, { m, w: png.w });
    }
    return tiles.get(key);
  };
  const pixel = (px, py) => {
    const t = tile(Math.floor(px / 256), Math.floor(py / 256));
    return t.m[(py & 255) * t.w + (px & 255)];
  };
  return (lon, lat) => {
    const fx = tileX(lon, zoom) * 256 - 0.5, fy = tileY(lat, zoom) * 256 - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const a = pixel(x0, y0), b = pixel(x0 + 1, y0), c = pixel(x0, y0 + 1), d = pixel(x0 + 1, y0 + 1);
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
}

// Separable Gaussian blur of a cols × rows grid (σ in cells), edges clamped
function blur(v, cols, rows, sigma) {
  if (!(sigma > 0)) return v;
  const r = Math.ceil(sigma * 3);
  const k = [];
  let sum = 0;
  for (let i = -r; i <= r; i++) { const w = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(w); sum += w; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(v.length), out = new Float32Array(v.length);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    let s = 0;
    for (let o = -r; o <= r; o++) s += k[o + r] * v[j * cols + Math.min(cols - 1, Math.max(0, i + o))];
    tmp[j * cols + i] = s;
  }
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    let s = 0;
    for (let o = -r; o <= r; o++) s += k[o + r] * tmp[Math.min(rows - 1, Math.max(0, j + o)) * cols + i];
    out[j * cols + i] = s;
  }
  return out;
}

// One grid over a world box: heights sampled at its points (x0 + i·cell, z0 + j·cell), less `base`, blurred (σ in m)
function sampleGrid(sample, frame, { x0, z0, x1, z1 }, cell, base, sigmaM) {
  const cols = Math.ceil((x1 - x0) / cell) + 1, rows = Math.ceil((z1 - z0) / cell) + 1;
  const v = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const [lon, lat] = frame.toLonLat(x0 + i * cell, z0 + j * cell);
    v[j * cols + i] = sample(lon, lat) - base;
  }
  return { x0, z0, cell, cols, rows, v: blur(v, cols, rows, sigmaM / cell) };
}

// A grid's height at (x, z) as js/terrain.js draws it: linear over each cell's two triangles (split along the diagonal
// from its (i + 1, j) corner to its (i, j + 1) one), clamped to the grid's edge
function linearAt(G, x, z) {
  const gx = Math.min(Math.max((x - G.x0) / G.cell, 0), G.cols - 1), gz = Math.min(Math.max((z - G.z0) / G.cell, 0), G.rows - 1);
  const i = Math.min(Math.floor(gx), G.cols - 2), j = Math.min(Math.floor(gz), G.rows - 2);
  const tx = gx - i, tz = gz - j, k = j * G.cols + i;
  const h00 = G.v[k], h10 = G.v[k + 1], h01 = G.v[k + G.cols], h11 = G.v[k + G.cols + 1];
  return tx + tz <= 1 ? h00 + (h10 - h00) * tx + (h01 - h00) * tz : h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
}

// A grid for GEO.terrain: decimetres delta-coded along the rows (each row starts from the previous row's first value)
function encodeGrid({ x0, z0, cell, cols, rows, v }) {
  const data = new Array(v.length);
  let prev = 0, min = Infinity, max = -Infinity;
  for (let j = 0; j < rows; j++) {
    let p = prev;
    for (let i = 0; i < cols; i++) {
      const h = v[j * cols + i];
      min = Math.min(min, h);
      max = Math.max(max, h);
      const q = Math.round(h * 10);
      data[j * cols + i] = q - p;
      p = q;
      if (!i) prev = q;
    }
  }
  return { x0, z0, cell, cols, rows, min: Math.round(min * 10) / 10, max: Math.round(max * 10) / 10, data };
}

// GEO.terrain: { base (m above sea at the origin), source, blend, fine, coarse } in the world frame. `fetchedBox`: the
// city's fetched box in world coordinates ({ x0, z0, x1, z1 }), which the fine grid covers. The fine grid eases into
// the coarse one over its last `blend` metres, so the two meet without a step where the city's ground ends
export function bakeTerrain(city, dir, frame, fetchedBox, log = console.log) {
  const t = city.terrain;
  const [cityLayer, regionLayer] = layers(city);
  const fineSample = makeSampler(dir, cityLayer.zoom);
  const coarseSample = makeSampler(dir, regionLayer.zoom);
  const base = fineSample(city.origin.lon, city.origin.lat);
  // The region's box in the world frame (inside its corners), on the coarse grid's lines
  const [s, w, n, e] = regionLayer.box;
  const [sw, se, nw, ne] = [[w, s], [e, s], [w, n], [e, n]].map(([lon, lat]) => frame.toWorld(lon, lat));
  const rc = t.regionCell || 100;
  const rb = {
    x0: Math.ceil(Math.max(sw[0], nw[0]) / rc) * rc, x1: Math.floor(Math.min(se[0], ne[0]) / rc) * rc,
    z0: Math.ceil(Math.max(nw[1], ne[1]) / rc) * rc, z1: Math.floor(Math.min(sw[1], se[1]) / rc) * rc
  };
  const coarse = sampleGrid(coarseSample, frame, rb, rc, base, t.regionSmooth ?? 60);
  const cell = t.cell || 20;
  const fb = { x0: Math.floor(fetchedBox.x0 / cell) * cell, z0: Math.floor(fetchedBox.z0 / cell) * cell, x1: fetchedBox.x1, z1: fetchedBox.z1 };
  const fine = sampleGrid(fineSample, frame, fb, cell, base, t.smooth ?? 20);
  const blend = t.blend || 300;
  const xe = fine.x0 + (fine.cols - 1) * cell, ze = fine.z0 + (fine.rows - 1) * cell;
  for (let j = 0; j < fine.rows; j++) for (let i = 0; i < fine.cols; i++) {
    const x = fine.x0 + i * cell, z = fine.z0 + j * cell;
    const d = Math.min(x - fine.x0, xe - x, z - fine.z0, ze - z);
    const u = Math.min(Math.max(d / blend, 0), 1), wgt = u * u * (3 - 2 * u);
    const c = linearAt(coarse, x, z);
    fine.v[j * fine.cols + i] = c + (fine.v[j * fine.cols + i] - c) * wgt;
  }
  const F = encodeGrid(fine), C = encodeGrid(coarse);
  log(`terrain: ${base.toFixed(1)} m at the origin; city ${F.cols}×${F.rows} @ ${cell} m (${F.min}..${F.max} m), region ${C.cols}×${C.rows} @ ${rc} m (${C.min}..${C.max} m)`);
  return { base: Math.round(base * 10) / 10, source: 'AWS Terrain Tiles (Terrarium)', blend, fine: F, coarse: C };
}

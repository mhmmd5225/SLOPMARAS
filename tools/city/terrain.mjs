// tools/city/terrain.mjs — a city's ground heights (config.terrain), downloaded by tools/city/fetch.mjs from one of
// - Copernicus GLO-30 (source: 'copernicus'; https://registry.opendata.aws/copernicus-dem/): 1° Cloud-Optimized GeoTIFFs
//   of float32 metres at 1″ (~30 m), TanDEM-X 2011-2015
// - AWS's Terrarium tiles (the default; https://registry.opendata.aws/terrain-tiles/, PNGs whose red, green & blue spell
//   metres: r·256 + g + b/256 − 32768; SRTM here)
// and baked by tools/city/build.mjs into two grids in the world frame: a fine one under the city (its fetched box) and
// a coarse one over the country around it (config.terrain.region), the mountains on the horizon. Both sources are
// surface models (the tops of buildings and trees): under the city its mapped buildings are cut out of it and the
// ground under them filled in from around (groundFrom). Heights are metres above the origin's ground, so the city's
// origin stays at y = 0.
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

// Copernicus GLO-30's 1° tiles, named by their south-west corner: Copernicus_DSM_COG_10_N37_00_E036_00_DEM
const copName = (lat, lon) => `Copernicus_DSM_COG_10_${lat < 0 ? 'S' : 'N'}${String(Math.abs(lat)).padStart(2, '0')}_00_${lon < 0 ? 'W' : 'E'}${String(Math.abs(lon)).padStart(3, '0')}_00_DEM`;
const COP_URL = (name) => `https://copernicus-dem-30m.s3.amazonaws.com/${name}/${name}.tif`;
const copFile = (dir, name) => path.join(dir, 'copdem', `${name}.tif`);
// The 1° tiles covering [south, west, north, east]: [[lat, lon]] of their south-west corners
function degreesOver([s, w, n, e]) {
  const out = [];
  for (let lat = Math.floor(s); lat <= Math.floor(n); lat++) for (let lon = Math.floor(w); lon <= Math.floor(e); lon++) out.push([lat, lon]);
  return out;
}

async function download(url, file) {
  let r;
  for (let tries = 0; tries < 4; tries++) {
    try { r = await fetch(url); if (r.ok) break; } catch { r = null; }
    await new Promise((res) => setTimeout(res, 1000 * (tries + 1)));
  }
  if (!r || !r.ok) throw new Error(`${url}: ${r ? `HTTP ${r.status}` : 'no response'}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

// Downloads the tiles a city's terrain needs into <dir>/copdem/ or <dir>/terrain/ (keeping those already there unless
// `force`)
export async function fetchTerrain(city, dir, { force = false } = {}) {
  let got = 0, had = 0;
  if (city.terrain.source === 'copernicus') {
    fs.mkdirSync(path.join(dir, 'copdem'), { recursive: true });
    const names = new Set(layers(city).flatMap(({ box }) => degreesOver(box).map(([lat, lon]) => copName(lat, lon))));
    for (const name of names) {
      const file = copFile(dir, name);
      if (fs.existsSync(file) && !force) { had++; continue; }
      await download(COP_URL(name), file);
      got++;
    }
    return { got, had };
  }
  fs.mkdirSync(path.join(dir, 'terrain'), { recursive: true });
  for (const { box, zoom } of layers(city)) {
    for (const [x, y] of tilesOver(box, zoom)) {
      const file = tileFile(dir, zoom, x, y);
      if (fs.existsSync(file) && !force) { had++; continue; }
      await download(URL_OF(zoom, x, y), file);
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

// A tiled, single-band float32 GeoTIFF (Copernicus GLO-30's: DEFLATE, predictor 1 or 3): { w, h, at(px, py) } with its
// tiles inflated as they are first read, and its georeferencing: lon / lat of pixel (px, py)'s centre are
// lon0 + px·dx, lat0 − py·dy
export function decodeTIFF(buf) {
  const le = buf.toString('ascii', 0, 2) === 'II';
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const f64 = (o) => (le ? buf.readDoubleLE(o) : buf.readDoubleBE(o));
  if (u16(2) !== 42) throw new Error('not a classic TIFF');
  const ifd = u32(4);
  const tags = new Map();
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 12: 8, 16: 8 };
  for (let i = 0, n = u16(ifd); i < n; i++) {
    const e = ifd + 2 + i * 12;
    const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
    const at = count * SIZE[type] > 4 ? u32(e + 8) : e + 8;
    const read = (k) => (type === 3 ? u16(at + k * 2) : type === 4 ? u32(at + k * 4) : type === 12 ? f64(at + k * 8) : buf[at + k]);
    tags.set(tag, Array.from({ length: count }, (_, k) => read(k)));
  }
  const one = (t, d) => (tags.has(t) ? tags.get(t)[0] : d);
  const w = one(256), h = one(257), tw = one(322), th = one(323);
  const compression = one(259, 1), predictor = one(317, 1);
  if (one(258) !== 32 || one(339, 1) !== 3 || one(277, 1) !== 1) throw new Error('unsupported TIFF (single-band float32 only)');
  if (!tw || !th) throw new Error('unsupported TIFF (tiled only)');
  if (compression !== 8 && compression !== 32946) throw new Error(`unsupported TIFF compression ${compression}`);
  if (predictor !== 1 && predictor !== 3) throw new Error(`unsupported TIFF predictor ${predictor}`);
  const offsets = tags.get(324), counts = tags.get(325);
  const across = Math.ceil(w / tw);
  // GTRasterTypeGeoKey (1025): 1 the tie point is a pixel's corner (PixelIsArea, the default), 2 its centre
  const keys = tags.get(34735) || [];
  let rasterType = 1;
  for (let k = 4; k + 3 < keys.length; k += 4) if (keys[k] === 1025) rasterType = keys[k + 3];
  const [sx, sy] = tags.get(33550) || [1, 1];
  const tie = tags.get(33922) || [0, 0, 0, 0, 0, 0];
  const half = rasterType === 2 ? 0 : 0.5;
  const geo = { lon0: tie[3] + (half - tie[0]) * sx, lat0: tie[4] - (half - tie[1]) * sy, dx: sx, dy: sy };
  const tiles = new Map();
  const tile = (k) => {
    if (tiles.has(k)) return tiles.get(k);
    const raw = zlib.inflateSync(buf.subarray(offsets[k], offsets[k] + counts[k]));
    const out = new Float32Array(tw * th);
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    if (predictor === 3) {
      // Floating-point predictor: each row's bytes differenced, the samples' bytes split into planes (most significant
      // first, whatever the file's byte order)
      for (let y = 0; y < th; y++) {
        const row = y * tw * 4;
        for (let i = 1; i < tw * 4; i++) raw[row + i] = (raw[row + i] + raw[row + i - 1]) & 255;
        const b = Buffer.alloc(4);
        for (let x = 0; x < tw; x++) {
          b[0] = raw[row + x]; b[1] = raw[row + tw + x]; b[2] = raw[row + 2 * tw + x]; b[3] = raw[row + 3 * tw + x];
          out[y * tw + x] = b.readFloatBE(0);
        }
      }
    } else {
      for (let i = 0; i < tw * th; i++) out[i] = dv.getFloat32(i * 4, le);
    }
    tiles.set(k, out);
    return out;
  };
  const at = (px, py) => {
    px = Math.min(Math.max(px, 0), w - 1);
    py = Math.min(Math.max(py, 0), h - 1);
    return tile(Math.floor(py / th) * across + Math.floor(px / tw))[(py % th) * tw + (px % tw)];
  };
  return { w, h, at, ...geo };
}

// Elevation (m) at any lon / lat over Copernicus GLO-30's tiles: bilinear between the pixels' centres (a tile's first
// pixels are centred on its degree lines, so the last column and row of a tile meet the next one's first)
function makeCopernicusSampler(dir) {
  const tiles = new Map();
  const tileOf = (lat, lon) => {
    const name = copName(lat, lon);
    if (!tiles.has(name)) {
      const file = copFile(dir, name);
      if (!fs.existsSync(file)) throw new Error(`missing ${file}: run node tools/city/fetch.mjs <city>`);
      tiles.set(name, decodeTIFF(fs.readFileSync(file)));
    }
    return tiles.get(name);
  };
  return (lon, lat) => {
    const t = tileOf(Math.floor(lat), Math.floor(lon));
    const fx = (lon - t.lon0) / t.dx, fy = (t.lat0 - lat) / t.dy;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const a = t.at(x0, y0), b = t.at(x0 + 1, y0), c = t.at(x0, y0 + 1), d = t.at(x0 + 1, y0 + 1);
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

// Separable square min (or max) filter of a cols × rows grid, `r` cells each way, edges clamped
function rankFilter(v, cols, rows, r, max) {
  if (!(r > 0)) return v;
  const pick = max ? Math.max : Math.min;
  const tmp = new Float32Array(v.length), out = new Float32Array(v.length);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    let m = v[j * cols + i];
    for (let o = -r; o <= r; o++) m = pick(m, v[j * cols + Math.min(cols - 1, Math.max(0, i + o))]);
    tmp[j * cols + i] = m;
  }
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    let m = tmp[j * cols + i];
    for (let o = -r; o <= r; o++) m = pick(m, tmp[Math.min(rows - 1, Math.max(0, j + o)) * cols + i]);
    out[j * cols + i] = m;
  }
  return out;
}

// The bare ground of a surface model over a world box, on a grid of `cell` m (x0 + i·cell, z0 + j·cell), less `base`:
// sampled every `step` m (a whole fraction of the cell), the mapped buildings (`footprints`: rings of [x, z], grown by
// `dilate` m) cut out and filled in from the ground around them, what the map lacks (unmapped buildings, the trees)
// pared off by an opening `open` m wide each way (a min, then a max filter: the ground's own folds wider than it keep
// their shape), and blurred (σ in m)
export function groundFrom(sample, frame, { x0, z0, x1, z1 }, cell, base, { footprints = [], step = 10, dilate = 6, open = 30, sigma = 8 } = {}) {
  const k = Math.max(1, Math.round(cell / step));
  step = cell / k;
  const cols = (Math.ceil((x1 - x0) / cell) * k) + 1, rows = (Math.ceil((z1 - z0) / cell) * k) + 1;
  let v = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const [lon, lat] = frame.toLonLat(x0 + i * step, z0 + j * step);
    v[j * cols + i] = sample(lon, lat) - base;
  }
  // The footprints' cells (scanlines through each ring at the cells' centres), grown by `dilate`
  let mask = new Uint8Array(cols * rows);
  for (const ring of footprints) {
    let zmin = Infinity, zmax = -Infinity;
    for (const [, z] of ring) { zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); }
    for (let j = Math.max(0, Math.ceil((zmin - z0) / step)); j <= Math.min(rows - 1, Math.floor((zmax - z0) / step)); j++) {
      const z = z0 + j * step;
      const xs = [];
      for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
        const [ax, az] = ring[a], [bx, bz] = ring[b];
        if ((az > z) !== (bz > z)) xs.push(ax + ((z - az) * (bx - ax)) / (bz - az));
      }
      xs.sort((p, q) => p - q);
      for (let n = 0; n + 1 < xs.length; n += 2) {
        for (let i = Math.max(0, Math.ceil((xs[n] - x0) / step)); i <= Math.min(cols - 1, Math.floor((xs[n + 1] - x0) / step)); i++) mask[j * cols + i] = 1;
      }
    }
  }
  const grow = Math.round(dilate / step);
  if (grow > 0) {
    const m = rankFilter(Float32Array.from(mask), cols, rows, grow, true);
    mask = Uint8Array.from(m, (x) => (x > 0 ? 1 : 0));
  }
  // Fill the cut-out cells from the ground around them: coarser and coarser averages of the cells kept (a pyramid),
  // then each cut-out cell from the finest level that reaches it, relaxed into its neighbours
  const known = Uint8Array.from(mask, (m) => 1 - m);
  if (known.some((x) => x) && mask.some((x) => x)) {
    const levels = [{ cols, rows, v: Float32Array.from(v, (h, i) => (known[i] ? h : 0)), wgt: Float32Array.from(known) }];
    while (levels.at(-1).cols > 2 || levels.at(-1).rows > 2) {
      const L = levels.at(-1);
      const c = Math.ceil(L.cols / 2), r = Math.ceil(L.rows / 2);
      const nv = new Float32Array(c * r), nw = new Float32Array(c * r);
      for (let j = 0; j < L.rows; j++) for (let i = 0; i < L.cols; i++) {
        const q = (j >> 1) * c + (i >> 1);
        nv[q] += L.v[j * L.cols + i];
        nw[q] += L.wgt[j * L.cols + i];
      }
      levels.push({ cols: c, rows: r, v: nv, wgt: nw });
    }
    const valueAt = (i, j) => {
      for (let l = 0; l < levels.length; l++) {
        const L = levels[l], q = (j >> l) * L.cols + (i >> l);
        if (L.wgt[q] > 0) return L.v[q] / L.wgt[q];
      }
      return 0;
    };
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) if (mask[j * cols + i]) v[j * cols + i] = valueAt(i, j);
    for (let pass = 0; pass < 40; pass++) {
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        if (!mask[j * cols + i]) continue;
        let s = 0, n = 0;
        if (i > 0) { s += v[j * cols + i - 1]; n++; }
        if (i < cols - 1) { s += v[j * cols + i + 1]; n++; }
        if (j > 0) { s += v[(j - 1) * cols + i]; n++; }
        if (j < rows - 1) { s += v[(j + 1) * cols + i]; n++; }
        v[j * cols + i] = s / n;
      }
    }
  }
  const r = Math.round(open / step);
  v = rankFilter(rankFilter(v, cols, rows, r, false), cols, rows, r, true);
  v = blur(v, cols, rows, sigma / step);
  // Every k-th sample: the cell's grid
  const gc = (cols - 1) / k + 1, gr = (rows - 1) / k + 1;
  const out = new Float32Array(gc * gr);
  for (let j = 0; j < gr; j++) for (let i = 0; i < gc; i++) out[j * gc + i] = v[j * k * cols + i * k];
  return { x0, z0, cell, cols: gc, rows: gr, v: out, cut: mask.reduce((n, m) => n + m, 0) / mask.length };
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
// the coarse one over its last `blend` metres, so the two meet without a step where the city's ground ends.
// `footprints`: the rings ([x, z]) of the buildings standing on the ground, cut out of the city's surface model where
// config.terrain.ground asks for the bare ground ({ dilate, open } m: see groundFrom)
export function bakeTerrain(city, dir, frame, fetchedBox, log = console.log, { footprints = [] } = {}) {
  const t = city.terrain;
  const [cityLayer, regionLayer] = layers(city);
  const copernicus = t.source === 'copernicus';
  const fineSample = copernicus ? makeCopernicusSampler(dir) : makeSampler(dir, cityLayer.zoom);
  const coarseSample = copernicus ? fineSample : makeSampler(dir, regionLayer.zoom);
  const cell = t.cell || 20;
  const fb = { x0: Math.floor(fetchedBox.x0 / cell) * cell, z0: Math.floor(fetchedBox.z0 / cell) * cell, x1: fetchedBox.x1, z1: fetchedBox.z1 };
  // The origin's ground: the bare ground's there, where the surface model's buildings are cut out
  let base = fineSample(city.origin.lon, city.origin.lat);
  let fine;
  if (t.ground) {
    const g = { footprints, sigma: t.smooth ?? 8, ...t.ground };
    fine = groundFrom(fineSample, frame, fb, cell, 0, g);
    base = linearAt(fine, 0, 0);
    for (let i = 0; i < fine.v.length; i++) fine.v[i] -= base;
    log(`terrain: ${(fine.cut * 100).toFixed(0)}% of the city's ground under its ${footprints.length} buildings cut out of the surface model`);
  }
  // The region's box in the world frame (inside its corners), on the coarse grid's lines
  const [s, w, n, e] = regionLayer.box;
  const [sw, se, nw, ne] = [[w, s], [e, s], [w, n], [e, n]].map(([lon, lat]) => frame.toWorld(lon, lat));
  const rc = t.regionCell || 100;
  const rb = {
    x0: Math.ceil(Math.max(sw[0], nw[0]) / rc) * rc, x1: Math.floor(Math.min(se[0], ne[0]) / rc) * rc,
    z0: Math.ceil(Math.max(nw[1], ne[1]) / rc) * rc, z1: Math.floor(Math.min(sw[1], se[1]) / rc) * rc
  };
  const coarse = sampleGrid(coarseSample, frame, rb, rc, base, t.regionSmooth ?? 60);
  if (!fine) fine = sampleGrid(fineSample, frame, fb, cell, base, t.smooth ?? 20);
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
  return { base: Math.round(base * 10) / 10, source: copernicus ? 'Copernicus GLO-30 DEM' : 'AWS Terrain Tiles (Terrarium)', blend, fine: F, coarse: C };
}

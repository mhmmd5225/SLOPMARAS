// tools/city/fetch.mjs — downloads a city's OpenStreetMap layers from Overpass (tools/overpass.sh), and its trees where
// its config names a tree inventory, into tools/data/<city>/
// usage: node tools/city/fetch.mjs <city> [--force]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCity, dataDir } from './config.mjs';

// The Overpass queries of a city's layers, over its detail box grown by its margin
export function queries(city) {
  const [s, w, n, e] = city.detail;
  const m = city.margin;
  const bb = `(${s - m},${w - m},${n + m},${e + m})`;
  const area = (filter) => `way${filter}${bb};relation${filter}${bb};`;
  return {
    roads: `[out:json][timeout:240];way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian)(_link)?$"]${bb};out geom;`,
    coast: `[out:json][timeout:180];way["natural"="coastline"]${bb};out geom;`,
    water: `[out:json][timeout:180];(${area('["natural"="water"]')}${area('["waterway"="riverbank"]')}${area('["landuse"~"^(reservoir|basin)$"]')});out geom;`,
    parks: `[out:json][timeout:180];(${area('["leisure"~"^(park|garden|nature_reserve|common)$"]')}${area('["landuse"="recreation_ground"]')});out geom;`,
    buildings: `[out:json][timeout:300];(${area('["building"]')}${area('["building:part"]')});out geom;`,
    // road pricing gantries, speed & red light cameras
    enforcement: `[out:json][timeout:180];(node["highway"~"^(toll_gantry|speed_camera)$"]${bb};way["highway"="toll_gantry"]${bb};node["enforcement"]${bb};relation["type"="enforcement"]${bb};);out geom;`
  };
}

// The city's trees inside its detail box grown by its margin, as CSV: lng, lat, height (m), family. From
// cheeaun/sgtreesdata's trees.csv (id, tree_id, species_id, girth, girth_size, height, height_est, age, lng, lat) and its
// families-species.json ({ family: [species ids] })
export async function fetchTrees(city, dir) {
  if (city.trees.source === 'osm') return fetchOsmTrees(city, dir);
  if (city.trees.source !== 'sgtreesdata') throw new Error(`unknown tree source ${city.trees.source}`);
  const get = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.text();
  };
  const familyOf = new Map();
  for (const [family, ids] of Object.entries(JSON.parse(await get(city.trees.families)))) for (const id of ids) familyOf.set(String(id), family);
  const [s, w, n, e] = city.detail;
  const m = city.margin;
  const lines = (await get(city.trees.url)).split('\n');
  const col = Object.fromEntries(lines[0].split(',').map((k, i) => [k.trim(), i]));
  const out = ['lng,lat,height,family'];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    const lng = parseFloat(f[col.lng]), lat = parseFloat(f[col.lat]);
    if (!(lat > s - m && lat < n + m && lng > w - m && lng < e + m)) continue;
    const family = (familyOf.get(f[col.species_id]) || '').replace(/"/g, '');
    out.push(`${lng},${lat},${parseFloat(f[col.height_est]) || 0},"${family}"`);
  }
  if (out.length < 2) throw new Error('no trees inside the box');
  return out.join('\n') + '\n';
}

// A city without a tree inventory (trees.source 'osm'): OpenStreetMap's mapped trees, a tree every ~8 m along its tree
// rows, and trees scattered over its parks & gardens (one per trees.parkSpacing² m² on average, at stable places), as the
// same CSV with heights of 8-14 m and no family (the config's base shape)
function fetchOsmTrees(city, dir) {
  const [s, w, n, e] = city.detail;
  const m = city.margin;
  const bb = `(${s - m},${w - m},${n + m},${e + m})`;
  const q = path.join(dir, 'q_trees.overpassql');
  const raw = path.join(dir, 'osm_trees.json');
  fs.writeFileSync(q, `[out:json][timeout:180];(node["natural"="tree"]${bb};way["natural"="tree_row"]${bb};way["leisure"~"^(park|garden)$"]${bb};way["landuse"~"^(village_green|grass)$"]["name"]${bb};);out geom;\n`);
  if (!fs.existsSync(raw)) {
    const r = spawnSync('bash', [fileURLToPath(new URL('../overpass.sh', import.meta.url)), raw, q, '4'], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('overpass failed');
  }
  const els = JSON.parse(fs.readFileSync(raw, 'utf8')).elements;
  const lat0 = (s + n) / 2;
  const mLat = 111320, mLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  // a stable pseudo-random number in [0, 1) for an integer pair
  const hash = (a, b) => {
    let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
  };
  const out = ['lng,lat,height,family'];
  const add = (lon, lat, k) => {
    if (lat > s - m && lat < n + m && lon > w - m && lon < e + m) out.push(`${lon.toFixed(7)},${lat.toFixed(7)},${(8 + hash(k, 7) * 6).toFixed(1)},""`);
  };
  let mapped = 0, rows = 0, parks = 0;
  for (const el of els) {
    const t = el.tags || {};
    if (el.type === 'node') { add(el.lon, el.lat, el.id); mapped++; continue; }
    const g = el.geometry || [];
    if (t.natural === 'tree_row') {
      for (let i = 0; i + 1 < g.length; i++) {
        const L = Math.hypot((g[i + 1].lon - g[i].lon) * mLon, (g[i + 1].lat - g[i].lat) * mLat);
        for (let d = 0; d < L; d += 8) { const f = d / L; add(g[i].lon + (g[i + 1].lon - g[i].lon) * f, g[i].lat + (g[i + 1].lat - g[i].lat) * f, el.id + i * 977 + d); rows++; }
      }
      continue;
    }
    // a park: a jittered lattice over its outline
    if (g.length < 4) continue;
    const step = city.trees.parkSpacing || 14;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const P = g.map((p) => [p.lon * mLon, p.lat * mLat]);
    for (const [x, y] of P) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const inside = (x, y) => {
      let c = false;
      for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
        const [ax, ay] = P[i], [bx, by] = P[j];
        if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) c = !c;
      }
      return c;
    };
    for (let i = Math.floor(x0 / step); i <= Math.ceil(x1 / step); i++) {
      for (let j = Math.floor(y0 / step); j <= Math.ceil(y1 / step); j++) {
        if (hash(i, j) > 0.55) continue; // gaps for the lawns & paths
        const x = (i + hash(j, i)) * step, y = (j + hash(i + 31, j)) * step;
        if (inside(x, y)) { add(x / mLon, y / mLat, i * 7919 + j); parks++; }
      }
    }
  }
  console.log(`[fetch] trees: ${mapped} mapped, ${rows} along tree rows, ${parks} scattered over parks`);
  if (out.length < 2) throw new Error('no trees inside the box');
  return out.join('\n') + '\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const city = await loadCity(process.argv[2]);
  const force = process.argv.includes('--force');
  const dir = dataDir(city);
  fs.mkdirSync(dir, { recursive: true });
  const overpass = fileURLToPath(new URL('../overpass.sh', import.meta.url));
  let failed = 0;
  if (city.trees) {
    const out = path.join(dir, 'trees.csv');
    if (fs.existsSync(out) && !force) console.log(`[fetch] trees: have ${out}`);
    else {
      console.log(`[fetch] trees from ${city.trees.url || city.trees.source} ...`);
      try { fs.writeFileSync(out, await fetchTrees(city, dir)); console.log(`[fetch] trees: wrote ${out}`); } catch (e) { console.error(`[fetch] trees: ${e.message}`); failed++; }
    }
  }
  for (const [layer, ql] of Object.entries(queries(city))) {
    const q = path.join(dir, `q_${layer}.overpassql`);
    const out = path.join(dir, `osm_${layer}.json`);
    fs.writeFileSync(q, ql + '\n');
    if (fs.existsSync(out) && !force) { console.log(`[fetch] ${layer}: have ${out}`); continue; }
    console.log(`[fetch] ${layer} ...`);
    const r = spawnSync('bash', [overpass, out, q, '4'], { stdio: 'inherit' });
    if (r.status !== 0) failed++;
  }
  process.exit(failed ? 1 : 0);
}

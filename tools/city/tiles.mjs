// tools/city/tiles.mjs — the rest of a city's island beyond its detailed area, as tiles streamed around the player
// (js/city-tiles.js): OpenStreetMap's buildings and main roads cut into square tiles of the world frame, and the whole
// island's land, from tools/city/fetch-island.mjs's downloads.
// usage: node --max-old-space-size=8192 tools/city/tiles.mjs <city>
//
// Output: tiles/<city>/index.json { version, tile (m), frame, core: [x0, z0, x1, z1] (the detailed area the tiles leave
//   out), land: [[outer, ...holes] flat x, z (m)], tiles: [{ i, j, file, buildings, roads, top }] } and per tile
//   tiles/<city>/<i>_<j>.json {
//     buildings: { types, data } as GEO.buildings (tools/city/build.mjs; outer rings only), relative to the tile's corner,
//     roads: [class, width (dm), points..., dx dz (dm) from the point before (the first from the tile's corner)] runs
//   }
// and tiles/<city>/roads.json, the island's main roads for the maps (js/city-map.js), outside the detailed area:
//   { classes, names, roads: [[class, name index or -1, x0, z0, then each point's dx dz (m) from the one before]] }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCity, dataDir } from './config.mjs';
import { makeFrame } from './frame.mjs';
import { bbox, centroid, pointInRing, rdp, rdpRing, ringArea } from './geom.mjs';
import { areaPolygons, areaRings, coastLand, num, traceRegions, yes as yesTag } from './osm.mjs';

const log = (...a) => console.log('[tiles]', ...a);
export const ROAD_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'];
const ROAD_WIDTH = { motorway: 22, trunk: 18, primary: 14, secondary: 11, tertiary: 8 }; // m, both carriageways
const LINK_WIDTH = 6;

// Storeys of an island building without heights, by type (Singapore's housing estates are mostly 12-16 storey HDB slabs)
const TYPICAL = {
  house: 2, detached: 2, semidetached_house: 2, terrace: 2, bungalow: 2, garage: 1, garages: 1, shed: 1, hut: 1, kiosk: 1,
  roof: 1, service: 1, toilets: 1, residential: 12, apartments: 14, dormitory: 6, hotel: 10, commercial: 4, retail: 3,
  office: 8, industrial: 3, warehouse: 3, factory: 3, school: 4, university: 4, college: 4, hospital: 7, temple: 2, church: 2,
  mosque: 2, parking: 6, public: 3, civic: 3, government: 4, train_station: 2, transportation: 2, yes: 3
};
const LEVEL = 3.2;

export async function buildTiles(cityOrId, { data, out, geo } = {}) {
  const city = typeof cityOrId === 'string' ? await loadCity(cityOrId) : cityOrId;
  if (!city.island) throw new Error(`${city.id} has no island box`);
  const dir = data || path.join(dataDir(city), 'island');
  const outDir = out || fileURLToPath(new URL(`../../tiles/${city.id}/`, import.meta.url));
  // the same frame as the city's geodata (its bearing as built)
  const GEO = geo || (await import(new URL(`../../js/${city.id}-geodata.js`, import.meta.url).href)).GEO;
  const frame = makeFrame({ lat0: GEO.frame.lat0, lon0: GEO.frame.lon0, theta: (GEO.frame.bearingDeg * Math.PI) / 180 });
  const { toWorld } = frame;
  const T = city.island.tile || 1500;

  // The detailed area (the detail box grown by its margin, as tools/city/build.mjs fetched it): the tiles leave it out
  const [S, W, N, E] = city.detail;
  const m = city.margin;
  const coreRing = [toWorld(W - m, N + m), toWorld(E + m, N + m), toWorld(E + m, S - m), toWorld(W - m, S - m)];
  const inCore = (x, z) => pointInRing(x, z, coreRing);

  // --- Downloads, each element once -------------------------------------------------------------------------------------
  const seen = new Set();
  const buildingsOSM = [];
  const roadsOSM = [];
  const files = fs.readdirSync(dir).filter((f) => /^cell_.*\.json$/.test(f));
  for (const f of files) {
    for (const e of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).elements) {
      const key = `${e.type}${e.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const t = e.tags || {};
      if (t.highway) roadsOSM.push(e);
      else if (t.building || t['building:part']) buildingsOSM.push(e);
    }
  }
  const coastOSM = JSON.parse(fs.readFileSync(path.join(dir, 'coast.json'), 'utf8')).elements;
  const waterOSM = JSON.parse(fs.readFileSync(path.join(dir, 'water.json'), 'utf8')).elements;
  log(`${files.length} cells: ${buildingsOSM.length} buildings & parts, ${roadsOSM.length} main roads; ${coastOSM.length} coastline ways, ${waterOSM.length} water areas`);

  // --- Land: the island box at 8 m, less its reservoirs & lakes ---------------------------------------------------------
  const [IS, IW, IN, IE] = city.island.box;
  const islandRing = [toWorld(IW, IN), toWorld(IE, IN), toWorld(IE, IS), toWorld(IW, IS)];
  const land = coastLand(coastOSM, toWorld, islandRing, 8);
  for (const e of waterOSM) {
    const t = e.tags || {};
    if (yesTag(t.covered) || yesTag(t.tunnel)) continue;
    for (const ring of areaRings(e, toWorld, 20000)) land.fillRing(ring, 0);
  }
  const landAt = (x, z) => {
    const i = Math.floor((x - land.x0) / land.res), j = Math.floor((z - land.z0) / land.res);
    return i >= 0 && j >= 0 && i < land.w && j < land.h && land.d[j * land.w + i] === 1;
  };
  const regions = traceRegions(land, 40000, 6);
  const q = (v) => Math.round(v);
  const flat = (pts) => pts.flatMap(([x, z]) => [q(x), q(z)]);
  log(`land: ${regions.length} outlines (${regions.reduce((n, r) => n + r.outer.length, 0)} points), ${regions.reduce((n, r) => n + r.holes.length, 0)} lakes & reservoirs`);

  // --- Buildings ---------------------------------------------------------------------------------------------------------
  const tiles = new Map(); // "i,j" -> { buildings: [], roads: [] }
  const tileOf = (x, z) => {
    const i = Math.floor(x / T), j = Math.floor(z / T);
    const k = `${i},${j}`;
    if (!tiles.has(k)) tiles.set(k, { i, j, buildings: [], roads: [] });
    return tiles.get(k);
  };
  const items = [];
  for (const e of buildingsOSM) {
    const t = e.tags || {};
    const part = !t.building && !!t['building:part'];
    if (t.building === 'no' || t['building:part'] === 'no') continue;
    for (const { outer } of areaPolygons(e, toWorld, 12)) {
      const o = rdpRing(outer, 0.6);
      if (o.length < 3) continue;
      const [cx, cz] = centroid(o);
      if (inCore(cx, cz) || !landAt(cx, cz)) continue;
      if (ringArea(o) > 0) o.reverse();
      const type = t.building && t.building !== 'yes' ? t.building : t['building:part'] && t['building:part'] !== 'yes' ? t['building:part'] : 'yes';
      let top = num(t.height) > 0 ? num(t.height) : num(t['building:levels']) > 0 ? num(t['building:levels']) * LEVEL : (TYPICAL[type] || 3) * LEVEL;
      let bottom = num(t.min_height) > 0 ? num(t.min_height) : num(t['building:min_level']) > 0 ? num(t['building:min_level']) * LEVEL : 0;
      if (type === 'roof') { bottom = Math.max(bottom, top - 0.6, 2.6); top = Math.max(top, bottom + 0.4); }
      if (top - bottom < 0.3) continue;
      items.push({ part, type, outer: o, cx, cz, top, bottom });
    }
  }
  // outlines drawn by their parts (as tools/city/build.mjs)
  const CELL = 64;
  const partCells = new Map();
  for (const p of items) if (p.part) { const k = `${Math.floor(p.cx / CELL)},${Math.floor(p.cz / CELL)}`; if (!partCells.has(k)) partCells.set(k, []); partCells.get(k).push(p); }
  let byParts = 0;
  for (const b of items) {
    if (!b.part) {
      const bb = bbox(b.outer);
      let drawn = false;
      for (let i = Math.floor(bb.x0 / CELL); i <= Math.floor(bb.x1 / CELL) && !drawn; i++) {
        for (let j = Math.floor(bb.z0 / CELL); j <= Math.floor(bb.z1 / CELL) && !drawn; j++) {
          for (const p of partCells.get(`${i},${j}`) || []) if (p.bottom < 1 && pointInRing(p.cx, p.cz, b.outer)) { drawn = true; break; }
        }
      }
      if (drawn) { byParts++; continue; }
    }
    tileOf(b.cx, b.cz).buildings.push(b);
  }

  // --- Main roads, clipped to the tile each segment starts in -------------------------------------------------------
  let roadRuns = 0;
  for (const e of roadsOSM) {
    const t = e.tags || {};
    const link = /_link$/.test(t.highway);
    const cls = t.highway.replace(/_link$/, '');
    const ci = ROAD_CLASSES.indexOf(cls);
    if (ci < 0 || !e.geometry || yesTag(t.tunnel) || t.area === 'yes') continue;
    const width = num(t.width) > 0 ? num(t.width) : link ? LINK_WIDTH : (ROAD_WIDTH[cls] * (t.oneway === 'yes' ? 0.55 : 1));
    // (long straight segments cut every 250 m, so each piece is drawn with the tile it lies in)
    const pts = [];
    for (const p of rdp(e.geometry.map((g) => toWorld(g.lon, g.lat)), 1.5)) {
      const last = pts[pts.length - 1];
      if (last) {
        const n = Math.ceil(Math.hypot(p[0] - last[0], p[1] - last[1]) / 250);
        for (let s = 1; s < n; s++) pts.push([last[0] + ((p[0] - last[0]) * s) / n, last[1] + ((p[1] - last[1]) * s) / n]);
      }
      pts.push(p);
    }
    // split into runs by tile (each run keeps the next point so the ribbons join) & leave the core out
    let run = null;
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
      if (inCore(ax, az) && inCore(bx, bz)) { run = null; continue; }
      const tile = tileOf(ax, az);
      if (!run || run.tile !== tile) {
        run = { tile, cls: ci, width, level: num(t.layer) > 0 || yesTag(t.bridge) ? 1 : 0, pts: [[ax, az]] };
        tile.roads.push(run);
        roadRuns++;
      }
      run.pts.push([bx, bz]);
    }
  }
  log(`${items.length - byParts} buildings in tiles (${byParts} outlines drawn by their parts), ${roadRuns} road runs`);

  // --- The maps' road layer: every main road beyond the detailed area (tunnels too), simplified to 4 m ---------------
  const mapNames = [];
  const nameIndex = new Map();
  const mapRoads = [];
  for (const e of roadsOSM) {
    const t = e.tags || {};
    const ci = ROAD_CLASSES.indexOf(t.highway);
    if (ci < 0 || !e.geometry || t.area === 'yes') continue;
    const pts = rdp(e.geometry.map((g) => toWorld(g.lon, g.lat)), 4);
    if (pts.length < 2 || pts.every(([x, z]) => inCore(x, z))) continue;
    const name = t.name || t.ref || '';
    if (name && !nameIndex.has(name)) { nameIndex.set(name, mapNames.length); mapNames.push(name); }
    const r = [ci, name ? nameIndex.get(name) : -1];
    let px = 0, pz = 0;
    for (const [x, z] of pts) {
      const qx = Math.round(x), qz = Math.round(z);
      r.push(qx - px, qz - pz);
      px = qx; pz = qz;
    }
    mapRoads.push(r);
  }

  // --- Write ---------------------------------------------------------------------------------------------------------
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const index = [];
  let bytes = 0;
  for (const tile of [...tiles.values()].sort((a, b) => a.j - b.j || a.i - b.i)) {
    if (!tile.buildings.length && !tile.roads.length) continue;
    const ox = tile.i * T, oz = tile.j * T;
    const types = [...new Set(tile.buildings.map((b) => b.type))];
    const data = [];
    let fx = 0, fz = 0;
    tile.buildings.sort((a, b) => Math.floor(a.cz / CELL) - Math.floor(b.cz / CELL) || a.cx - b.cx);
    for (const b of tile.buildings) {
      data.push(1, Math.round(b.top * 10), Math.round(b.bottom * 10), types.indexOf(b.type), b.outer.length);
      let px = fx, pz = fz;
      b.outer.forEach(([x, z], i) => {
        const qx = Math.round((x - ox) * 10), qz = Math.round((z - oz) * 10);
        data.push(qx - px, qz - pz);
        px = qx; pz = qz;
        if (!i) { fx = qx; fz = qz; }
      });
    }
    const roads = tile.roads.map((r) => {
      const out = [r.cls, Math.round(r.width * 10), r.level, r.pts.length];
      let px = 0, pz = 0;
      for (const [x, z] of r.pts) {
        const qx = Math.round((x - ox) * 10), qz = Math.round((z - oz) * 10);
        out.push(qx - px, qz - pz);
        px = qx; pz = qz;
      }
      return out;
    });
    const file = `${tile.i}_${tile.j}.json`;
    const body = JSON.stringify({ buildings: { types, data }, roads });
    fs.writeFileSync(path.join(outDir, file), body);
    bytes += body.length;
    index.push({ i: tile.i, j: tile.j, file, buildings: tile.buildings.length, roads: roads.length, top: Math.round(Math.max(0, ...tile.buildings.map((b) => b.top))) });
  }
  const cb = bbox(coreRing);
  const indexJson = {
    version: 1,
    city: city.id,
    tile: T,
    frame: GEO.frame,
    roadClasses: ROAD_CLASSES,
    core: [q(cb.x0), q(cb.z0), q(cb.x1), q(cb.z1)],
    coreRing: flat(coreRing),
    land: regions.map((r) => [r.outer, ...r.holes].map(flat)),
    tiles: index
  };
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(indexJson));
  const roadsJson = JSON.stringify({ classes: ROAD_CLASSES, names: mapNames, roads: mapRoads });
  fs.writeFileSync(path.join(outDir, 'roads.json'), roadsJson);
  log(`roads.json: ${mapRoads.length} main roads for the maps (${(roadsJson.length / 1024).toFixed(0)} KB)`);
  const indexBytes = fs.statSync(path.join(outDir, 'index.json')).size;
  log(`wrote ${index.length} tiles (${(bytes / 1e6).toFixed(1)} MB) and index.json (${(indexBytes / 1024).toFixed(0)} KB) into ${outDir}`);
  return indexJson;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await buildTiles(process.argv[2]);
}

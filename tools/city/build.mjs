// tools/city/build.mjs — writes js/<city>-geodata.js: a city's geography in its 1:1 world frame from OpenStreetMap
// (tools/city/fetch.mjs downloads the layers). City-neutral counterpart of tools/build-geodata.mjs (New York's own data).
// usage: node --max-old-space-size=8192 tools/city/build.mjs <city> [out.js]
//
// Output (GEO, version 2): x = grid east, z = grid south (north = -z), 1 unit = 1 m, origin at the city's origin point,
// axes turned frame.bearingDeg from true north. Polygons & polylines are flat [x0, z0, x1, z1, ...] arrays.
//   detail      the detailed area's outline (blocks are kept inside it)
//   land        land masses (coastline land minus inland water): [outline, ...holes] each; water [{ name, ring }] the
//               inland water bodies
//   parks       [{ name, kind, rings }]
//   roadGraph   street centreline graph (tools/city/graph.mjs) of the vehicle roads at every level; each link ends with
//               [class index (roadGraph.classes), level (0 at grade, > 0 viaducts, < 0 tunnels), over water (1: a
//               bridge carrying its street across water at grade)]
//   blocks      as js/nyc-geodata.js: [outline, lot rects, park share, park name, rectangular, frontage frames | 0]
//   districts   [{ name, style, x, z, r }] building styles by neighbourhood (nearest centre within r), places [{ id, name,
//               sub, x, z }] teleport destinations & landmarks, labels [{ name, x, z, kind }] map labels (the config's)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCity, dataDir } from './config.mjs';
import { makeFrame, gridBearing } from './frame.mjs';
import { bbox, centroid, pointInRing, rdp, rdpRing, ringArea } from './geom.mjs';
import { extractBlocks, parkCoverage } from './blocks.mjs';
import { createGraph } from './graph.mjs';
import { areaRings, coastLand, streetPieces, traceRegions, yes as yesTag, VEHICLE_CLASSES } from './osm.mjs';

const log = (...a) => console.log('[city]', ...a);
const q = (v) => Math.round(v * 10) / 10;
const flat = (pts) => pts.flatMap(([x, z]) => [q(x), q(z)]);

// Street classes whose carriageways bound blocks, and those the drivable graph keeps
const BLOCK_CLASSES = new Set([...VEHICLE_CLASSES.filter((c) => c !== 'service'), 'pedestrian']);
const GRAPH_CLASSES = VEHICLE_CLASSES.filter((c) => c !== 'service');

// `city`: a config (tools/city/cities/*.mjs) or its id; `data`: the downloads' directory (default: dataDir(city))
export async function buildCity(cityOrId, { out, data } = {}) {
  const city = typeof cityOrId === 'string' ? await loadCity(cityOrId) : cityOrId;
  const dir = data || dataDir(city);
  const load = (layer) => JSON.parse(fs.readFileSync(path.join(dir, `osm_${layer}.json`), 'utf8')).elements;
  const roadsOSM = load('roads');
  const coastOSM = load('coast');
  const waterOSM = load('water');
  const parksOSM = load('parks');
  log(`${city.name}: ${roadsOSM.length} highway ways, ${coastOSM.length} coastline ways, ${waterOSM.length} water & ${parksOSM.length} park areas`);

  // --- Frame -----------------------------------------------------------------------------------------------------------
  const frame = makeFrame({ lat0: city.origin.lat, lon0: city.origin.lon });
  const [S, Wd, N, E] = city.detail;
  const inDetailLL = (lon, lat) => lat > S && lat < N && lon > Wd && lon < E;
  if (city.bearing === 'auto') {
    const segs = [];
    for (const e of roadsOSM) {
      const t = e.tags || {};
      if (e.type !== 'way' || !e.geometry || !GRAPH_CLASSES.includes(t.highway) || /_link$/.test(t.highway) || t.bridge || t.tunnel) continue;
      for (let i = 0; i + 1 < e.geometry.length; i++) {
        const a = e.geometry[i], b = e.geometry[i + 1];
        if (inDetailLL(a.lon, a.lat)) segs.push([a.lon, a.lat, b.lon, b.lat]);
      }
    }
    frame.theta = gridBearing(frame, segs);
  } else {
    frame.theta = ((city.bearing || 0) * Math.PI) / 180;
  }
  const { toWorld } = frame;
  const bearingDeg = Math.round(((frame.theta * 180) / Math.PI) * 100) / 100;
  log(`frame: origin ${city.origin.label} (${city.origin.lat}, ${city.origin.lon}), bearing ${bearingDeg}°`);
  const box = (s, w, n, e) => [toWorld(w, n), toWorld(e, n), toWorld(e, s), toWorld(w, s)];
  const detail = box(S, Wd, N, E);
  const m = city.margin;
  const fetched = box(S - m, Wd - m, N + m, E + m);
  const fb = bbox(fetched);
  const X0 = Math.floor(fb.x0), X1 = Math.ceil(fb.x1), Z0 = Math.floor(fb.z0), Z1 = Math.ceil(fb.z1);

  // --- Land & water (2 m) ----------------------------------------------------------------------------------------------
  const land = coastLand(coastOSM, toWorld, fetched, 2);
  const water = [];
  for (const e of waterOSM) {
    const t = e.tags || {};
    if (yesTag(t.covered) || yesTag(t.tunnel) || t.water === 'wastewater') continue;
    for (const ring of areaRings(e, toWorld, 50)) {
      land.fillRing(ring, 0);
      if (Math.abs(ringArea(ring)) >= 400) water.push({ name: t.name || '', ring: rdpRing(ring, 0.8) });
    }
  }
  const [ox, oz] = toWorld(city.origin.lon, city.origin.lat);
  const landAt = (x, z) => land.d[Math.floor((z - land.z0) / land.res) * land.w + Math.floor((x - land.x0) / land.res)];
  if (!landAt(ox, oz)) throw new Error(`the origin (${city.origin.label}) came out as water: check the coastline data`);
  let landCells = 0;
  for (const v of land.d) landCells += v;
  const landRegions = traceRegions(land, 2000);
  log(`land: ${((landCells * 4) / 1e6).toFixed(2)} km² in the fetched box, ${landRegions.length} outlines with ${landRegions.reduce((t, r) => t + r.holes.length, 0)} holes; ${water.length} inland water bodies`);

  // Buildable: land more than `strip` m from water (or the data's edge)
  const buildable = new Uint8Array(land.d.length);
  {
    const toWater = land.edt((v) => v === 0);
    const rc = (city.strip / land.res) ** 2;
    for (let k = 0; k < buildable.length; k++) buildable[k] = land.d[k] && toWater[k] > rc ? 1 : 0;
  }

  // --- Streets -----------------------------------------------------------------------------------------------------------
  const pieces = streetPieces(roadsOSM, toWorld, (t) => BLOCK_CLASSES.has(t.highway));
  const roads = [];
  for (const p of pieces) {
    if (p.level !== 0) continue;
    for (let i = 0; i + 1 < p.pts.length; i++) roads.push({ x0: p.pts[i][0], z0: p.pts[i][1], x1: p.pts[i + 1][0], z1: p.pts[i + 1][1], r: p.w / 2 });
  }
  log(`${pieces.length} street pieces between junctions; ${roads.length} at-grade carriageway segments bound blocks`);

  // --- Blocks (1 m) ------------------------------------------------------------------------------------------------------
  const { blocks: all, raster: R, labels: lab } = extractBlocks({
    x0: X0, z0: Z0, x1: X1, z1: Z1, res: 1, sidewalk: city.sidewalk, roads, log,
    fillLand: (r) => {
      for (let j = 0; j < r.h; j++) {
        const jj = Math.floor((r.z0 + j + 0.5 - land.z0) / land.res);
        if (jj < 0 || jj >= land.h) continue;
        for (let i = 0; i < r.w; i++) {
          const ii = Math.floor((r.x0 + i + 0.5 - land.x0) / land.res);
          if (ii >= 0 && ii < land.w && buildable[jj * land.w + ii]) r.d[j * r.w + i] = 1;
        }
      }
    }
  });
  const blocks = all.filter((b) => pointInRing(...centroid(b.poly), detail));
  log(`${blocks.length} blocks inside the detail area (${blocks.filter((b) => b.rect).length} rectangular, ${blocks.filter((b) => b.frames).length} with frontage frames, ${blocks.filter((b) => !b.rects.length).length} without lots)`);

  // --- Parks -------------------------------------------------------------------------------------------------------------
  const parks = [];
  for (const e of parksOSM) {
    const t = e.tags || {};
    if (t.access === 'private' || t.access === 'no') continue;
    const rings = areaRings(e, toWorld, 300);
    if (rings.length) parks.push({ name: t.name || '', kind: t.leisure || t.landuse, rings });
  }
  parkCoverage(blocks, R, lab, parks);
  log(`${parks.length} parks; ${blocks.filter((b) => b.park > 0.6).length} blocks mostly park`);

  // --- Road graph --------------------------------------------------------------------------------------------------------
  const g = createGraph();
  const classIds = new Map(GRAPH_CLASSES.map((c, i) => [c, i]));
  // Share of a polyline over water (every 2 m)
  const overWater = (pts) => {
    let n = 0, wet = 0;
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
      const steps = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / 2));
      for (let s = 0; s < steps; s++) {
        const x = ax + ((bx - ax) * (s + 0.5)) / steps, z = az + ((bz - az) * (s + 0.5)) / steps;
        n++;
        if (!landAt(x, z)) wet++;
      }
    }
    return n ? wet / n : 0;
  };
  let waterBridges = 0;
  for (const p of streetPieces(roadsOSM, toWorld, (t) => classIds.has(t.highway))) {
    if (!p.pts.some((pt) => pointInRing(pt[0], pt[1], fetched))) continue;
    const a = g.nodeByKey(p.nodes[0], ...p.pts[0]);
    const b = g.nodeByKey(p.nodes[p.nodes.length - 1], ...p.pts[p.pts.length - 1]);
    if (a === b && p.pts.length < 3) continue;
    // a bridge mostly over water carries its street across at grade (on a deck); one over land is a viaduct
    const wet = p.level > 0 && overWater(p.pts) >= 0.4 ? 1 : 0;
    waterBridges += wet;
    g.addLink(a, b, p.name, p.w, p.lanes, p.dir, rdp(p.pts, 0.4), [classIds.get(p.cls), wet ? 0 : p.level, wet]);
  }
  const roadGraph = { ...g.build(), classes: GRAPH_CLASSES };
  log(`road graph: ${roadGraph.nodes.length / 2} nodes, ${roadGraph.links.length} links (${waterBridges} bridges over water at grade)`);

  // --- Neighbourhoods, places & labels from the config, in the world frame ---------------------------------------------
  const at = ([lat, lon]) => toWorld(lon, lat).map(q);
  const districts = (city.districts || []).map((d) => { const [x, z] = at(d.at); return { name: d.name, style: d.style, x, z, r: d.r }; });
  const places = (city.places || []).map((p) => { const [x, z] = at(p.at); return { id: p.id, name: p.name, sub: p.sub || '', x, z }; });
  const labels = (city.labels || []).map((l) => { const [x, z] = at(l.at); return { name: l.name, x, z, kind: l.kind }; });

  // --- Assemble ----------------------------------------------------------------------------------------------------------
  const GEO = {
    version: 2,
    city: city.id,
    name: city.name,
    short: city.short || city.id.slice(0, 2).toUpperCase(),
    frame: { lat0: city.origin.lat, lon0: city.origin.lon, bearingDeg, origin: city.origin.label, units: 'm', sidewalk: city.sidewalk, strip: city.strip, driveSide: city.driveSide },
    detail: flat(detail),
    land: landRegions.map((r) => [r.outer, ...r.holes].map(flat)),
    water: water.map((w) => ({ name: w.name, ring: flat(w.ring) })),
    parks: parks.map((p) => ({ name: p.name, kind: p.kind, rings: p.rings.map((r) => flat(rdpRing(r, 0.8))) })),
    roadGraph,
    blocks: blocks.map((b) => [flat(b.poly), b.rects.map((r) => r.map(q)), b.park || 0, b.parkName || '', b.rect ? 1 : 0,
      b.frames ? b.frames.map(([th, px, pz, rs]) => [Math.round(th * 1e4) / 1e4, q(px), q(pz), rs.map((r) => r.map(q))]) : 0]),
    districts,
    places,
    labels
  };
  const file = out || fileURLToPath(new URL(`../../js/${city.id}-geodata.js`, import.meta.url));
  const header = `// js/${city.id}-geodata.js — GENERATED by tools/city/build.mjs ${city.id}, do not edit by hand.
// ${city.name} in the simulation's world frame (see tools/city/build.mjs for the layout): 1 unit = 1 m, x = grid east,
// z = grid south, origin at ${city.origin.label}, axes turned ${bearingDeg}° from true north.
// Source: © OpenStreetMap contributors (ODbL).
`;
  fs.writeFileSync(file, `${header}export const GEO = ${JSON.stringify(GEO)};\n`);
  log(`wrote ${file} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
  for (const [k, v] of Object.entries(GEO)) log(`  ${k}: ${(JSON.stringify(v).length / 1024).toFixed(0)} KB`);
  return GEO;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await buildCity(process.argv[2], { out: process.argv[3] });
}

import { GEO } from './geodata.js';
import { toPts, createBlocks, createBlockIndex, createRoadIndex, isTypingInField, SIGNAL_TIMING, signalPhase, walkSignal } from './city-common.js';

// js/open-city-config.js
// A city built from OpenStreetMap (tools/city/build.mjs: js/<city>-geodata.js, version 2) behind the same interface as
// nyc-config.js (see city-config.js): its land, blocks and roads, the bounds the controllers and the road network keep
// to, a starting point, and empty stand-ins for New York's own features (the avenues & numbered streets, Central Park,
// Broadway, the piers, bridges, boroughs and landmarks), which the builders skip or do without.

const F = GEO.frame;
const CITY = { id: GEO.city, name: GEO.name, open: true, driveSide: F.driveSide || 'right' };

// ---------------------------------------------------------------------------------------------------------------------
// Land: the land masses ({ outer, holes } outlines, [{ x, z }]) and the detailed area (blocks stand inside it)
// ---------------------------------------------------------------------------------------------------------------------
const LAND_REGIONS = GEO.land.map(([outer, ...holes]) => ({ outer: toPts(outer), holes: holes.map(toPts) }));
const DETAIL_POLYGON = toPts(GEO.detail);
const WATER_BODIES = GEO.water.map((w) => ({ name: w.name, ring: toPts(w.ring) }));

const ISLAND_BOUNDS = (() => {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const r of LAND_REGIONS) {
    for (const p of r.outer) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
  }
  return { minX, maxX, minZ, maxZ, sidewalkHeight: 0.22, waterLevel: -2.2 };
})();
const CUT_Z = ISLAND_BOUNDS.minZ;

// The westernmost and easternmost land at every 2 m of z (the outermost crossings of the land outlines), what
// nyc-config.js's Manhattan shore is to the island
const SHORE = (() => {
  const step = 2;
  const z0 = Math.ceil(ISLAND_BOUNDS.minZ / step) * step;
  const n = Math.max(2, Math.floor((ISLAND_BOUNDS.maxZ - z0) / step) + 1);
  const west = new Float32Array(n).fill(NaN);
  const east = new Float32Array(n).fill(NaN);
  for (const { outer: P } of LAND_REGIONS) {
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const a = P[j];
      const b = P[i];
      if (a.z === b.z) continue;
      const lo = Math.min(a.z, b.z);
      const hi = Math.max(a.z, b.z);
      for (let k = Math.max(0, Math.ceil((lo - z0) / step)); k < n && z0 + k * step < hi; k++) {
        const z = z0 + k * step + 1e-3;
        if (z < lo || z >= hi) continue;
        const x = a.x + ((z - a.z) * (b.x - a.x)) / (b.z - a.z);
        if (!(west[k] <= x)) west[k] = x;
        if (!(east[k] >= x)) east[k] = x;
      }
    }
  }
  for (let k = 1; k < n; k++) if (Number.isNaN(west[k])) { west[k] = west[k - 1]; east[k] = east[k - 1]; }
  for (let k = n - 2; k >= 0; k--) if (Number.isNaN(west[k])) { west[k] = west[k + 1]; east[k] = east[k + 1]; }
  return { z0, step, n, west, east };
})();
function getIslandBoundsAtZ(z) {
  const f = (z - SHORE.z0) / SHORE.step;
  const k = Math.max(0, Math.min(SHORE.n - 2, Math.floor(f)));
  const t = Math.max(0, Math.min(1, f - k));
  return {
    westX: SHORE.west[k] + (SHORE.west[k + 1] - SHORE.west[k]) * t,
    eastX: SHORE.east[k] + (SHORE.east[k + 1] - SHORE.east[k]) * t
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Blocks (city-common.js) and roads: the street graph's links chained per name into polylines for labels, lookups and
// the maps. Each: { name, raw, w, dir, lanes, highway, pts }
// ---------------------------------------------------------------------------------------------------------------------
const BLOCKS = createBlocks(GEO.blocks);
const { blockAt, blocksInRect } = createBlockIndex(BLOCKS);
for (const b of BLOCKS) b.district = 'generic';

const RG = GEO.roadGraph;
const nodePt = (i) => ({ x: RG.nodes[i * 2], z: RG.nodes[i * 2 + 1] });
const HIGHWAY_CLASSES = new Set(['motorway', 'trunk', 'motorway_link', 'trunk_link']);
const ROADS = (() => {
  const byName = new Map();
  for (const l of RG.links) {
    const name = RG.names[l[2]];
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(l);
  }
  const roads = [];
  for (const [name, links] of byName) {
    // chain links end to end through shared nodes (either way round)
    const at = new Map();
    for (const l of links) for (const n of [l[0], l[1]]) { if (!at.has(n)) at.set(n, []); at.get(n).push(l); }
    const used = new Set();
    const linePts = (l, reverse) => {
      const pts = [nodePt(l[0]), ...toPts(l[6]), nodePt(l[1])];
      return reverse ? pts.reverse() : pts;
    };
    for (const l0 of links) {
      if (used.has(l0)) continue;
      used.add(l0);
      let pts = linePts(l0, false);
      for (const forward of [true, false]) {
        let end = forward ? l0[1] : l0[0];
        for (;;) {
          const next = (at.get(end) || []).find((l) => !used.has(l));
          if (!next) break;
          used.add(next);
          const rev = next[1] === end;
          const more = linePts(next, rev).slice(1);
          pts = forward ? pts.concat(more) : more.reverse().concat(pts);
          end = rev ? next[0] : next[1];
        }
      }
      roads.push({ name, raw: name, w: l0[3], dir: l0[5], lanes: l0[4], highway: HIGHWAY_CLASSES.has(RG.classes[l0[7]]), pts });
    }
  }
  return roads;
})();
const nearestRoads = createRoadIndex(ROADS);

// Where a session without a saved position starts: on the widest at-grade street near the origin
const SPAWN = (() => {
  let best = null;
  for (const l of RG.links) {
    const cls = RG.classes[l[7]];
    if (l[8] !== 0 || HIGHWAY_CLASSES.has(cls) || l[4] < 2) continue;
    const a = nodePt(l[0]);
    const b = nodePt(l[1]);
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 40 || l[6].length) continue; // a straight stretch
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const score = Math.hypot(mx, mz) - l[3] * 20;
    if (!best || score < best.score) best = { score, a, b, len, dir: l[5] };
  }
  if (!best) return { x: 0, z: 0, heading: 0 };
  const [from, to] = best.dir < 0 ? [best.b, best.a] : [best.a, best.b];
  return { x: (from.x + to.x) / 2, z: (from.z + to.z) / 2, heading: Math.atan2(to.x - from.x, to.z - from.z) };
})();

/** The nearest streets' names at (x, z): "A & B", one street, or the city's name */
function getLocationLabel(x, z) {
  const near = nearestRoads(x, z, 120);
  if (near.length >= 2 && near[1].dist < 60) return `${near[0].road.name} & ${near[1].road.name}`;
  if (near.length) return near[0].road.name;
  return CITY.name;
}

// ---------------------------------------------------------------------------------------------------------------------
// New York's own features: none here
// ---------------------------------------------------------------------------------------------------------------------
const AVENUES = [];
const ALL_AVENUES = [];
const STREETS = [];
const ALL_STREETS = [];
const CENTRAL_PARK_BOUNDS = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
const MANHATTAN_COASTLINE = [];
const BROADWAY_LINE = [];
const WATERFRONT_PIERS = [];
const EAST_RIVER_BRIDGES = [];
const OUTER_BRIDGES = [];
const NYC_LANDMARKS = [];
const LANDMARK_SITES = {};
const TELEPORT_LOCATIONS = {};
const LANDMARK_BLOCKS = new Set();
const NONE = [];
const FAR = { x: 1e7, z: 1e7 };
const streetZ = (n) => (42 - n) * 79.5;
const avenueX = () => NaN;
const avenueNameAt = () => '';
const getBroadwayX = () => NaN;
const districtAt = () => 'generic';
const getBlockBounds = () => null;
const fromOldFrame = (x, z) => ({ x, z });

export {
  CITY,
  LAND_REGIONS,
  SPAWN,
  DETAIL_POLYGON,
  WATER_BODIES,
  AVENUES,
  ALL_AVENUES,
  CENTRAL_PARK_BOUNDS,
  getIslandBoundsAtZ,
  MANHATTAN_COASTLINE,
  getBroadwayX,
  BROADWAY_LINE,
  WATERFRONT_PIERS,
  NONE as ROOSEVELT_ISLAND_POLYGON,
  NONE as GOVERNORS_ISLAND_POLYGON,
  NONE as NJ_SHORELINE_POLYGON,
  NONE as LONG_ISLAND_POLYGON,
  NONE as LONG_ISLAND_POLYGONS,
  NONE as BROOKLYN_POLYGONS,
  NONE as QUEENS_POLYGONS,
  NONE as BRONX_POLYGONS,
  NONE as WESTCHESTER_POLYGON,
  NONE as NASSAU_POLYGON,
  NONE as UPPER_MANHATTAN_POLYGON,
  NONE as BRONX_POLYGON,
  NONE as STATEN_ISLAND_POLYGON,
  NONE as RANDALLS_ISLAND_POLYGON,
  NONE as LIBERTY_ISLAND_POLYGON,
  FAR as LIBERTY_STATUE_POS,
  NONE as ELLIS_ISLAND_POLYGON,
  NONE as MILL_ROCK_POLYGON,
  EAST_RIVER_BRIDGES,
  OUTER_BRIDGES,
  STREETS,
  ALL_STREETS,
  ROADS,
  NYC_LANDMARKS,
  LANDMARK_SITES,
  TELEPORT_LOCATIONS,
  ISLAND_BOUNDS,
  LANDMARK_BLOCKS,
  BLOCKS,
  CUT_Z,
  SIGNAL_TIMING,
  streetZ,
  avenueX,
  avenueNameAt,
  districtAt,
  blockAt,
  blocksInRect,
  nearestRoads,
  getBlockBounds,
  getLocationLabel,
  fromOldFrame,
  isTypingInField,
  signalPhase,
  walkSignal
};

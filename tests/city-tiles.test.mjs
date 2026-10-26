import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildTiles } from '../tools/city/tiles.mjs';
import { islandQueries } from '../tools/city/fetch-island.mjs';
import { decodeBuildings, buildTileArrays, triangulate } from '../js/city-tiles-build.js';

const LAT0 = 1.3, LON0 = 103.8;
const way = (id, coords, tags) => ({ type: 'way', id, nodes: coords.map((_, i) => (i === coords.length - 1 ? id * 100 : id * 100 + i)), geometry: coords.map(([lon, lat]) => ({ lon, lat })), tags });
// metres east (x) & south (z) of the origin as lon, lat (the frame is turned 0°)
const ll = (x, z) => [LON0 + x / (111320 * Math.cos((LAT0 * Math.PI) / 180)), LAT0 - z / 110574];
const square = (id, x, z, half, tags) => way(id, [[x - half, z - half], [x + half, z - half], [x + half, z + half], [x - half, z + half], [x - half, z - half]].map(([a, b]) => ll(a, b)), tags);

test('the island is fetched in cells covering its box, plus its coastline and water', async () => {
  const q = islandQueries({ island: { box: [1.2, 103.6, 1.32, 103.72], fetchCell: 0.06 } });
  const cells = Object.keys(q).filter((k) => k.startsWith('cell_'));
  assert.equal(cells.length, 4);
  assert.ok(q.coast.includes('"natural"="coastline"') && q.water.includes('reservoir'));
  assert.ok(q[cells[0]].includes('building') && q[cells[0]].includes('motorway'));
});

test('island tiles: the buildings and main roads beyond the detailed area, by tile, and the island\'s land', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'city tiles '));
  try {
    const data = path.join(dir, 'island');
    fs.mkdirSync(data);
    const D = 4000; // m: the island is 8 km across
    // (a coastline runs with the land on its left: anticlockwise on the map)
    const coast = way(1, [[-D, -D], [-D, D], [D, D], [D, -D], [-D, -D]].map(([x, z]) => ll(x, z)), { natural: 'coastline' });
    fs.writeFileSync(path.join(data, 'coast.json'), JSON.stringify({ elements: [coast] }));
    fs.writeFileSync(path.join(data, 'water.json'), JSON.stringify({ elements: [] }));
    const elements = [
      square(10, 0, 0, 10, { building: 'office', height: '80' }), // in the detailed area: left to the city
      square(11, 2000, 0, 15, { building: 'apartments', 'building:levels': '16' }),
      square(12, -2500, 1800, 20, { building: 'residential' }), // no height: an HDB block's 12 storeys
      square(13, 1200, -2600, 25, { building: 'yes' }), // drawn by its part
      square(14, 1200, -2600, 10, { 'building:part': 'yes', height: '40' }),
      way(20, [ll(-3000, 400), ll(-1000, 400), ll(1000, 400), ll(3000, 400)], { highway: 'trunk', name: 'Test Expressway' }),
      way(21, [ll(-3000, -400), ll(3000, -400)], { highway: 'residential' }) // not a main road
    ];
    fs.writeFileSync(path.join(data, 'cell_a.json'), JSON.stringify({ elements }));
    fs.writeFileSync(path.join(data, 'cell_b.json'), JSON.stringify({ elements: [elements[1]] })); // in two cells: once
    const city = {
      id: 'testisle', detail: [LAT0 - 0.003, LON0 - 0.003, LAT0 + 0.003, LON0 + 0.003], margin: 0.001,
      island: { box: [LAT0 - 0.045, LON0 - 0.045, LAT0 + 0.045, LON0 + 0.045], tile: 1500 }
    };
    const geo = { frame: { lat0: LAT0, lon0: LON0, bearingDeg: 0 } };
    const out = path.join(dir, 'tiles');
    const index = await buildTiles(city, { data, out, geo });
    assert.equal(index.tile, 1500);
    assert.equal(index.land.length, 1, 'one island');
    const xs = index.land[0][0].filter((_, k) => k % 2 === 0);
    assert.ok(Math.min(...xs) < -3900 && Math.max(...xs) > 3900, 'the land reaches the coast');
    // every building but the detailed area's, each in the tile its centre is in
    const all = [];
    for (const t of index.tiles) {
      const tile = JSON.parse(fs.readFileSync(path.join(out, t.file), 'utf8'));
      for (const b of decodeBuildings(tile.buildings)) {
        let cx = 0, cz = 0;
        const n = b.pts.length / 2;
        for (let k = 0; k < n; k++) { cx += b.pts[k * 2]; cz += b.pts[k * 2 + 1]; }
        all.push({ ...b, x: t.i * 1500 + cx / n, z: t.j * 1500 + cz / n, tile: t });
      }
      if (t.roads) assert.ok(tile.roads.every((r) => index.roadClasses[r[0]] === 'trunk'));
    }
    assert.equal(all.length, 3, JSON.stringify(all.map((b) => [b.type, b.top])));
    const at = (x, z) => all.find((b) => Math.hypot(b.x - x, b.z - z) < 2);
    assert.equal(at(2000, 0).top, 51.2);
    assert.equal(at(-2500, 1800).top, 38.4, 'an untagged residential block');
    assert.equal(at(1200, -2600).top, 40, 'the part stands for its outline');
    assert.ok(!at(0, 0), 'the detailed area is the city\'s own');
    for (const b of all) assert.ok(b.x >= b.tile.i * 1500 && b.x < (b.tile.i + 1) * 1500 && b.z >= b.tile.j * 1500 && b.z < (b.tile.j + 1) * 1500);
    // the expressway, cut by tile and left out of the detailed area
    const runs = index.tiles.reduce((n, t) => n + t.roads, 0);
    assert.ok(runs >= 4, `the trunk road runs through several tiles (${runs})`);
    // the frame is the city's
    assert.deepEqual(index.frame, geo.frame);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ear clipping triangulates concave footprints, either way round, covering their area', () => {
  // an L of 3 x 3 cells less one: area 3
  const L = [0, 0, 2, 0, 2, 1, 1, 1, 1, 2, 0, 2];
  for (const pts of [L, L.slice().reverse().reduce((a, _, i, r) => (i % 2 ? a : a.concat([r[i + 1], r[i]])), [])]) {
    const tris = triangulate(new Float32Array(pts));
    assert.equal(tris.length, 4 * 3);
    let area = 0;
    for (let t = 0; t < tris.length; t += 3) {
      const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]].map((i) => [pts[i * 2], pts[i * 2 + 1]]);
      area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
    }
    assert.ok(Math.abs(area - 3) < 1e-9, `area ${area}`);
  }
});

test('a built tile: walls facing out, roofs and roads facing up, bounding spheres around them', () => {
  // one clockwise (x, z) square building 10 m across and 20 m tall at (50, 50) in the tile, one road run
  const pts = [[45, 45], [45, 55], [55, 55], [55, 45]];
  const data = [1, 200, 0, 0, 4];
  let px = 0, pz = 0;
  for (const [x, z] of pts) { data.push(x * 10 - px, z * 10 - pz); px = x * 10; pz = z * 10; }
  const tile = { buildings: { types: ['apartments'], data }, roads: [[1, 140, 0, 2, 0, 0, 1000, 0]] };
  const built = buildTileArrays(tile);
  assert.deepEqual(built.counts, { walls: 4, roofs: 2, roads: 1 });
  const P = built.walls.position, N = built.walls.normal;
  for (let v = 0; v < P.length / 3; v++) {
    const out = (P[v * 3] - 50) * N[v * 3] + (P[v * 3 + 2] - 50) * N[v * 3 + 2];
    assert.ok(out > 0, 'wall normals point away from the building');
  }
  for (const part of [built.roofs, built.roads]) {
    const p = part.position;
    for (let t = 0; t < p.length; t += 9) {
      // y of (b - a) x (c - a) > 0 is facing up
      const cy = (p[t + 5] - p[t + 2]) * (p[t + 6] - p[t]) - (p[t + 3] - p[t]) * (p[t + 8] - p[t + 2]);
      assert.ok(cy > 0, 'faces up');
    }
  }
  const [cx, cy, cz, r] = built.walls.sphere;
  assert.ok(Math.abs(cx - 50) < 1e-6 && Math.abs(cy - 10) < 1e-6 && Math.abs(cz - 50) < 1e-6 && Math.abs(r - Math.hypot(10, 20, 10) / 2) < 1e-6);
  assert.equal(decodeBuildings(tile.buildings)[0].top, 20);
});

test('the land mask: inside the island, not in its lakes or the sea', async () => {
  const { createLandMask } = await import('../js/city-tiles-build.js');
  const island = [-100, -100, 100, -100, 100, 100, -100, 100];
  const lake = [-20, -20, 20, -20, 20, 20, -20, 20];
  const mask = createLandMask([[island, lake]], 2);
  assert.equal(mask.at(50, 50), true);
  assert.equal(mask.at(0, 0), false, 'the lake');
  assert.equal(mask.at(150, 0), false, 'the sea');
  assert.equal(mask.at(-99, 99), true);
});

test('a tile\'s colliders: one turned box for a building that nearly fills it, a thin one per wall otherwise', () => {
  const enc = (pts, top) => {
    const data = [1, top * 10, 0, 0, pts.length];
    let px = 0, pz = 0;
    for (const [x, z] of pts) { data.push(x * 10 - px, z * 10 - pz); px = x * 10; pz = z * 10; }
    return data;
  };
  const square = [[0, 0], [0, 10], [10, 10], [10, 0]];
  const ell = [[100, 100], [100, 140], [140, 140], [140, 130], [110, 130], [110, 100]];
  const built = buildTileArrays({ buildings: { types: ['yes'], data: [...enc(square, 20), ...enc(ell, 12)] }, roads: [] });
  const c = built.colliders;
  assert.equal(c.length / 8, 1 + 6, 'the square as one box, the L by its six walls');
  assert.deepEqual([...c.slice(0, 4)].map((v) => Math.round(Math.abs(v) * 10) / 10), [5, 5, 5, 5]);
  assert.deepEqual([c[6], c[7]], [0, 20]);
});

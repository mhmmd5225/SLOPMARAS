import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { buildTiles } from '../tools/city/tiles.mjs';
import { islandQueries } from '../tools/city/fetch-island.mjs';

const require = createRequire(import.meta.url);
const { loadModule } = require('./helpers/module.cjs');

const LAT0 = 1.3, LON0 = 103.8;
const way = (id, coords, tags) => ({ type: 'way', id, nodes: coords.map((_, i) => (i === coords.length - 1 ? id * 100 : id * 100 + i)), geometry: coords.map(([lon, lat]) => ({ lon, lat })), tags });
// metres east (x) & south (z) of the origin as lon, lat (the frame is turned 0°)
const ll = (x, z) => [LON0 + x / (111320 * Math.cos((LAT0 * Math.PI) / 180)), LAT0 - z / 110574];
const square = (id, x, z, half, tags) => way(id, [[x - half, z - half], [x + half, z - half], [x + half, z + half], [x - half, z + half], [x - half, z - half]].map(([a, b]) => ll(a, b)), tags);

// The runtime's decoder (js/city-tiles.js), its three.js imports stubbed
const stub = new Proxy(function () {}, { get: () => stub, apply: () => stub });
const { decodeBuildings } = loadModule(fs.readFileSync(new URL('../js/city-tiles.js', import.meta.url), 'utf8'), {
  imports: { 'three/webgpu': {}, 'three/tsl': new Proxy({}, { get: () => stub }), './tsl-materials.js': { cityUniforms: { uInteriorGlow: stub } } },
  globals: { Math, Set, Map, Float32Array, console }
});

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

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// The city's modules load in their own process, as they would in the page
function inCity(body) {
  const script = `
    const config = await import('./js/city-config.js');
    const { buildRoadNetwork } = await import('./js/road-network.js');
    const out = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, encoding: 'utf8', timeout: 120000
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('Kahramanmaraş serves the whole city-config.js interface', () => {
  const out = inCity(`
    const names = (m) => Object.keys(m).sort();
    const { SPAWN } = config;
    return {
      missing: names(config).filter((k) => config[k] === undefined),
      city: (({ vehicles, ...c }) => c)(config.CITY),
      taxis: config.CITY.vehicles.taxis,
      blocks: config.BLOCKS.length,
      roads: config.ROADS.length,
      land: config.LAND_REGIONS.length,
      spawnInBlock: !!config.blockAt(SPAWN.x, SPAWN.z),
      spawnShore: config.getIslandBoundsAtZ(SPAWN.z),
      spawnX: SPAWN.x,
      label: config.getLocationLabel(SPAWN.x, SPAWN.z),
      teleports: Object.entries(config.TELEPORT_LOCATIONS).map(([id, t]) => ({ id, name: t.name, inBlock: !!config.blockAt(t.x, t.z), heading: t.heading })),
      styled: config.BLOCKS.filter((b) => b.district !== 'generic').length
    };
  `);
  assert.deepEqual(out.missing, []);
  assert.deepEqual(out.city, { id: 'kahramanmaras', name: 'Kahramanmaraş', short: '46', open: true, driveSide: 'right', units: 'metric' });
  assert.deepEqual(out.taxis, [0xffc40c], "Turkey's yellow taxis");
  assert.ok(out.blocks > 1000 && out.roads > 500 && out.land > 0);
  assert.equal(out.spawnInBlock, false, 'the start is on a street');
  assert.ok(out.spawnX > out.spawnShore.westX && out.spawnX < out.spawnShore.eastX, 'the start is on land');
  assert.match(out.label, /\w+ & \w+|\w+/);
  assert.ok(out.teleports.length >= 8, 'a teleport to each place');
  for (const t of out.teleports) {
    assert.equal(t.inBlock, false, `${t.name} arrives on a street`);
    assert.ok(Number.isFinite(t.heading));
  }
  assert.ok(out.styled > 300, 'neighbourhoods give blocks their building styles');
});

test("Kahramanmaraş's lawns stay inside its blocks, off the roads", () => {
  const out = inCity(`
    const { GEO } = await import('./js/geodata.js');
    const L = GEO.lawns;
    let rings = 0, points = 0, outside = 0;
    for (let i = 0, fx = 0, fz = 0; i < L.length;) {
      const n = L[i++];
      rings++;
      let px = fx, pz = fz;
      for (let k = 0; k < n; k++) {
        px += L[i++]; pz += L[i++];
        if (!k) { fx = px; fz = pz; }
        points++;
        if (!config.blockAt(px / 10, pz / 10)) outside++;
      }
    }
    return { rings, points, outside };
  `);
  assert.ok(out.rings > 500, `${out.rings} lawns`);
  // a corner can sit on its curb's raster step, a hair outside the traced outline
  assert.ok(out.outside / out.points < 0.01, `${out.outside} of ${out.points} lawn corners outside every block`);
});

test("Kahramanmaraş's streets drive as one network", () => {
  // the curbs city-grid.js bounds the roads with in an open city: rectangular blocks, the outlines of irregular ones
  // with lots (medians & traffic islands bound none)
  const out = inCity(`
    const sidewalks = [];
    for (const b of config.BLOCKS) {
      if (b.median) continue;
      if (b.rect) sidewalks.push({ minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ });
      else if (b.rects.length) sidewalks.push({ minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ, poly: b.poly });
    }
    console.info = () => {};
    const net = buildRoadNetwork(sidewalks, []);
    const uturns = net.edges.reduce((n, e) => n + e.moves.filter((m) => m.uturn).length, 0);
    return { edges: net.edges.length, uturns };
  `);
  assert.ok(out.edges > 8000, `${out.edges} connected edges`);
  assert.ok(out.uturns > 0, 'dead ends turn round');
});

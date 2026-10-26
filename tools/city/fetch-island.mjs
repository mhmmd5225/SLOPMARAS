// tools/city/fetch-island.mjs — downloads OpenStreetMap's buildings and main roads across a city's whole `island` box
// (tools/city/cities/<city>.mjs), cell by cell, plus the island's coastline and inland water, for the streamed outer
// tiles (tools/city/tiles.mjs). Into tools/data/<city>/island/ (not committed: tens of megabytes of raw Overpass JSON).
// usage: node tools/city/fetch-island.mjs <city> [--force] [--jobs 2]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCity, dataDir } from './config.mjs';

// The Overpass cells (deg) of the island box, [s, w, n, e] each, and the island-wide layers
export function islandQueries(city) {
  const [S, W, N, E] = city.island.box;
  const step = city.island.fetchCell || 0.06;
  const out = {};
  const f = (v) => Math.round(v * 1e4) / 1e4;
  for (let lat = S; lat < N - 1e-9; lat += step) {
    for (let lon = W; lon < E - 1e-9; lon += step) {
      const bb = `(${f(lat)},${f(lon)},${f(Math.min(N, lat + step))},${f(Math.min(E, lon + step))})`;
      const key = `cell_${f(lat).toFixed(2)}_${f(lon).toFixed(2)}`;
      out[key] = `[out:json][timeout:300];(way["building"]${bb};relation["building"]${bb};way["building:part"]${bb};` +
        `way["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"]${bb};);out geom;`;
    }
  }
  const bb = `(${S},${W},${N},${E})`;
  out.coast = `[out:json][timeout:300];way["natural"="coastline"]${bb};out geom;`;
  out.water = `[out:json][timeout:300];(way["natural"="water"]${bb};relation["natural"="water"]${bb};way["landuse"="reservoir"]${bb};relation["landuse"="reservoir"]${bb};);out geom;`;
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const city = await loadCity(process.argv[2]);
  if (!city.island) throw new Error(`${city.id} has no island box`);
  const force = process.argv.includes('--force');
  const ji = process.argv.indexOf('--jobs');
  const jobs = ji > 0 ? Math.max(1, parseInt(process.argv[ji + 1], 10) || 2) : 2; // Overpass grants ~2 slots per client
  const dir = path.join(dataDir(city), 'island');
  fs.mkdirSync(dir, { recursive: true });
  const overpass = fileURLToPath(new URL('../overpass.sh', import.meta.url));
  const todo = Object.entries(islandQueries(city)).filter(([key]) => force || !fs.existsSync(path.join(dir, `${key}.json`)));
  console.log(`[island] ${todo.length} layers to fetch into ${dir}`);
  let failed = 0;
  let done = 0;
  const run = ([key, ql]) => new Promise((resolve) => {
    const q = path.join(dir, `${key}.overpassql`);
    fs.writeFileSync(q, ql + '\n');
    const child = spawn('bash', [overpass, path.join(dir, `${key}.json`), q, '4'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.on('close', (code) => {
      done++;
      if (code) failed++;
      console.log(`[island] ${done}/${todo.length} ${key}: ${code ? 'FAILED' : log.trim().split('\n').pop()}`);
      fs.rmSync(q, { force: true });
      resolve();
    });
  });
  const queue = [...todo];
  await Promise.all(Array.from({ length: jobs }, async () => { while (queue.length) await run(queue.shift()); }));
  process.exit(failed ? 1 : 0);
}

// tools/city/fetch.mjs — downloads a city's OpenStreetMap layers from Overpass (tools/overpass.sh) into tools/data/<city>/
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
    parks: `[out:json][timeout:180];(${area('["leisure"~"^(park|garden|nature_reserve|common)$"]')}${area('["landuse"="recreation_ground"]')});out geom;`
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const city = await loadCity(process.argv[2]);
  const force = process.argv.includes('--force');
  const dir = dataDir(city);
  fs.mkdirSync(dir, { recursive: true });
  const overpass = fileURLToPath(new URL('../overpass.sh', import.meta.url));
  let failed = 0;
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

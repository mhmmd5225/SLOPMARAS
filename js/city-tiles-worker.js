import { buildTileArrays, transferables } from './city-tiles-build.js';

// js/city-tiles-worker.js
// Fetches and builds island tiles off the main thread (js/city-tiles.js): { id, url } in, { id, built } or
// { id, error } out, the built tile's arrays transferred.

self.onmessage = async ({ data: { id, url } }) => {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const built = buildTileArrays(await r.json());
    self.postMessage({ id, built }, transferables(built));
  } catch (e) {
    self.postMessage({ id, error: e.message || String(e) });
  }
};

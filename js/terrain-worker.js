import { cutSoup, raiseVertices } from './terrain-cut.js';

// js/terrain-worker.js
// Cuts the static city's ground layers along the ground's triangles off the main thread (js/terrain.js): the grids
// once ({ grids: { fine, coarse } }), then { id, soup, stride, dropUndersides, normalOffset } in, the pieces welded
// and laid on the ground { id, unique, count, indices } out, their arrays transferred.

let fine = null, coarse = null;

self.onmessage = ({ data }) => {
  if (data.grids) {
    ({ fine, coarse } = data.grids);
    return;
  }
  const { id, soup, stride, dropUndersides, normalOffset } = data;
  try {
    const cut = cutSoup(fine, soup, stride, dropUndersides);
    raiseVertices(fine, coarse, cut.unique, cut.count, stride, normalOffset);
    self.postMessage({ id, ...cut }, [cut.unique.buffer, cut.indices.buffer]);
  } catch (e) {
    self.postMessage({ id, error: e.message || String(e) });
  }
};

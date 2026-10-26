import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeGrid, linearAt, groundAt, groundTriangle, cutSoup, raiseVertices } from '../js/terrain-cut.js';

// A GEO.terrain grid of heights h(i, j) (decimetres delta-coded along the rows, each row from the previous row's first)
function encode(cols, rows, cell, x0, z0, h) {
  const data = [];
  let prev = 0;
  for (let j = 0; j < rows; j++) {
    let p = prev;
    for (let i = 0; i < cols; i++) {
      const q = Math.round(h(i, j) * 10);
      data.push(q - p);
      p = q;
      if (!i) prev = q;
    }
  }
  return { x0, z0, cell, cols, rows, data };
}

const F = decodeGrid(encode(6, 5, 30, -60, -45, (i, j) => (i * 7 + j * 3) % 11 - 4));
const C = decodeGrid(encode(4, 4, 100, -150, -150, () => 12));

test('a grid decodes to its heights and is linear over each cell\'s two triangles', () => {
  assert.equal(F.h[2 * 6 + 3], ((3 * 7 + 2 * 3) % 11) - 4);
  assert.equal(F.x1, 90);
  assert.equal(F.z1, 75);
  // corners exactly, the lower-left triangle along its diagonal's corners
  assert.equal(linearAt(F, -60 + 30, -45 + 60), F.h[2 * 6 + 1]);
  const mid = linearAt(F, -60 + 15, -45 + 15);
  assert.ok(Math.abs(mid - (F.h[1] + F.h[6]) / 2) < 1e-9, 'the diagonal\'s midpoint is its two corners\' mean');
  assert.equal(groundAt(F, C, 0, 0), linearAt(F, 0, 0));
  assert.equal(groundAt(F, C, 140, 0), 12, 'beyond the fine grid, the coarse one');
});

// A triangle soup of [x, y, z, u, v] vertices
const area = (soup, stride, indices) => {
  let a = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [p, q, r] = [indices[t], indices[t + 1], indices[t + 2]].map((k) => [soup[k * stride], soup[k * stride + 2]]);
    a += Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1])) / 2;
  }
  return a;
};

test('a triangle across many cells is cut into pieces each over one ground triangle, nothing lost', () => {
  const stride = 5;
  // a big triangle over the grid with uv = its world xz / 100 (linear: the pieces' must stay so) and one wholly inside
  // a ground triangle
  const tri = (pts) => pts.flatMap(([x, z]) => [x, 0.2, z, x / 100, z / 100]);
  const soup = Float32Array.from([...tri([[-50, -40], [80, -20], [-10, 70]]), ...tri([[1, 1], [5, 1], [1, 5]])]);
  const cut = cutSoup(F, soup, stride, false);
  assert.ok(cut.indices.length / 3 > 20, 'cut into pieces');
  const whole = 0.5 * (130 * 110 - 20 * 40) + 8;
  assert.ok(Math.abs(area(cut.unique, stride, cut.indices) - whole) < 1e-3, `the pieces cover the triangles exactly (${area(cut.unique, stride, cut.indices)} of ${whole})`);
  for (let t = 0; t < cut.indices.length; t += 3) {
    // each piece's centroid's ground triangle is every corner's (corners on a cut line may read either side of it)
    const ks = [0, 1, 2].map((c) => cut.indices[t + c]);
    if (area(cut.unique, stride, ks) < 1e-6) continue; // (a zero-area sliver along a cut: nothing drawn)
    const cx = ks.reduce((s, k) => s + cut.unique[k * stride], 0) / 3, cz = ks.reduce((s, k) => s + cut.unique[k * stride + 2], 0) / 3;
    const home = groundTriangle(F, cx, cz);
    for (const k of ks) {
      const x = cut.unique[k * stride], z = cut.unique[k * stride + 2];
      const nx = cx + (x - cx) * 0.999, nz = cz + (z - cz) * 0.999; // (a hair in from the corner)
      assert.equal(groundTriangle(F, nx, nz), home, `piece ${t / 3} lies over one ground triangle`);
    }
  }
  for (let k = 0; k < cut.count; k++) {
    const o = k * stride;
    assert.ok(Math.abs(cut.unique[o + 3] - cut.unique[o] / 100) < 1e-5 && Math.abs(cut.unique[o + 4] - cut.unique[o + 2] / 100) < 1e-5, 'attributes interpolated');
  }
  assert.ok(cut.count < cut.indices.length, 'the pieces\' shared corners welded');
});

test('undersides are dropped, and the raised pieces lie on the ground with their normals tilted', () => {
  const stride = 6;
  const up = [[-50, -40], [-10, 70], [80, -20]].flatMap(([x, z]) => [x, 0.2, z, 0, 1, 0]);
  const down = [[-50, -40], [80, -20], [-10, 70]].flatMap(([x, z]) => [x, 0, z, 0, -1, 0]);
  const cut = cutSoup(F, Float32Array.from([...up, ...down]), stride, true);
  const kept = area(cut.unique, stride, cut.indices);
  assert.ok(Math.abs(kept - 0.5 * (130 * 110 - 20 * 40)) < 1e-3, `only the top kept (${kept})`);
  raiseVertices(F, C, cut.unique, cut.count, stride, 3);
  for (let k = 0; k < cut.count; k++) {
    const o = k * stride, x = cut.unique[o], z = cut.unique[o + 2];
    assert.ok(Math.abs(cut.unique[o + 1] - (0.2 + groundAt(F, C, x, z))) < 1e-4, 'raised by the ground under it');
    const n = [cut.unique[o + 3], cut.unique[o + 4], cut.unique[o + 5]];
    assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-6 && n[1] > 0.7, 'a unit normal, still facing up');
  }
  assert.ok(cut.unique.some((v, i) => i % stride === 3 && Math.abs(v) > 1e-3), 'tilted with the slope');
});

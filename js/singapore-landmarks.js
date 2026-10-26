import * as THREE from 'three/webgpu';
import { Fn, uv, float, vec3, mix, step, fract, floor, sin, smoothstep, max, positionWorld, time } from 'three/tsl';
import { cityUniforms } from './tsl-materials.js';
import { GEO } from './geodata.js';

// js/singapore-landmarks.js
// Singapore's two skyline icons, modelled low-poly from their real dimensions and placed where OpenStreetMap maps them
// (tools/city/build.mjs leaves their mapped outlines out of GEO.buildings: tools/city/cities/singapore.mjs landmarks):
// - Marina Bay Sands: three 193 m hotel towers, each of two legs, the eastern one curving out from the 23rd storey down
//   to the ground, carrying the 340 m SkyPark with its cantilevered bow, infinity pool and gardens; at night the towers'
//   rooms light up and Spectra's beams sweep the sky
// - Singapore Flyer: a 150 m wheel (165 m to the top) on two A-frames with 28 capsules outboard of the rim that stay
//   level as it turns, clockwise seen from Marina Centre, once in about 32 minutes; its rim glows at night
// Returns { group, colliders (as js/open-city-buildings.js's), footprints (for the maps), update(elapsed) }.

// ---------------------------------------------------------------------------------------------------------------------
// The world frame (tools/city/frame.mjs): lat/lon -> x (grid east), z (grid south)
// ---------------------------------------------------------------------------------------------------------------------
function makeToWorld(frame) {
  const A = 6378137.0, E2 = 6.69437999014e-3;
  const phi = (frame.lat0 * Math.PI) / 180;
  const s0 = Math.sin(phi);
  const KX = (Math.PI / 180) * (A / Math.sqrt(1 - E2 * s0 * s0)) * Math.cos(phi);
  const KY = (Math.PI / 180) * ((A * (1 - E2)) / Math.pow(1 - E2 * s0 * s0, 1.5));
  const th = ((frame.bearingDeg || 0) * Math.PI) / 180;
  const c = Math.cos(th), s = Math.sin(th);
  return (lat, lon) => {
    const e = (lon - frame.lon0) * KX, n = (lat - frame.lat0) * KY;
    return [e * c - n * s, -(e * s + n * c)];
  };
}

// An oriented box collider (js/open-city-buildings.js obbCollider): centre, half extents along u = (ux, uz) & across it
function obbCollider(cx, cz, hx, hz, ux, uz, minY, maxY) {
  const ex = Math.abs(ux) * hx + Math.abs(uz) * hz;
  const ez = Math.abs(uz) * hx + Math.abs(ux) * hz;
  return { minX: cx - ex, maxX: cx + ex, minZ: cz - ez, maxZ: cz + ez, minY, maxY, obb: { cx, cz, hx, hz, cs: ux, sn: -uz } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Geometry: flat-shaded triangles with uv in metres (u across a face, v up it), for the facade patterns
// ---------------------------------------------------------------------------------------------------------------------
class Mesher {
  constructor() { this.pos = []; this.nrm = []; this.uvs = []; }
  tri(a, b, c, ua, ub, uc) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    nx /= L; ny /= L; nz /= L;
    this.pos.push(...a, ...b, ...c);
    for (let k = 0; k < 3; k++) this.nrm.push(nx, ny, nz);
    this.uvs.push(...(ua || [0, 0]), ...(ub || [0, 0]), ...(uc || [0, 0]));
  }
  // a, b, c, d anticlockwise seen from the front
  quad(a, b, c, d, ua, ub, uc, ud) {
    this.tri(a, b, c, ua, ub, uc);
    this.tri(a, c, d, ua, uc, ud);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------------------------------------------------
const nightNode = () => smoothstep(0.35, 1.3, cityUniforms.uInteriorGlow);
const hash1 = Fn(([x]) => fract(sin(x.mul(12.9898)).mul(43758.5453)));

// MBS's facades: blue-grey glass between white floor slabs every 3.2 m and mullions, its rooms lit at night
function towerGlassMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.FrontSide });
  const p = uv();
  const fy = fract(p.y.div(3.2));
  const fx = fract(p.x.div(1.8));
  const slab = step(0.8, fy);
  const frame = max(slab, step(0.9, fx));
  m.colorNode = mix(vec3(0.27, 0.36, 0.42), vec3(0.82, 0.83, 0.82), frame);
  m.roughnessNode = mix(float(0.1), float(0.55), frame);
  m.metalnessNode = mix(float(0.75), float(0.05), frame);
  const room = hash1(floor(p.y.div(3.2)).mul(57.0).add(floor(p.x.div(5.4))));
  const lit = step(0.58, room).mul(float(1).sub(frame));
  m.emissiveNode = vec3(1.0, 0.76, 0.48).mul(lit.mul(room.mul(0.5).add(0.25)).add(0.05)).mul(nightNode());
  return m;
}

// The SkyPark's deck and hull, the infinity pool, its gardens
function deckMaterial() {
  return new THREE.MeshStandardNodeMaterial({ color: 0xd9d6cf, roughness: 0.7, metalness: 0.1 });
}
function poolMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x2d8fb8, roughness: 0.04, metalness: 0.2 });
  m.emissiveNode = vec3(0.1, 0.55, 0.8).mul(nightNode()).mul(0.8);
  return m;
}
function gardenMaterial() {
  return new THREE.MeshStandardNodeMaterial({ color: 0x3f7a3a, roughness: 0.85, metalness: 0 });
}

// The Flyer's white steel; its rim lit along the ring at night (a slow wash of colour)
function steelMaterial() {
  return new THREE.MeshStandardNodeMaterial({ color: 0xe8ecef, roughness: 0.35, metalness: 0.6 });
}
function rimLightMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0xe8ecef, roughness: 0.35, metalness: 0.5 });
  const wash = sin(positionWorld.y.mul(0.04).add(time.mul(0.35))).mul(0.5).add(0.5);
  m.emissiveNode = mix(vec3(0.25, 0.55, 1.0), vec3(0.9, 0.35, 0.85), wash).mul(nightNode()).mul(1.6);
  return m;
}
function capsuleMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x9fb8c8, roughness: 0.08, metalness: 0.7 });
  m.emissiveNode = vec3(0.85, 0.9, 1.0).mul(nightNode()).mul(0.45);
  return m;
}

// ---------------------------------------------------------------------------------------------------------------------
// Marina Bay Sands
// ---------------------------------------------------------------------------------------------------------------------
const MBS = {
  height: 193, // to the SkyPark's underside (OSM: 55 storeys, 193 m; the SkyPark 193-207 m)
  towerWidth: 56, // along the row of towers (OSM footprints ~58 m)
  legDepth: 16, // each leg's depth across it
  splay: 20, // how far the eastern leg's foot stands out from where the legs meet
  merge: 74, // where the legs meet (the 23rd storey)
  // the towers' feet (Tower 1 to 3, south to north) and the SkyPark's centreline, south end to the bow (OpenStreetMap)
  towers: [[1.282674, 103.860182], [1.283585, 103.860701], [1.284466, 103.861011]],
  skyPark: [[1.282366, 103.85996], [1.283023, 103.860408], [1.28358, 103.860709], [1.284089, 103.860916], [1.284545, 103.861039], [1.284909, 103.861136], [1.285142, 103.861174]],
  deck: [193, 200.5] // underside at the towers, deck level
};

function buildMarinaBaySands(toWorld, colliders, footprints) {
  const group = new THREE.Group();
  group.name = 'MarinaBaySands';
  const glass = new Mesher();
  const H = MBS.height;

  // The SkyPark's centreline (world x, z) and its tangent: towers line up under it
  const line = new THREE.CatmullRomCurve3(MBS.skyPark.map(([lat, lon]) => { const [x, z] = toWorld(lat, lon); return new THREE.Vector3(x, 0, z); }));
  const nearestT = (x, z) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i <= 400; i++) {
      const p = line.getPointAt(i / 400);
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bd) { bd = d; best = i / 400; }
    }
    return best;
  };
  // across = the tangent turned towards the east (true east: the frame's +x turned by its bearing)
  const th = ((GEO.frame.bearingDeg || 0) * Math.PI) / 180;
  const east = [Math.cos(th), -Math.sin(th)];
  const axesAt = (t) => {
    const tg = line.getTangentAt(t);
    let ax = -tg.z, az = tg.x;
    if (ax * east[0] + az * east[1] < 0) { ax = -ax; az = -az; }
    return { vx: tg.x, vz: tg.z, ax, az };
  };

  // A leg: its across-extent [a0, a1] at height y, swept up in rings; faces with uv (along / across, height)
  const legRings = (offset) => {
    const ys = [];
    for (let k = 0; k <= 12; k++) ys.push((MBS.merge * k) / 12);
    ys.push(H);
    return ys.map((y) => [y, offset(y)]);
  };
  const addLeg = (cx, cz, ax, az, vx, vz, a0, rings) => {
    const W = MBS.towerWidth / 2;
    const P = (a, y, v) => [cx + a * ax + v * vx, y, cz + a * az + v * vz];
    for (let k = 0; k + 1 < rings.length; k++) {
      const [y0, o0] = rings[k], [y1, o1] = rings[k + 1];
      const w0 = a0 + o0, e0 = a0 + o0 + MBS.legDepth, w1 = a0 + o1, e1 = a0 + o1 + MBS.legDepth;
      // west face (facing -a), east face (+a), then the two ends (v = -W, +W)
      glass.quad(P(w0, y0, W), P(w0, y0, -W), P(w1, y1, -W), P(w1, y1, W), [0, y0], [2 * W, y0], [2 * W, y1], [0, y1]);
      glass.quad(P(e0, y0, -W), P(e0, y0, W), P(e1, y1, W), P(e1, y1, -W), [0, y0], [2 * W, y0], [2 * W, y1], [0, y1]);
      glass.quad(P(w0, y0, -W), P(e0, y0, -W), P(e1, y1, -W), P(w1, y1, -W), [w0, y0], [e0, y0], [e1, y1], [w1, y1]);
      glass.quad(P(e0, y0, W), P(w0, y0, W), P(w1, y1, W), P(e1, y1, W), [e0, y0], [w0, y0], [w1, y1], [e1, y1]);
      // colliders: one turned box per ring step
      const am = (w0 + e1) / 2;
      const ha = Math.max(Math.abs(e1 - w0), Math.abs(e0 - w1)) / 2;
      colliders.push(obbCollider(cx + am * ax, cz + am * az, ha, W, ax, az, y0, y1));
    }
  };

  for (const [lat, lon] of MBS.towers) {
    const [x, z] = toWorld(lat, lon);
    const t = nearestT(x, z);
    const { vx, vz, ax, az } = axesAt(t);
    // the mapped foot spans both legs: the western leg's back at -16 + shift ... the eastern leg's foot at +36 + shift
    const shift = -(MBS.splay + MBS.legDepth * 2) / 2 + MBS.legDepth;
    const cx = x + shift * ax, cz = z + shift * az;
    addLeg(cx, cz, ax, az, vx, vz, -MBS.legDepth, legRings(() => 0)); // western, straight up
    addLeg(cx, cz, ax, az, vx, vz, 0, legRings((y) => (y >= MBS.merge ? 0 : MBS.splay * (1 - y / MBS.merge) ** 2))); // eastern, curved
    const W = MBS.towerWidth / 2;
    const fp = [];
    for (const [a, v] of [[-MBS.legDepth, -W], [MBS.legDepth + MBS.splay, -W], [MBS.legDepth + MBS.splay, W], [-MBS.legDepth, W]]) fp.push(cx + a * ax + v * vx, cz + a * az + v * vz);
    footprints.push({ pts: new Float32Array(fp), h: H });
  }
  const towers = new THREE.Mesh(glass.geometry(), towerGlassMaterial());
  towers.name = 'MBS_towers';
  group.add(towers);

  // The SkyPark: a ship's hull along the centreline, 38 m wide, tapering to the bow over the last quarter
  const deck = new Mesher();
  const pool = new Mesher();
  const [y0, y1] = MBS.deck;
  const N = 48;
  const width = (t) => (t < 0.03 ? 30 + (t / 0.03) * 8 : t < 0.74 ? 38 : 38 * Math.cos(((t - 0.74) / 0.26) * Math.PI * 0.46) + 2);
  const sections = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const p = line.getPointAt(t);
    const { ax, az } = axesAt(t);
    sections.push({ t, x: p.x, z: p.z, ax, az, w: width(t) / 2 });
  }
  // profile across: deck edge, deck edge, hull edge, keel, hull edge
  const profile = (s) => {
    const P = (a, y) => [s.x + a * s.ax, y, s.z + a * s.az];
    return [P(-s.w, y1), P(s.w, y1), P(s.w, y1 - 3.2), P(0, y0 - 1), P(-s.w, y1 - 3.2)];
  };
  for (let i = 0; i < N; i++) {
    const A = profile(sections[i]), B = profile(sections[i + 1]);
    for (let k = 0; k < 5; k++) {
      const k1 = (k + 1) % 5;
      deck.quad(A[k], A[k1], B[k1], B[k]);
    }
  }
  // the ends
  const capA = profile(sections[0]), capB = profile(sections[N]);
  for (const [cap, flip] of [[capA, false], [capB, true]]) {
    for (let k = 1; k < 4; k++) flip ? deck.tri(cap[0], cap[k], cap[k + 1]) : deck.tri(cap[0], cap[k + 1], cap[k]);
  }
  // the infinity pool along the western (bay) edge, over the northern two towers, and the gardens down the middle
  for (let i = Math.round(N * 0.3); i < Math.round(N * 0.72); i++) {
    const a = sections[i], b = sections[i + 1];
    const P = (s, off, y) => [s.x + (-s.w + off) * s.ax, y, s.z + (-s.w + off) * s.az];
    pool.quad(P(a, 11, y1 + 0.12), P(a, 0.6, y1 + 0.12), P(b, 0.6, y1 + 0.12), P(b, 11, y1 + 0.12));
  }
  const deckMesh = new THREE.Mesh(deck.geometry(), deckMaterial());
  deckMesh.name = 'MBS_skypark';
  const poolMesh = new THREE.Mesh(pool.geometry(), poolMaterial());
  poolMesh.name = 'MBS_pool';
  group.add(deckMesh, poolMesh);
  const garden = new THREE.InstancedMesh(new THREE.ConeGeometry(2.2, 6, 6).translate(0, 3, 0), gardenMaterial(), 30);
  const m = new THREE.Matrix4();
  for (let i = 0; i < 30; i++) {
    const s = sections[Math.round(4 + (i / 29) * (N * 0.7))];
    const side = (i % 3) - 1;
    m.makeTranslation(s.x + (side * 7 + 4) * s.ax, y1, s.z + (side * 7 + 4) * s.az);
    garden.setMatrixAt(i, m);
  }
  garden.name = 'MBS_gardens';
  group.add(garden);
  // deck colliders (land the helicopter on the SkyPark)
  for (let i = 0; i < N; i += 4) {
    const a = sections[i], b = sections[Math.min(N, i + 4)];
    const ux = b.x - a.x, uz = b.z - a.z, L = Math.hypot(ux, uz);
    colliders.push(obbCollider((a.x + b.x) / 2, (a.z + b.z) / 2, L / 2, Math.max(a.w, b.w), ux / L, uz / L, y0 - 1, y1));
  }

  // Spectra: beams from the SkyPark sweeping the sky at night
  const beamMat = new THREE.MeshBasicNodeMaterial({ color: 0x9fdcff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  beamMat.opacityNode = nightNode().mul(0.32);
  const beamGeo = new THREE.CylinderGeometry(0.6, 3.5, 900, 8, 1, true).translate(0, 450, 0);
  const beams = [];
  for (let i = 0; i < 6; i++) {
    const s = sections[Math.round(N * (0.12 + i * 0.12))];
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.position.set(s.x, y1 + 1, s.z);
    beam.castShadow = beam.receiveShadow = false;
    beam.frustumCulled = false;
    beam.visible = false;
    beam.userData.phase = i * 1.1;
    beams.push(beam);
    group.add(beam);
  }
  for (const mesh of [towers, deckMesh, poolMesh, garden]) mesh.castShadow = mesh.receiveShadow = true;
  // the SkyPark's outline for the maps
  const fp = [];
  for (const s of sections) fp.push(s.x - s.w * s.ax, s.z - s.w * s.az);
  for (let i = N; i >= 0; i--) { const s = sections[i]; fp.push(s.x + s.w * s.ax, s.z + s.w * s.az); }
  footprints.push({ pts: new Float32Array(fp), h: y1 });

  const update = (elapsed, night) => {
    for (const beam of beams) {
      beam.visible = night;
      if (!night) continue;
      const ph = beam.userData.phase + elapsed * 0.25;
      beam.rotation.set(Math.sin(ph) * 0.5, 0, Math.cos(ph * 0.7) * 0.5);
    }
  };
  return { group, update };
}

// ---------------------------------------------------------------------------------------------------------------------
// Singapore Flyer
// ---------------------------------------------------------------------------------------------------------------------
const FLYER = {
  hub: [1.289409, 103.863126],
  // two points along the wheel's plane (its mapped slices' ends)
  plane: [[1.289803, 103.863628], [1.289014, 103.862624]],
  hubHeight: 90, // 150 m wheel, 165 m to the top
  radius: 75,
  capsules: 28,
  period: 32 * 60, // s per turn
  marinaCentre: [1.2925, 103.858] // seen from here it turns clockwise
};

function buildSingaporeFlyer(toWorld, colliders, footprints) {
  const group = new THREE.Group();
  group.name = 'SingaporeFlyer';
  const [hx, hz] = toWorld(...FLYER.hub);
  const [ax0, az0] = toWorld(...FLYER.plane[0]);
  const [ax1, az1] = toWorld(...FLYER.plane[1]);
  let dx = ax1 - ax0, dz = az1 - az0;
  const L = Math.hypot(dx, dz);
  dx /= L; dz /= L;
  // the axle: across the plane, pointing towards Marina Centre
  const [mx, mz] = toWorld(...FLYER.marinaCentre);
  let nx = -dz, nz = dx;
  if ((mx - hx) * nx + (mz - hz) * nz < 0) { nx = -nx; nz = -nz; }
  // local frame: x along the plane, y up, z along the axle (towards Marina Centre)
  const frame = new THREE.Group();
  frame.position.set(hx, FLYER.hubHeight, hz);
  frame.matrixAutoUpdate = false;
  frame.matrix.set(dx, 0, nx, hx, 0, 1, 0, FLYER.hubHeight, dz, 0, nz, hz, 0, 0, 0, 1);
  group.add(frame);

  const R = FLYER.radius;
  const steel = steelMaterial();
  // the wheel (turns about the axle): two rims of a truss joined by struts, cable spokes, the hub
  const wheel = new THREE.Group();
  const rims = [];
  for (const z of [-3, 3]) rims.push(new THREE.TorusGeometry(R, 0.9, 5, 112).translate(0, 0, z));
  const rimMesh = new THREE.Mesh(mergeGeometries(rims), rimLightMaterial());
  const parts = [];
  const strut = (a, b, r) => {
    const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
    const len = va.distanceTo(vb);
    const g = new THREE.CylinderGeometry(r, r, len, 4, 1, true);
    g.translate(0, len / 2, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
    g.applyQuaternion(q);
    g.translate(va.x, va.y, va.z);
    parts.push(g);
  };
  const S = 56;
  for (let i = 0; i < S; i++) {
    const a = (i / S) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    // spokes: each rim to the far end of the hub (crossed)
    const side = i % 2 ? 1 : -1;
    strut([0, 0, -side * 5.5], [R * c, R * s, side * 3], 0.12);
    // cross-struts between the rims
    if (i % 2 === 0) strut([R * c, R * s, -3], [R * c, R * s, 3], 0.35);
  }
  parts.push(new THREE.CylinderGeometry(3.2, 3.2, 12, 12).rotateX(Math.PI / 2));
  const wheelSteel = new THREE.Mesh(mergeGeometries(parts), steel);
  wheel.add(rimMesh, wheelSteel);
  frame.add(wheel);

  // two A-frames, one each side, from the axle ends down to the ground
  const legs = [];
  for (const side of [-1, 1]) {
    for (const along of [-1, 1]) {
      const top = new THREE.Vector3(0, 0, side * 7);
      const foot = new THREE.Vector3(along * 34, -FLYER.hubHeight + 6, side * 21);
      const len = top.distanceTo(foot);
      const g = new THREE.CylinderGeometry(1.4, 2.2, len, 8, 1);
      g.translate(0, -len / 2, 0);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), foot.clone().sub(top).normalize()));
      g.translate(top.x, top.y, top.z);
      legs.push(g);
      // the feet as colliders
      const fx = hx + foot.x * dx + foot.z * nx, fz = hz + foot.x * dz + foot.z * nz;
      colliders.push(obbCollider(fx, fz, 2.5, 2.5, dx, dz, 0, 20));
    }
    legs.push(new THREE.CylinderGeometry(2.6, 2.6, 6, 10).rotateX(Math.PI / 2).translate(0, 0, side * 8.5));
  }
  const support = new THREE.Mesh(mergeGeometries(legs), steel);
  frame.add(support);

  // 28 capsules outboard of the rim, each along the axle, kept level as the wheel turns
  const capGeo = new THREE.CapsuleGeometry(2.1, 3.6, 4, 10).rotateX(Math.PI / 2);
  const capsules = new THREE.InstancedMesh(capGeo, capsuleMaterial(), FLYER.capsules);
  capsules.frustumCulled = false;
  frame.add(capsules);
  for (const mesh of [rimMesh, wheelSteel, support, capsules]) mesh.castShadow = mesh.receiveShadow = true;

  const m = new THREE.Matrix4();
  let lastAngle = NaN;
  const update = (elapsed) => {
    // clockwise seen from +z (Marina Centre): a negative turn about +z
    const angle = -(elapsed / FLYER.period) * Math.PI * 2;
    if (Math.abs(angle - lastAngle) < 1e-5) return;
    lastAngle = angle;
    wheel.rotation.z = angle;
    for (let i = 0; i < FLYER.capsules; i++) {
      const a = angle + (i / FLYER.capsules) * Math.PI * 2;
      m.makeTranslation(Math.cos(a) * (R + 3.4), Math.sin(a) * (R + 3.4) - 0.6, 0);
      capsules.setMatrixAt(i, m);
    }
    capsules.instanceMatrix.needsUpdate = true;
  };
  update(0);

  // the wheel's ground projection for the maps
  footprints.push({ pts: new Float32Array([hx - dx * R - nx * 3, hz - dz * R - nz * 3, hx + dx * R - nx * 3, hz + dz * R - nz * 3,
    hx + dx * R + nx * 3, hz + dz * R + nz * 3, hx - dx * R + nx * 3, hz - dz * R + nz * 3]), h: FLYER.hubHeight + R });
  return { group, update };
}

// Minimal BufferGeometryUtils.mergeGeometries for non-indexed / indexed geometries with the same attributes
function mergeGeometries(geometries) {
  const out = new THREE.BufferGeometry();
  const names = ['position', 'normal', 'uv'];
  const arrays = Object.fromEntries(names.map((n) => [n, []]));
  for (let g of geometries) {
    if (g.index) g = g.toNonIndexed();
    for (const n of names) {
      const a = g.getAttribute(n);
      if (a) for (let i = 0; i < a.array.length; i++) arrays[n].push(a.array[i]);
      else for (let i = 0; i < g.getAttribute('position').count * (n === 'uv' ? 2 : 3); i++) arrays[n].push(0);
    }
  }
  out.setAttribute('position', new THREE.Float32BufferAttribute(arrays.position, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(arrays.normal, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(arrays.uv, 2));
  out.computeBoundingSphere();
  return out;
}

function buildSingaporeLandmarks(scene) {
  const t0 = performance.now();
  const toWorld = makeToWorld(GEO.frame);
  const colliders = [];
  const footprints = [];
  const group = new THREE.Group();
  group.name = 'SingaporeLandmarks';
  const mbs = buildMarinaBaySands(toWorld, colliders, footprints);
  const flyer = buildSingaporeFlyer(toWorld, colliders, footprints);
  group.add(mbs.group, flyer.group);
  scene.add(group);
  console.info(`[landmarks] Marina Bay Sands & the Singapore Flyer in ${Math.round(performance.now() - t0)} ms`);
  return {
    group,
    colliders,
    footprints,
    update(elapsed, night = false) {
      mbs.update(elapsed, night);
      flyer.update(elapsed);
    }
  };
}

export { buildSingaporeLandmarks, makeToWorld, MBS, FLYER };

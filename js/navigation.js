import { signalPhase, nearestRoads } from './city-config.js';

// js/navigation.js
// Drive to a destination over the road graph traffic.js drives on (road-network.js): A* over its directed edges and
// the moves between them, a lane-level path (lane changes before each turn, the network's own lane-to-lane curves
// through the intersections), turn-by-turn guidance, and three drivers for it:
// - you: the route and the next turn are shown, you drive
// - self: a cautious self-driving taxi — pure-pursuit steering and a speed profile from the path's curvature, it keeps
//   its lane, stops for red (and amber it can stop for) lights, follows the vehicle ahead and waits for people in the
//   road
// - crazy: a Crazy Taxi driver on the clock — flat out, every light is green, it swerves around anything slower into
//   whichever lane is free (the oncoming ones too), honks, and scores near misses into the fare
// The autopilots drive the player's own car through the same inputs as the keyboard (controllers.js
// setAutopilotInput), so the car's physics, collisions and the traffic's reactions to it are the ordinary ones.
// Touching the throttle, brake or steering takes over.
//
// Conventions as road-network.js: north = -z, east = +x, an edge's direction (dx, dz) and right normal (rx, rz); the
// player's heading h faces (sin h, cos h) and steering left raises it.

const SAMPLE = 3; // metres between path points along an edge
const CURVE_SAMPLE = 1.5; // and along an intersection curve
// The car (controllers.js): a bicycle model on a 2.76 m wheelbase, steering up to 0.6 rad at parking speeds and less
// with speed (so its tyres corner at up to 10.5 m/s²), 9.5 m/s² of grip for braking and cornering together
const WHEELBASE = 2.76;
const CORNERING = 10.5;
const MAX_LOCK = 0.6;
const maxSteerAt = (v) => Math.atan((WHEELBASE * CORNERING) / Math.max(v * v, (WHEELBASE * CORNERING) / Math.tan(MAX_LOCK)));
const MAX_CURVATURE = Math.tan(MAX_LOCK) / WHEELBASE;
const CAR_HALF_L = 2.2;
const CAR_HALF_W = 0.9;

const DRIVERS = {
  you: { id: 'you', label: 'You drive', auto: false, offRoute: 28 },
  self: {
    id: 'self', label: 'Self-driving', auto: true, offRoute: 14,
    cruise: 13.9, // 50 km/h, Singapore's default urban limit
    aLat: 2.0, brake: 2.6, hardBrake: 7, gap0: 4.0, gapTime: 1.3, margin: 0.45,
    signals: true, peds: true, lookahead: [4.5, 0.42], turnPenalty: 8, signalPenalty: 12
  },
  crazy: {
    id: 'crazy', label: 'Crazy Taxi', auto: true, offRoute: 20,
    cruise: 34,
    aLat: 8.0, brake: 7.0, hardBrake: 9, gap0: 1.2, gapTime: 0.25, margin: 0.15,
    signals: false, peds: false, lookahead: [5, 0.5], turnPenalty: 14, signalPenalty: 0
  }
};

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------------------------------------

// Where (x, z) is on edge e: distance along it (clamped), across it (to its right) and from it
function onEdge(e, x, z) {
  const ax = x - e.sx;
  const az = z - e.sz;
  const along = ax * e.dx + az * e.dz;
  const s = clamp(along, 0, e.len);
  const across = ax * e.rx + az * e.rz;
  // distance to the nearest of its lanes, the overhang past its ends counting in full
  let lateral = Infinity;
  for (const o of e.lanes) lateral = Math.min(lateral, Math.abs(across - o));
  if (!e.lanes.length) lateral = Math.abs(across);
  return { s, across, dist: Math.hypot(along - s, lateral) };
}

// The edge to start from: close by, and facing the way the car does (a car facing the wrong way picks the edge it's on
// all the same when nothing better is near)
function findStartEdge(network, x, z, heading, radius = 45) {
  const hx = Math.sin(heading);
  const hz = Math.cos(heading);
  let best = null;
  for (const e of network.edges) {
    if (Math.abs(e.sx + e.dx * e.len * 0.5 - x) > e.len * 0.5 + radius || Math.abs(e.sz + e.dz * e.len * 0.5 - z) > e.len * 0.5 + radius) continue;
    const p = onEdge(e, x, z);
    if (p.dist > radius) continue;
    const facing = hx * e.dx + hz * e.dz;
    const score = p.dist + (1 - facing) * 9;
    if (!best || score < best.score) best = { edge: e, s: p.s, across: p.across, score };
  }
  return best;
}

// Edges the destination can be reached on, with the distance from each to it: the nearest and others a little further
// (the other way along a two-way street, the street round the corner, the one across the plaza), which the search
// weighs against the drive to each, so a one-way loop doesn't send it round the city for the nearest kerb
function findGoalEdges(network, x, z, radius = 260) {
  const found = [];
  for (const e of network.edges) {
    if (Math.abs(e.sx + e.dx * e.len * 0.5 - x) > e.len * 0.5 + radius || Math.abs(e.sz + e.dz * e.len * 0.5 - z) > e.len * 0.5 + radius) continue;
    const p = onEdge(e, x, z);
    if (p.dist <= radius) found.push({ edge: e, s: clamp(p.s, Math.min(3, e.len * 0.5), e.len), dist: p.dist });
  }
  found.sort((a, b) => a.dist - b.dist);
  if (!found.length) return [];
  const near = found[0].dist + 120;
  return found.filter((g) => g.dist <= near).slice(0, 40).map((g) => ({ ...g, extra: (g.dist - found[0].dist) * 4 }));
}

// Binary min-heap of [priority, ...payload]
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Shortest drive from (start.x, start.z) facing start.heading to (goal.x, goal.z): { edges, moves, s0, s1 } — the edges
 * driven in order, the move taken from each to the next, where along the first it starts and along the last it ends —
 * or null when the destination can't be reached. Turns, U-turns and signals cost a little extra, by driver.
 */
function planRoute(network, start, goal, driver = DRIVERS.self) {
  const from = findStartEdge(network, start.x, start.z, start.heading) || findStartEdge(network, start.x, start.z, start.heading, 300);
  const goals = findGoalEdges(network, goal.x, goal.z);
  if (!from || !goals.length) return null;
  const goalS = new Map(goals.map((g) => [g.edge, g.s]));
  const goalExtra = new Map(goals.map((g) => [g.edge, g.extra || 0]));
  const turnPenalty = driver.turnPenalty ?? 6;
  const signalPenalty = driver.signalPenalty ?? 8;
  const h = (e) => Math.hypot(e.sx + e.dx * e.len - goal.x, e.sz + e.dz * e.len - goal.z) * 0.98;
  const stepCost = (e, m) => {
    const f = m.to;
    const ex = e.sx + e.dx * e.len;
    const ez = e.sz + e.dz * e.len;
    let c = Math.hypot(f.sx - ex, f.sz - ez) * 1.15;
    if (m.uturn) c += 45;
    else if (m.turn !== 'S') c += turnPenalty;
    if (e.to.signal) c += signalPenalty;
    return c;
  };

  // Search states are edges, g the cost to the start of the edge. The start edge is left from a virtual start part way
  // along it, so a destination behind the car on the same edge is reached by going round the block
  const g = new Map();
  const prev = new Map(); // edge -> [previous edge, move]
  const heap = new Heap(); // [priority, cost, edge, finish]
  const s0 = from.s;
  const startEdge = from.edge;
  const sGoalStart = goalS.get(startEdge);
  if (sGoalStart !== undefined && sGoalStart > s0 + 4) heap.push([sGoalStart - s0 + goalExtra.get(startEdge), sGoalStart - s0, startEdge, 'direct']);
  for (const m of startEdge.moves) {
    const c = startEdge.len - s0 + stepCost(startEdge, m);
    if (!g.has(m.to) || c < g.get(m.to)) {
      g.set(m.to, c);
      prev.set(m.to, [startEdge, m]);
      heap.push([c + h(m.to), c, m.to, false]);
    }
  }
  const closed = new Set();
  let expansions = 0;
  while (heap.size && expansions++ < 400000) {
    const [, cost, e, finish] = heap.pop();
    if (finish) {
      const edges = [e];
      const moves = [];
      if (finish !== 'direct') {
        // back to the start edge (entered from the virtual start: nothing reached through the start edge driven round
        // the block can beat reaching it directly, so its successors' prev entries are the virtual start's)
        let cur = e;
        for (let guard = 0; guard < 100000; guard++) {
          const [p, m] = prev.get(cur);
          edges.push(p);
          moves.push(m);
          if (p === startEdge) break;
          cur = p;
        }
        edges.reverse();
        moves.reverse();
      }
      return { edges, moves, s0, s1: goalS.get(e), length: cost, start: from };
    }
    if (closed.has(e)) continue;
    closed.add(e);
    if (goalS.has(e)) heap.push([cost + goalS.get(e) + goalExtra.get(e), cost + goalS.get(e), e, 'goal']);
    for (const m of e.moves) {
      const f = m.to;
      if (closed.has(f)) continue;
      const c = cost + e.len + stepCost(e, m);
      if (!g.has(f) || c < g.get(f)) {
        g.set(f, c);
        prev.set(f, [e, m]);
        heap.push([c + h(f), c, f, false]);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Path: lane-level polyline with speed limits, maneuvers and stop lines
// ---------------------------------------------------------------------------------------------------------------------

// The lane of e nearest lane offset `o`, out of the lanes allowed (indices) — all of them when `allowed` is empty
function nearestLaneIndex(e, o, allowed) {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < e.lanes.length; i++) {
    if (allowed && !allowed.includes(i)) continue;
    const d = Math.abs(e.lanes[i] - o);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

const smooth = (t) => t * t * (3 - 2 * t);

function edgeName(e) {
  if (e.navName !== undefined) return e.navName;
  const x = e.sx + e.dx * e.len * 0.5;
  const z = e.sz + e.dz * e.len * 0.5;
  let name = '';
  try {
    const near = nearestRoads(x, z, 30);
    // the road running the edge's way (not the cross street at its end)
    const along = near.find((r) => r.dist < 18) || near[0];
    name = along ? along.road.name : '';
  } catch { /* no road index (tests) */ }
  e.navName = name;
  return name;
}

/**
 * The path of a route as points { x, z, s (metres along), tx, tz (unit tangent), k (curvature), v (speed limit) },
 * its maneuvers { s, turn, uturn, cross, name, edge } at each intersection and its stop lines { s, edge } at signals,
 * starting at (x, z) where the car is now.
 */
function buildPath(network, route, x, z, driver = DRIVERS.self) {
  const pts = [];
  const maneuvers = [];
  const stops = [];
  const add = (px, pz, edge = null, lane = 0) => {
    const last = pts[pts.length - 1];
    if (last && Math.hypot(px - last.x, pz - last.z) < 0.4) return;
    pts.push({ x: px, z: pz, s: 0, tx: 0, tz: 1, nx: 1, nz: 0, k: 0, v: 0, edge, lane });
  };
  add(x, z);
  const { edges, moves } = route;
  let entry = -1; // lane index entering the current edge
  const pt = { x: 0, z: 0, dx: 0, dz: 1 };
  for (let k = 0; k < edges.length; k++) {
    const e = edges[k];
    const m = moves[k];
    const first = k === 0;
    const last = k === edges.length - 1;
    const sA = first ? route.s0 : 0;
    const sB = last ? route.s1 : e.len;
    if (entry < 0) entry = nearestLaneIndex(e, first ? route.start.across : 0);
    // the lane the move out of e leaves from: the nearest to the one entered that the move allows
    let exit = entry;
    if (m) {
      const allowed = [];
      for (let i = 0; i < e.lanes.length; i++) if (m.out[i] >= 0) allowed.push(i);
      if (allowed.length && !allowed.includes(entry)) exit = nearestLaneIndex(e, e.lanes[entry], allowed);
    } else if (last) {
      // arriving: pull over into the kerbside lane (lanes run left to right)
      exit = network.keepLeft ? 0 : e.lanes.length - 1;
    }
    const oA = e.lanes[entry] ?? 0;
    const oB = e.lanes[exit] ?? 0;
    const span = Math.max(0, sB - sA);
    // lane change: 14 m a lane, over at most three quarters of what's left of the edge, starting soon
    const lc = Math.abs(oB - oA) < 0.1 ? 0 : Math.min(span * 0.75, 6 + 4 * Math.abs(oB - oA));
    const c0 = sA + Math.min(first ? 6 : 2, span * 0.15);
    const c1 = c0 + lc;
    const lane = (s) => (lc <= 0 || s <= c0 ? (s <= c0 ? oA : oB) : s >= c1 ? oB : oA + (oB - oA) * smooth((s - c0) / lc));
    // the car's own spot leads onto the lane a few metres on
    const begin = first ? Math.min(sB, sA + Math.min(7, span * 0.5)) : sA;
    for (let s = begin; s < sB; s += SAMPLE) add(e.sx + e.dx * s + e.rx * lane(s), e.sz + e.dz * s + e.rz * lane(s), e, lane(s));
    add(e.sx + e.dx * sB + e.rx * oB, e.sz + e.dz * sB + e.rz * oB, e, oB);
    if (!m) break;
    const f = m.to;
    const j = m.out[exit] >= 0 ? m.out[exit] : nearestLaneIndex(f, oB);
    const at = pts.length - 1;
    if (e.to.signal) stops.push({ i: at, edge: e });
    maneuvers.push({ i: at, turn: m.turn, uturn: !!m.uturn, cross: m.cross || 0, edge: f, from: e });
    const c = network.connector(e, exit, f, j);
    for (let s = CURVE_SAMPLE; s < c.len; s += CURVE_SAMPLE) {
      network.curvePoint(c, s, pt);
      add(pt.x, pt.z);
    }
    entry = j;
  }

  // arc length, tangents, normals, curvature
  for (let i = 1; i < pts.length; i++) pts[i].s = pts[i - 1].s + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const p = pts[i];
    p.tx = (b.x - a.x) / L;
    p.tz = (b.z - a.z) / L;
    p.nx = -p.tz; // right normal, as road-network.js
    p.nz = p.tx;
  }
  // curvature: turning of the tangent over a few metres either side
  for (let i = 0; i < pts.length; i++) {
    let i0 = i;
    let i1 = i;
    while (i0 > 0 && pts[i].s - pts[i0].s < 3) i0--;
    while (i1 < pts.length - 1 && pts[i1].s - pts[i].s < 3) i1++;
    const ds = pts[i1].s - pts[i0].s;
    const turn = Math.abs(wrapAngle(Math.atan2(pts[i1].tx, pts[i1].tz) - Math.atan2(pts[i0].tx, pts[i0].tz)));
    pts[i].k = ds > 0.5 ? turn / ds : 0;
  }
  const path = { pts, maneuvers, stops, length: pts.length ? pts[pts.length - 1].s : 0, route };
  for (const mv of maneuvers) {
    mv.s = pts[mv.i].s;
    mv.name = edgeName(mv.edge);
  }
  for (const st of stops) st.s = pts[st.i].s;
  speedProfile(path, driver);
  return path;
}

// The speed limit at each point: what the curve allows (lateral acceleration, and how fast the car can turn), and
// braking in time for slower points ahead and the end
function speedProfile(path, driver) {
  const { pts } = path;
  const cruise = driver.cruise ?? 13.9;
  const aLat = driver.aLat ?? 2.5;
  const b = driver.brake ?? 3;
  for (const p of pts) {
    const k = Math.max(p.k, 1e-4);
    // (a corner tighter than full lock allows is taken at a crawl)
    p.v = k > MAX_CURVATURE * 0.9 ? Math.min(cruise, 2.5) : Math.min(cruise, Math.sqrt(aLat / k));
  }
  if (pts.length) pts[pts.length - 1].v = 0;
  for (let i = pts.length - 2; i >= 0; i--) {
    pts[i].v = Math.min(pts[i].v, Math.sqrt(pts[i + 1].v ** 2 + 2 * b * (pts[i + 1].s - pts[i].s)));
  }
}

// The point at arc length s (interpolated), offset `off` metres to the right of the path
function pointAt(path, s, off = 0, out = {}) {
  const { pts } = path;
  let i = out.hint ?? 0;
  i = clamp(i, 0, pts.length - 1);
  while (i > 0 && pts[i].s > s) i--;
  while (i < pts.length - 2 && pts[i + 1].s < s) i++;
  const a = pts[i];
  const b = pts[Math.min(pts.length - 1, i + 1)];
  const L = b.s - a.s;
  const t = L > 1e-6 ? clamp((s - a.s) / L, 0, 1) : 0;
  out.hint = i;
  out.x = a.x + (b.x - a.x) * t + (a.nx + (b.nx - a.nx) * t) * off;
  out.z = a.z + (b.z - a.z) * t + (a.nz + (b.nz - a.nz) * t) * off;
  out.v = a.v + (b.v - a.v) * t;
  out.tx = a.tx;
  out.tz = a.tz;
  return out;
}

// Nearest point of the path to (x, z), searched from point index `from` over `window` points: { i, s, dist, across }
function locate(path, x, z, from = 0, window = 60) {
  const { pts } = path;
  let best = { i: from, s: pts[from]?.s ?? 0, dist: Infinity, across: 0 };
  const i0 = Math.max(0, from - 6);
  const i1 = Math.min(pts.length - 1, from + window);
  for (let i = i0; i < i1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const L2 = ex * ex + ez * ez || 1e-9;
    const t = clamp(((x - a.x) * ex + (z - a.z) * ez) / L2, 0, 1);
    const px = a.x + ex * t;
    const pz = a.z + ez * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best.dist - 1e-6) {
      const L = Math.sqrt(L2);
      best = { i, s: a.s + t * L, dist: d, across: ((x - px) * -ez + (z - pz) * ex) / L };
    }
  }
  if (pts.length === 1) best = { i: 0, s: 0, dist: Math.hypot(x - pts[0].x, z - pts[0].z), across: 0 };
  return best;
}

// ---------------------------------------------------------------------------------------------------------------------
// Steering & speed
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Steering input (-1 right .. 1 left) to bring a car at (x, z) heading h at speed v round to (tx, tz): pure pursuit,
 * the curvature through the target turned into the steering angle that gives it at this speed.
 */
function pursuitSteer(x, z, heading, speed, tx, tz) {
  const dx = tx - x;
  const dz = tz - z;
  const Ld = Math.hypot(dx, dz);
  if (Ld < 0.05) return 0;
  const alpha = wrapAngle(Math.atan2(dx, dz) - heading);
  const v = Math.abs(speed);
  // the wheel angle whose arc runs through the target, as a share of what the car allows at this speed
  const curvature = (2 * Math.sin(alpha)) / Ld;
  const steer = Math.atan(curvature * WHEELBASE) / maxSteerAt(v);
  return clamp(steer, -1, 1) * Math.sign(speed || 1);
}

// Throttle / brake for a speed target: forward or backward strength 0..1 (backward only brakes while moving)
function speedControl(speed, target, hard = false) {
  const dv = target - speed;
  if (dv > 0.25) return { forward: clamp(0.35 + dv * 0.5, 0, 1), backward: 0 };
  if (speed > 0.4 && dv < -0.5) return { forward: 0, backward: clamp((-dv) / (hard ? 1.2 : 3.5), 0.12, 1) };
  return { forward: 0, backward: 0 };
}

// Speed allowed to stop `d` metres ahead decelerating at b
const stopSpeed = (d, b) => (d <= 0 ? 0 : Math.sqrt(2 * b * d));

// ---------------------------------------------------------------------------------------------------------------------
// The navigator
// ---------------------------------------------------------------------------------------------------------------------

class Navigator {
  /**
   * @param {object} deps network (road-network.js), trafficSystem (cars, buses, peds), controllerManager, audioSystem,
   *   and onChange(state) / onEvent(kind, detail) callbacks for the HUD
   */
  constructor({ network, trafficSystem, controllerManager, audioSystem = null, onChange = null, onEvent = null }) {
    this.network = network;
    this.traffic = trafficSystem;
    this.controllers = controllerManager;
    this.audio = audioSystem;
    this.onChange = onChange;
    this.onEvent = onEvent;
    this.driver = DRIVERS.you;
    this.destination = null; // { x, z, name }
    this.path = null;
    this.progress = 0; // metres along the path
    this.index = 0; // its point index
    this.offRouteTime = 0;
    this.lastReroute = -Infinity;
    this.time = 0;
    this.arrived = false;
    // autopilot state
    this.offset = 0; // metres right of the path (Crazy Taxi swerving)
    this.offsetTarget = 0;
    this.swerveHold = 0;
    this.stuckTime = 0;
    this.reverseTime = 0;
    this.lastSpeed = 0;
    this.status = '';
    this.input = { forward: 0, backward: 0, left: 0, right: 0 };
    this.honkTimer = 0;
    // Crazy Taxi
    this.fare = null; // { start, base, bonus, timeLeft, nearMisses, combo, crashes }
    this.nearMissSeen = new WeakMap();
    this.nextFareAt = 0;
    this._pt = {};
  }

  get active() { return Boolean(this.destination); }
  get autopilot() { return this.active && this.driver.auto && !this.arrived && this.controllers.activeMode === 'car'; }

  setDriver(id) {
    const d = DRIVERS[id] || DRIVERS.you;
    if (d === this.driver) return;
    this.driver = d;
    this.offset = this.offsetTarget = 0;
    this.stuckTime = this.reverseTime = 0;
    if (!d.auto) this.controllers.setAutopilotInput(null);
    if (d.id === 'crazy' && this.destination && !this.arrived) this.startFare();
    if (d.id !== 'crazy') this.fare = null;
    if (this.destination && !this.arrived) this.reroute(true);
    this.changed();
  }

  /** Plan a trip to (x, z) from where the player is; false if no road leads there */
  setDestination(x, z, name = '') {
    this.destination = { x, z, name };
    this.arrived = false;
    this.nextFareAt = 0;
    const ok = this.reroute(true);
    if (!ok) {
      this.destination = null;
      this.path = null;
      this.controllers.setAutopilotInput(null);
      this.changed();
      this.event('noroute', { name });
      return false;
    }
    if (this.driver.id === 'crazy') this.startFare();
    this.changed();
    return true;
  }

  clear() {
    this.destination = null;
    this.path = null;
    this.fare = null;
    this.arrived = false;
    this.controllers.setAutopilotInput(null);
    this.changed();
  }

  reroute(force = false) {
    if (!this.destination) return false;
    if (!force && this.time - this.lastReroute < 1.5) return Boolean(this.path);
    this.lastReroute = this.time;
    const ent = this.controllers.getActiveEntity();
    const route = planRoute(this.network, { x: ent.position.x, z: ent.position.z, heading: ent.heading }, this.destination, this.driver.auto ? this.driver : DRIVERS.self);
    if (!route) return false;
    this.path = buildPath(this.network, route, ent.position.x, ent.position.z, this.driver.auto ? this.driver : DRIVERS.self);
    this.index = 0;
    this.progress = 0;
    this.offRouteTime = 0;
    this.offset = this.offsetTarget = 0;
    if (this.fare && !force) this.fare.reroutes++;
    this.changed();
    return true;
  }

  startFare() {
    const len = this.path ? this.path.length : 1000;
    this.fare = {
      // a Singapore taxi's flag-down, a fare by the kilometre (fareTotal), and the clock: the trip at a brisk 15 m/s
      base: 4.1, distance: 0, bonus: 0, timeLeft: Math.round(len / 15 + 12),
      nearMisses: 0, combo: 0, comboTimer: 0, crashes: 0, reroutes: 0, total: 0, tip: 0
    };
  }

  changed() { if (this.onChange) this.onChange(this.state()); }
  event(kind, detail = {}) { if (this.onEvent) this.onEvent(kind, detail); }

  /** For the HUD: the next maneuver, distances, the driver, the fare */
  state() {
    const path = this.path;
    const remaining = path ? Math.max(0, path.length - this.progress) : 0;
    let next = null;
    if (path) {
      for (const mv of path.maneuvers) {
        if (mv.s < this.progress - 2) continue;
        if (mv.turn === 'S' && !mv.uturn) continue;
        next = { kind: mv.uturn ? 'uturn' : Math.abs(mv.cross) < 0.75 ? (mv.turn === 'L' ? 'keepleft' : 'keepright') : mv.turn === 'L' ? 'left' : 'right', name: mv.name, distance: Math.max(0, mv.s - this.progress) };
        break;
      }
      if (!next || next.distance > remaining) next = { kind: 'arrive', name: this.destination?.name || '', distance: remaining };
    }
    const ent = this.controllers.getActiveEntity();
    const speed = Math.max(Math.abs(ent?.speed || 0), this.driver.id === 'crazy' ? 16 : 9);
    return {
      active: this.active,
      arrived: this.arrived,
      driver: this.driver.id,
      driverLabel: this.driver.label,
      destination: this.destination,
      remaining,
      eta: remaining / speed,
      next,
      status: this.status,
      autopilot: this.autopilot,
      carMode: this.controllers.activeMode === 'car',
      fare: this.fare ? { ...this.fare, total: this.fareTotal() } : null,
      route: path ? this.routeLine() : null
    };
  }

  fareTotal() {
    const f = this.fare;
    if (!f) return 0;
    return f.base + (f.distance / 1000) * 2.2 + f.bonus;
  }

  // The rest of the route as a polyline for the maps (every few metres)
  routeLine() {
    const pts = this.path.pts;
    const out = [];
    const ent = this.controllers.getActiveEntity();
    out.push({ x: ent.position.x, z: ent.position.z });
    let lastS = -Infinity;
    for (let i = this.index + 1; i < pts.length; i++) {
      if (pts[i].s - lastS < 6 && i < pts.length - 1) continue;
      lastS = pts[i].s;
      out.push({ x: pts[i].x, z: pts[i].z });
    }
    return out;
  }

  /** Call before controllerManager.update: follow the route, drive it when an autopilot is on */
  update(dt, elapsed) {
    this.time += dt;
    if (!this.destination) return;
    const ent = this.controllers.getActiveEntity();
    const mode = this.controllers.activeMode;
    const x = ent.position.x;
    const z = ent.position.z;

    // Crazy Taxi: next fare after a pause at the drop-off
    if (this.arrived) {
      // pull up at the drop-off, then hand the car back
      const braking = this.driver.auto && mode === 'car' && ent.speed > 0.3 && this.controllers.userDriveInput() < 0.15;
      this.controllers.setAutopilotInput(braking ? { forward: 0, backward: 0.7, left: 0, right: 0 } : null);
      if (this.nextFareAt && this.time >= this.nextFareAt) {
        this.nextFareAt = 0;
        this.event('nextfare', {});
      }
      return;
    }
    if (!this.path) {
      this.reroute();
      return;
    }

    // Where along the route the player is
    const loc = locate(this.path, x, z, this.index, 40);
    if (loc.dist < 30) {
      this.index = loc.i;
      this.progress = loc.s;
    }
    const offLimit = this.driver.offRoute + Math.abs(this.offset);
    this.offRouteTime = loc.dist > offLimit ? this.offRouteTime + dt : 0;
    if (this.offRouteTime > (this.driver.auto ? 0.6 : 1.2)) {
      this.offRouteTime = 0;
      if (this.reroute()) this.event('reroute', {});
      return;
    }

    // Arrival
    const end = this.path.pts[this.path.pts.length - 1];
    const toEnd = this.path.length - this.progress;
    const nearEnd = Math.hypot(end.x - x, end.z - z);
    if ((toEnd < 6 && nearEnd < 9 && Math.abs(ent.speed) < (this.driver.auto ? 1.2 : 4)) || (!this.driver.auto && nearEnd < 14)) {
      this.arrive();
      return;
    }

    if (this.fare) this.updateFare(dt, ent);

    if (!this.driver.auto) return;
    if (mode !== 'car') {
      this.status = 'Switch to the car to let it drive';
      this.controllers.setAutopilotInput(null);
      return;
    }
    // Taking over: any throttle, brake or steering of your own
    if (this.controllers.userDriveInput() > 0.15) {
      this.setDriver('you');
      this.event('takeover', {});
      return;
    }
    this.drive(dt, elapsed, ent);
  }

  arrive() {
    this.arrived = true;
    this.status = '';
    const fare = this.fare ? { ...this.fare, total: this.fareTotal() } : null;
    if (fare) {
      // a tip for the time left on the clock
      fare.tip = Math.max(0, fare.timeLeft) * 0.25;
      fare.total += fare.tip;
      this.fare.total = fare.total;
      this.nextFareAt = this.time + 4.5;
    }
    this.event('arrived', { name: this.destination?.name || '', fare });
    if (this.audio && this.audio.chime) this.audio.chime('erp');
    this.changed();
  }

  updateFare(dt, ent) {
    const f = this.fare;
    f.timeLeft = Math.max(0, f.timeLeft - dt);
    f.distance += Math.abs(ent.speed) * dt;
    f.comboTimer -= dt;
    if (f.comboTimer <= 0) f.combo = 0;
    // a crash: most of the speed gone in a moment
    const dv = this.lastSpeed - Math.abs(ent.speed);
    // (braking takes at most 9 m/s² x 0.05 s off in a frame)
    if (dv > 6 && this.lastSpeed > 9) {
      f.crashes++;
      f.combo = 0;
      f.bonus = Math.max(0, f.bonus - 1);
      this.event('crash', {});
    }
    this.lastSpeed = Math.abs(ent.speed);
    // near misses: passing another vehicle within a hand's breadth, fast
    const hx = Math.sin(ent.heading);
    const hz = Math.cos(ent.heading);
    for (const list of [this.traffic.cars, this.traffic.buses]) {
      if (!list) continue;
      for (const v of list) {
        if (!v.edge) continue;
        const dx = v.x - ent.position.x;
        const dz = v.z - ent.position.z;
        if (Math.abs(dx) > 9 || Math.abs(dz) > 9) continue;
        const along = dx * hx + dz * hz;
        const across = Math.abs(-dx * hz + dz * hx);
        const relSpeed = Math.abs(ent.speed - (v.speed || 0) * ((v.tx ?? 0) * hx + (v.tz ?? 1) * hz));
        const clearance = across - (v.halfWidth || 0.9) - CAR_HALF_W;
        if (Math.abs(along) < (v.half || 2.3) + CAR_HALF_L && clearance > 0.05 && clearance < 1.4 && relSpeed > 7) {
          const seen = this.nearMissSeen.get(v);
          if (seen && this.time - seen < 3) continue;
          this.nearMissSeen.set(v, this.time);
          f.nearMisses++;
          f.combo++;
          f.comboTimer = 3;
          const award = Math.min(5, f.combo) * 0.5;
          f.bonus += award;
          f.timeLeft += 1;
          this.event('nearmiss', { combo: f.combo, award });
        }
      }
    }
  }

  // ---- autopilot ----------------------------------------------------------------------------------------------------

  drive(dt, elapsed, car) {
    const d = this.driver;
    const path = this.path;
    const x = car.position.x;
    const z = car.position.z;
    const v = car.speed;
    const speed = Math.max(0, v);
    const s = this.progress;
    this.honkTimer -= dt;

    // Stuck against something (a kerb, a bollard, a car that won't move): back off a little, then try again
    if (this.reverseTime > 0) {
      this.reverseTime -= dt;
      const target = pointAt(path, s + 8, this.offset, this._pt);
      const steer = -pursuitSteer(x, z, car.heading, 2, target.x, target.z);
      this.setInput(0, 0.7, steer);
      this.status = 'Backing up';
      return;
    }

    // 1. Speed: the path's profile (a little ahead, so curves are met slowed down), then whatever is in the way
    let vTarget = pointAt(path, s + speed * 0.35, 0, this._pt).v;
    let reason = '';
    let hard = false;

    // Signals
    if (d.signals) {
      for (const st of path.stops) {
        const dist = st.s - s - CAR_HALF_L - 0.8;
        if (dist < -2) continue;
        if (dist > 90) break;
        const phase = signalPhase(elapsed, st.edge.axisIndex === 0);
        if (phase === 'green') continue;
        // amber: go on if it's too late to stop comfortably
        if (phase === 'amber' && speed * speed > 2 * d.brake * 1.6 * Math.max(0, dist)) continue;
        const vs = stopSpeed(dist, d.brake);
        if (vs < vTarget) {
          vTarget = vs;
          reason = phase === 'red' ? 'Red light' : 'Amber light';
          if (dist < 4) hard = true;
        }
        break;
      }
    }

    // Vehicles (and people) on the path ahead, at the current swerve offset
    // (at the line it's steering for and where the car actually is, which lags it during a lane change)
    const across = locate(path, x, z, this.index, 8).across;
    const leadA = this.leadOnPath(s, this.offset, 70, d.margin);
    const leadB = Math.abs(across - this.offset) > 0.6 ? this.leadOnPath(s, across, 70, d.margin) : null;
    const lead = leadB && (!leadA || leadB.gap < leadA.gap) ? leadB : leadA;
    if (lead) {
      // edging out round it (the car still behind it, steering for the other lane): creep up to a metre short
      const gap0 = lead === leadB ? 1.0 : d.gap0;
      const eff = lead.gap - gap0 - lead.speed * d.gapTime;
      const vl = eff >= 0 ? Math.sqrt(lead.speed * lead.speed + 2 * d.brake * eff) : Math.max(0, lead.speed + eff * 0.6);
      if (vl < vTarget) {
        vTarget = vl;
        reason = lead.ped ? 'Waiting for pedestrians' : 'Following traffic';
        if (eff < 1) hard = true;
      }
    }

    // Pinned behind a vehicle that isn't moving (a jam, a stalled car), and not for a red light: how long for
    this.blockedTime = lead && !lead.ped && lead.gap < 12 && lead.speed < 0.3 && speed < 0.6 && reason === 'Following traffic' ? (this.blockedTime || 0) + dt : 0;

    // 2. Crazy Taxi: anything slower ahead gets passed, on whichever side is free
    if (d.id === 'crazy') {
      this.swerveHold -= dt;
      // nose against a stopped car: reverse out and try another line
      if (this.blockedTime > 1.5) {
        this.blockedTime = 0;
        this.reverseTime = clamp((10 - lead.gap) / 3, 0.6, 2.2);
        const choice = this.findGap(s, 0);
        if (choice !== null) this.offsetTarget = choice;
        this.swerveHold = 2;
        this.honk(car);
      }
      const blocked = lead && lead.gap < 32 && vTarget < Math.min(d.cruise, pointAt(path, s + 10, 0, this._pt).v) - 3;
      if (blocked) {
        const choice = this.findGap(s, speed);
        if (choice !== null && choice !== this.offsetTarget) {
          this.offsetTarget = choice;
          this.swerveHold = 1.6;
          this.honk(car);
        } else if (choice === null) {
          this.honk(car);
        }
        if (choice !== null) {
          // the new line is clear: no need to slow for the old one
          const lead2 = this.leadOnPath(s, choice, 70, d.margin);
          const eff2 = lead2 ? lead2.gap - d.gap0 : Infinity;
          vTarget = Math.max(vTarget, Math.min(pointAt(path, s + speed * 0.35, 0, this._pt).v, eff2 === Infinity ? Infinity : Math.sqrt(2 * d.brake * Math.max(0, eff2))));
          reason = 'Overtaking';
        }
      } else if (this.offsetTarget !== 0 && this.swerveHold <= 0 && this.lineClear(s, 0, 4, 26)) {
        this.offsetTarget = 0;
      }
      // swerve faster at speed, never more than the car can turn
      const rate = 3 + speed * 0.25;
      this.offset += clamp(this.offsetTarget - this.offset, -rate * dt, rate * dt);
    } else {
      // Self-driving: overtake slow traffic in another lane of the same road going the same way, where there's one, and
      // be back in the path's lane well before the next turn
      this.swerveHold -= dt;
      const here = path.pts[this.index];
      const nextTurn = path.maneuvers.find((mv) => mv.s > s && (mv.turn !== 'S' || mv.uturn));
      const turnSoon = nextTurn && nextTurn.s - s < 70;
      const lanes = here && here.edge ? here.edge.lanes.map((o) => o - here.lane).filter((o) => Math.abs(o) > 0.5) : [];
      const slowAhead = lead && !lead.ped && lead.gap < 30 && lead.speed < d.cruise * 0.55;
      // stuck behind a stopped vehicle (not a red light) for a while: go round it, oncoming lanes too when they're clear
      const stalled = this.blockedTime > 8;
      if ((stalled || (!turnSoon && slowAhead)) && this.swerveHold <= 0 && Math.abs(this.offsetTarget) < 0.5) {
        const options = stalled ? [...new Set([...lanes, -3.4, 3.4])] : lanes;
        options.sort((a, b) => Math.abs(a) - Math.abs(b));
        const free = options.find((o) => this.lineClear(s, o, -6, stalled ? 25 : 40));
        if (free !== undefined) {
          this.offsetTarget = free;
          this.swerveHold = stalled ? 2.5 : 4;
          this.blockedTime = 0;
          reason = stalled ? 'Going round a stalled car' : 'Changing lanes';
          // too close to steer round it: back off a little first
          if (stalled && lead.gap < 9) this.reverseTime = clamp((10 - lead.gap) / 2.2, 0.8, 3);
        }
      } else if (this.offsetTarget !== 0 && this.swerveHold <= 0 && (turnSoon || !lanes.some((o) => Math.abs(o - this.offsetTarget) < 0.5) || this.lineClear(s, 0, -6, 30))) {
        if (this.lineClear(s, 0, -6, 20)) {
          this.offsetTarget = 0;
          this.swerveHold = 3;
        }
      }
      // the slower traffic stops holding it up only once it's actually in the other lane
      if (Math.abs(this.offsetTarget) > 0.1 && Math.abs(this.offsetTarget - this.offset) < 1.2 && Math.abs(this.offsetTarget - across) < 1.0) {
        const lead2 = this.leadOnPath(s, this.offsetTarget, 70, d.margin);
        if (!lead2 || lead2.gap > (lead?.gap ?? 0)) {
          const eff2 = lead2 ? lead2.gap - d.gap0 - lead2.speed * d.gapTime : Infinity;
          vTarget = Math.max(vTarget, Math.min(pointAt(path, s + speed * 0.35, 0, this._pt).v, eff2 === Infinity ? Infinity : Math.sqrt((lead2.speed ** 2) + 2 * d.brake * Math.max(0, eff2))));
        }
      }
      // a gentle lane change: 1.2 m/s across
      this.offset += clamp(this.offsetTarget - this.offset, -1.2 * dt, 1.2 * dt);
    }

    // 3. Steering: pure pursuit on the (offset) path, looking further ahead the faster it goes
    const [L0, Lk] = d.lookahead;
    const look = clamp(L0 + speed * Lk, 4, 26);
    const target = pointAt(path, Math.min(path.length, s + look), this.offset, this._pt);
    let steer = pursuitSteer(x, z, car.heading, v, target.x, target.z);
    // far off line (just started, after a shove): aim back for it before speeding on
    const heading = Math.atan2(target.x - x, target.z - z);
    const misalign = Math.abs(wrapAngle(heading - car.heading));
    if (misalign > 1.2) vTarget = Math.min(vTarget, 4);
    else if (misalign > 0.6) vTarget = Math.min(vTarget, 8);

    // 4. Stuck?
    const wantsToGo = vTarget > 2;
    this.stuckTime = wantsToGo && speed < 0.6 ? this.stuckTime + dt : 0;
    if (this.stuckTime > (d.id === 'crazy' ? 1.0 : 2.2)) {
      this.stuckTime = 0;
      this.reverseTime = d.id === 'crazy' ? 0.9 : 1.4;
      if (d.id === 'crazy') this.honk(car);
    }

    const pedal = speedControl(v, vTarget, hard || d.id === 'crazy');
    this.setInput(pedal.forward, pedal.backward, steer);
    this.status = reason;
  }

  setInput(forward, backward, steer) {
    const i = this.input;
    i.forward = forward;
    i.backward = backward;
    i.left = steer > 0 ? steer : 0;
    i.right = steer < 0 ? -steer : 0;
    this.controllers.setAutopilotInput(i);
  }

  honk(car) {
    if (this.honkTimer > 0 || !this.audio) return;
    this.honkTimer = 1.4;
    this.audio.honk(car);
  }

  // The nearest vehicle (or pedestrian, for drivers who stop for them) on the path ahead of s at lateral offset `off`:
  // { gap (bumper to bumper), speed (along the path), ped }
  leadOnPath(s, off, range, margin) {
    const path = this.path;
    const pts = path.pts;
    const i0 = this.index;
    let best = null;
    const ent = this.controllers.getActiveEntity();
    const cx = ent.position.x;
    const cz = ent.position.z;
    const consider = (o, half, halfWidth, speed, tx, tz, ped) => {
      if (Math.abs(o.x - cx) > range + 10 || Math.abs(o.z - cz) > range + 10) return;
      for (let i = i0; i < pts.length; i++) {
        const p = pts[i];
        const ahead = p.s - s;
        if (ahead > range) break;
        if (ahead < -3) continue;
        const px = p.x + p.nx * off;
        const pz = p.z + p.nz * off;
        const dx = o.x - px;
        const dz = o.z - pz;
        const along = dx * p.tx + dz * p.tz;
        if (Math.abs(along) > SAMPLE) continue;
        const across = Math.abs(dx * p.nx + dz * p.nz);
        if (across > halfWidth + CAR_HALF_W + margin) continue;
        const gap = ahead + along - half - CAR_HALF_L;
        if (gap < -CAR_HALF_L * 1.5) return; // beside or behind us
        if (!best || gap < best.gap) best = { gap, speed: Math.max(0, speed * (tx * p.tx + tz * p.tz)), ped };
        return;
      }
    };
    for (const list of [this.traffic.cars, this.traffic.buses]) {
      if (!list) continue;
      for (const v of list) {
        if (!v.edge) continue;
        consider(v, v.half || 2.3, v.halfWidth || 0.9, v.speed || 0, v.tx ?? 0, v.tz ?? 1, false);
      }
    }
    if (this.driver.peds && this.traffic.peds) {
      for (const p of this.traffic.peds) {
        if (!p.placed) continue;
        consider(p, 0.4, 0.4, 0, 0, 1, true);
      }
    }
    return best;
  }

  // Is the line at offset `off` free of vehicles and kerbs from from..to metres ahead?
  lineClear(s, off, from, to) {
    const pts = this.path.pts;
    const clearRoad = this.network.isRoadClear;
    for (let i = this.index; i < pts.length; i++) {
      const p = pts[i];
      const ahead = p.s - s;
      if (ahead > to) break;
      if (ahead < from) continue;
      if (clearRoad && !clearRoad(p.x + p.nx * off, p.z + p.nz * off, 1.0)) return false;
    }
    if (!this.besideClear(off)) return false;
    const lead = this.leadOnPath(s, off, to, 0.35);
    // (a vehicle in it is fine if it's far enough, or moving and no slower than us)
    return !lead || lead.gap > to - 4 || lead.speed > Math.max(2.5, Math.abs(this.controllers.getActiveEntity().speed) - 1);
  }

  // Nothing alongside (or just behind) the car on the line `off` metres right of the path
  besideClear(off) {
    const ent = this.controllers.getActiveEntity();
    const p = this.path.pts[this.index];
    if (!p) return true;
    const cx = ent.position.x + p.nx * (off - this.offset);
    const cz = ent.position.z + p.nz * (off - this.offset);
    for (const list of [this.traffic.cars, this.traffic.buses]) {
      if (!list) continue;
      for (const v of list) {
        if (!v.edge) continue;
        const dx = v.x - cx;
        const dz = v.z - cz;
        const along = dx * p.tx + dz * p.tz;
        const across = Math.abs(dx * p.nx + dz * p.nz);
        if (along > -12 && along < 6 && across < (v.halfWidth || 0.9) + CAR_HALF_W + 0.4) return false;
      }
    }
    return true;
  }

  // The nearest free line to swerve into: a lane's width either side, then two
  findGap(s, speed) {
    const reach = clamp(14 + speed * 1.2, 18, 45);
    const options = [-3.4, 3.4, -6.8, 6.8, -10.2, 10.2].map((o) => o + Math.round(this.offset / 3.4) * 3.4);
    options.sort((a, b) => Math.abs(a - this.offset) - Math.abs(b - this.offset));
    for (const o of options) {
      if (Math.abs(o) > 11) continue;
      if (Math.abs(o - this.offset) < 0.5) continue;
      if (this.lineClear(s, o, 2, reach)) return o;
    }
    return null;
  }
}

export { Navigator, DRIVERS, planRoute, buildPath, findStartEdge, findGoalEdges, locate, pointAt, pursuitSteer, speedControl, speedProfile };

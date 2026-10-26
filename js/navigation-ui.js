import { PLACE_LIST, CITY } from './city-config.js';

// js/navigation-ui.js
// The HUD for js/navigation.js: the Navigate menu (who drives, where to), the turn-by-turn card, the Crazy Taxi meter
// and its call-outs, and the route on the radar and the full map. All DOM text through textContent.

const ARROWS = { left: 'i-turn-left', right: 'i-turn-right', keepleft: 'i-keep-left', keepright: 'i-keep-right', uturn: 'i-uturn', arrive: 'i-arrive' };
const WORDS = { left: 'Turn left', right: 'Turn right', keepleft: 'Keep left', keepright: 'Keep right', uturn: 'Make a U-turn', arrive: 'Arrive' };

function setupNavigationUI({ navigator, mapSystem, controllerManager, selectMode, closePopovers }) {
  const $ = (id) => document.getElementById(id);
  const panel = $('nav-panel');
  const popover = $('navigate-popover');
  if (!panel || !popover) return { update() {}, toggleMenu() {} };
  const metric = CITY.units === 'metric';
  const el = {
    arrow: $('nav-arrow')?.querySelector('use'), distance: $('nav-distance'), instruction: $('nav-instruction'),
    driver: $('nav-driver'), eta: $('nav-eta'), status: $('nav-status'), fare: $('nav-fare'), fareTime: $('fare-time'),
    fareTotal: $('fare-total'), fareMisses: $('fare-misses'), fareEarned: $('fare-earned'), toast: $('nav-toast'),
    stop: $('nav-stop')
  };
  let earned = 0; // Crazy Taxi: the shift's takings
  let toastTimer = 0;

  const formatDistance = (m) => {
    if (metric) return m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.max(0, Math.round(m / 10) * 10)} m`;
    const ft = m * 3.281;
    return ft >= 1000 ? `${(m / 1609).toFixed(1)} mi` : `${Math.round(ft / 50) * 50} ft`;
  };
  const formatTime = (s) => {
    const t = Math.max(0, Math.round(s));
    return t >= 60 ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` : `${t}s`;
  };
  const money = (v) => `$${v.toFixed(2)}`;

  function toast(text, ms = 1400) {
    if (!el.toast) return;
    el.toast.textContent = text;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
  }

  // Places: the city's landmarks, nearest last so the list reads as a choice of trips
  const places = $('nav-places');
  for (const lm of PLACE_LIST) {
    const btn = document.createElement('button');
    btn.className = 'pop-item';
    btn.type = 'button';
    const name = document.createElement('span');
    name.className = 'pop-name';
    name.textContent = lm.name;
    const sub = document.createElement('span');
    sub.className = 'pop-sub';
    sub.textContent = lm.district || '';
    btn.append(name, sub);
    btn.addEventListener('click', () => go(lm.x, lm.z, lm.name));
    places?.appendChild(btn);
  }

  function go(x, z, name) {
    closePopovers();
    // the autopilots drive the car: hop in
    if (navigator.driver.auto && controllerManager.activeMode !== 'car') selectMode('car');
    if (!navigator.setDestination(x, z, name)) return;
    mapSystem.waypoint = { x, z, name };
    if (navigator.driver.id === 'crazy') toast(`Take me to ${name}!`, 1800);
  }

  // A fare across town: a landmark 400 m - 2.5 km away (or any, if none is)
  function randomTrip() {
    const p = controllerManager.getActiveEntity().position;
    const far = PLACE_LIST.filter((l) => { const d = Math.hypot(l.x - p.x, l.z - p.z); return d > 400 && d < 2500; });
    const list = far.length ? far : PLACE_LIST;
    const lm = list[Math.floor(Math.random() * list.length)];
    if (lm) go(lm.x, lm.z, lm.name);
  }

  for (const btn of popover.querySelectorAll('[data-driver]')) {
    btn.addEventListener('click', () => {
      const id = btn.dataset.driver;
      if (id !== 'you' && controllerManager.activeMode !== 'car') selectMode('car');
      navigator.setDriver(id);
      syncDrivers();
      // Crazy Taxi with nowhere to go yet: a fare
      if (id === 'crazy' && !navigator.active) randomTrip();
    });
  }
  $('nav-random')?.addEventListener('click', randomTrip);
  $('nav-pick')?.addEventListener('click', () => {
    closePopovers();
    document.body.classList.add('nav-picking');
    mapSystem.pickHandler = (x, z, name) => {
      document.body.classList.remove('nav-picking');
      mapSystem.toggleFullMap(false);
      go(x, z, name);
    };
    mapSystem.toggleFullMap(true);
    const hint = $('fullmap-hover-info');
    if (hint) hint.textContent = 'Click where you want to go';
  });
  const stop = () => {
    navigator.clear();
    mapSystem.routeLine = null;
    sync(navigator.state());
  };
  el.stop?.addEventListener('click', () => { stop(); closePopovers(); });
  $('nav-close')?.addEventListener('click', stop);

  function syncDrivers() {
    for (const btn of popover.querySelectorAll('[data-driver]')) {
      const on = btn.dataset.driver === navigator.driver.id;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-checked', String(on));
    }
    document.body.dataset.driver = navigator.driver.id;
  }

  // The card, the meter and the maps, from navigator.state()
  function sync(st) {
    panel.hidden = !st.active;
    if (el.stop) el.stop.hidden = !st.active;
    mapSystem.routeLine = st.active && !st.arrived ? st.route : null;
    syncDrivers();
    if (!st.active) return;
    const next = st.arrived ? { kind: 'arrive', distance: 0, name: st.destination?.name } : st.next || { kind: 'arrive', distance: st.remaining, name: '' };
    el.arrow?.setAttribute('href', `#${ARROWS[next.kind] || 'i-arrive'}`);
    if (el.distance) el.distance.textContent = st.arrived ? '' : formatDistance(next.distance);
    if (el.instruction) {
      el.instruction.textContent = st.arrived
        ? `Arrived · ${st.destination?.name || ''}`
        : next.kind === 'arrive' ? `${st.destination?.name || 'Destination'}` : `${WORDS[next.kind]}${next.name ? ` onto ${next.name}` : ''}`;
    }
    if (el.driver) el.driver.textContent = st.driverLabel;
    if (el.eta) el.eta.textContent = st.arrived ? '' : `${formatDistance(st.remaining)} · ${formatTime(st.eta)}`;
    if (el.status) el.status.textContent = st.driver !== 'you' && !st.carMode ? 'Switch to the car' : st.status || '';
    const fare = st.fare;
    if (el.fare) el.fare.hidden = !fare;
    if (fare) {
      el.fareTime.textContent = formatTime(fare.timeLeft);
      el.fare.classList.toggle('is-late', fare.timeLeft < 10);
      el.fareTotal.textContent = money(fare.total);
      el.fareMisses.textContent = String(fare.nearMisses);
      el.fareEarned.textContent = money(earned);
    }
  }

  navigator.onChange = sync;
  navigator.onEvent = (kind, d) => {
    if (kind === 'arrived') {
      if (d.fare) {
        earned += d.fare.total;
        toast(d.fare.tip > 0 ? `Drop-off! ${money(d.fare.total)} (tip ${money(d.fare.tip)})` : `Drop-off! ${money(d.fare.total)}`, 2600);
      } else {
        toast(`You have arrived`, 2000);
      }
    } else if (kind === 'nearmiss') toast(d.combo > 1 ? `Near miss x${d.combo}! +${money(d.award)}` : `Near miss! +${money(d.award)}`, 900);
    else if (kind === 'crash') toast('Ouch!', 700);
    else if (kind === 'reroute') toast('Rerouting…', 900);
    else if (kind === 'takeover') toast('You have the wheel', 1200);
    else if (kind === 'noroute') toast('No road goes there', 1500);
    else if (kind === 'nextfare') randomTrip();
  };
  syncDrivers();

  let acc = 0;
  return {
    // the card's numbers 5 times a second
    update(dt) {
      acc += dt;
      if (acc < 0.2 || !navigator.active) return;
      acc = 0;
      sync(navigator.state());
    },
    toggleMenu() {
      if (typeof popover.togglePopover === 'function') popover.togglePopover();
    }
  };
}

export { setupNavigationUI };

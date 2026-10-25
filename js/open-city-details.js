import * as THREE from 'three/webgpu';
import { createTreeField, TREE_SPECIES } from './trees.js';
import { blockAt } from './city-config.js';
import { GEO } from './geodata.js';

// js/open-city-details.js
// The street details of a city built from OpenStreetMap, built by main.js instead of street-details.js's New York
// furniture: the city's own trees (GEO.trees, an inventory such as NParks' for Singapore: tools/city/build.mjs), each
// where it stands on a sidewalk, median, verge or park lawn, grown to its height, its crown shape from its family
// (shapes without a model in js/trees.js, such as palms, aren't planted). Returns what main.js and the audio take from
// street-details.js: { group, footprints, signalClock, audioSignals, update }.

const SIDEWALK_Y = 0.22;
const LAWN_Y = 0.235;
// The tree models (mature trees, 10-13 m tall at scale 1) scale as a whole, leaf cards and all: below ~60% their crowns
// thin out to bare twigs, so the inventory's young & small trees grow to this height
const MIN_HEIGHT = 7.5;

function buildOpenCityDetails(scene) {
  const group = new THREE.Group();
  group.name = 'CityStreetDetails';
  const sites = [];
  const trees = GEO.trees;
  if (trees) {
    const speciesOf = trees.shapes.map((name) => TREE_SPECIES.findIndex((sp) => sp.name === name));
    const d = trees.data; // [x dm, z dm, height m, shape, ...]
    for (let i = 0; i < d.length; i += 4) {
      const species = speciesOf[d[i + 3]];
      if (species < 0) continue;
      const x = d[i] / 10;
      const z = d[i + 1] / 10;
      const height = Math.max(MIN_HEIGHT, d[i + 2]);
      const b = blockAt(x, z);
      const park = !!b && b.park > 0.6;
      // draw distance: park trees and the tall ones furthest
      sites.push({ x, y: b ? (park ? LAWN_Y : SIDEWALK_Y) : 0, z, height, species, tier: park ? 0 : height >= 12 ? 1 : 2 });
    }
  }
  if (sites.length) group.add(createTreeField(scene, sites).group);
  scene.add(group);
  console.info(`[cityDetails] ${sites.length} trees${trees ? ` (${trees.credit})` : ''}`);
  return { group, footprints: [], signalClock: { value: 0 }, audioSignals: [], update: null };
}

export { buildOpenCityDetails };

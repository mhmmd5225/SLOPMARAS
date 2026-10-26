import { GEO as DEFAULT_GEO } from './kahramanmaras-geodata.js';

// js/geodata.js
// The simulated city's geography: Kahramanmaraş (js/kahramanmaras-geodata.js, built by tools/city/build.mjs) unless the
// page names another city as ?city=<id>: Singapore (singapore), New York (nyc: js/nyc-geodata.js,
// tools/build-geodata.mjs) or any other city built by tools/city/build.mjs (js/<id>-geodata.js). Outside a browser
// (tests), the CITY environment variable.

const DEFAULT_CITY = 'kahramanmaras';
const requested = globalThis.location
  ? new URLSearchParams(globalThis.location.search).get('city')
  : globalThis.process?.env?.CITY;
let CITY_ID = DEFAULT_CITY;
let GEO = DEFAULT_GEO;
if (requested && requested !== DEFAULT_CITY) {
  try {
    if (!/^[a-z0-9-]+$/.test(requested)) throw new Error('not a city id');
    GEO = (await import(`./${requested}-geodata.js`)).GEO;
    CITY_ID = requested;
  } catch (e) {
    console.error(`[geodata] no city "${requested}" (js/${requested}-geodata.js): ${e.message}; ${DEFAULT_GEO.name} instead`);
  }
}

export { GEO, CITY_ID };

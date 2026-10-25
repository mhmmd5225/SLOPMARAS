import { GEO as NYC_GEO } from './nyc-geodata.js';

// js/geodata.js
// The simulated city's geography: New York (js/nyc-geodata.js) unless the page names another city built by
// tools/city/build.mjs, as ?city=<id> (js/<id>-geodata.js). Outside a browser (tests), the CITY environment variable.

const requested = globalThis.location
  ? new URLSearchParams(globalThis.location.search).get('city')
  : globalThis.process?.env?.CITY;
let CITY_ID = 'nyc';
let GEO = NYC_GEO;
if (requested && requested !== 'nyc') {
  try {
    if (!/^[a-z0-9-]+$/.test(requested)) throw new Error('not a city id');
    GEO = (await import(`./${requested}-geodata.js`)).GEO;
    CITY_ID = requested;
  } catch (e) {
    console.error(`[geodata] no city "${requested}" (js/${requested}-geodata.js): ${e.message}; New York instead`);
  }
}

export { GEO, CITY_ID };

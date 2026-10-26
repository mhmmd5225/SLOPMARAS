# Slop Singapore

A Singapore city simulation built with [three.js](https://threejs.org/), WebGPURenderer, and TSL. Explore Singapore's Central Area — the CBD and Marina Bay, Chinatown, the Civic District, Bugis, Little India, Orchard — on foot, by car, by bicycle, or by helicopter, with its traffic keeping left.

[Try it live](https://zz85.github.io/slop-singapore/)

Singapore's own touches: Marina Bay Sands (three towers on their leaning legs under the SkyPark, its pool and gardens, Spectra's beams at night) and the Singapore Flyer (turning once in 32 minutes, its rim lit at night) modelled low-poly where OpenStreetMap maps them; koels calling, cicadas at dusk and crickets at night; afternoon thunderstorms with rain, lightning and thunder that arrives at the speed of sound (the storm button or `R`, or open the page with `?storm`); and the rest of the island beyond the Central Area — the HDB estates, Jurong, Changi, Sentosa — streamed in tiles of buildings and main roads around you as you fly.

Slop Singapore grew out of mrdoob's [Slop New York](https://github.com/mrdoob/slop-newyork), and New York still runs here: open the page with `?city=nyc`.

## Run it

Serve the folder and open it in a browser with WebGPU (or WebGL 2):

```sh
python3 -m http.server 8000 --bind 127.0.0.1    # then open http://127.0.0.1:8000/
```

## Make it your own

Fork it, remix it, improve it, break it. Make games, animations, films, experiments, or something completely different. Use it as a starting point and take it wherever you want. Have fun!

## Cities

Singapore is built from OpenStreetMap; `?city=<id>` loads another city. To add one, describe it in `tools/city/cities/<city>.mjs` (its area, origin, driving side, neighbourhoods and places), then:

```sh
node tools/city/fetch.mjs <city>                                  # OpenStreetMap layers from Overpass
node --max-old-space-size=8192 tools/city/build.mjs <city>        # writes js/<city>-geodata.js
node tools/city/preview.mjs <city> preview.png                    # a map of the result, to check it
```

The rest of the island, as streamed tiles (`island` in the city's config): buildings and main roads only, no traffic or colliders yet:

```sh
node tools/city/fetch-island.mjs <city>                            # buildings & main roads cell by cell, coastline, water
node --max-old-space-size=8192 tools/city/tiles.mjs <city>        # writes tiles/<city>/index.json and a file per tile
```

New York (`?city=nyc`) has its own data build from NYC Open Data: `node --max-old-space-size=8192 tools/build-geodata.mjs`.

## License and data

The project code is available under the [MIT License](LICENSE).

Geographic data: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL); New York's also NYC Open Data. Singapore's trees: [Trees.sg](https://www.nparks.gov.sg/treessg) © National Parks Board, collected by [cheeaun/sgtreesdata](https://github.com/cheeaun/sgtreesdata). Third-party data and dependencies retain their respective licenses.

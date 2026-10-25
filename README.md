# Slop New York

A New York City simulation built with [three.js](https://threejs.org/), WebGPURenderer, and TSL. Explore Manhattan on foot, by car, by bicycle, or by helicopter.

[Try it live](https://mrdoob.github.io/slop-newyork/)

## Make it your own

Fork it, remix it, improve it, break it. Make games, animations, films, experiments, or something completely different. Use it as a starting point and take it wherever you want. Have fun!

## Other cities

Cities built from OpenStreetMap run in the same simulation: open [`?city=singapore`](https://mrdoob.github.io/slop-newyork/?city=singapore) for Singapore's Central Area. To add one, describe it in `tools/city/cities/<city>.mjs` (its area, origin, driving side, neighbourhoods and places), then:

```sh
node tools/city/fetch.mjs <city>                                  # OpenStreetMap layers from Overpass
node --max-old-space-size=8192 tools/city/build.mjs <city>        # writes js/<city>-geodata.js
node tools/city/preview.mjs <city> preview.png                    # a map of the result, to check it
```

## License and data

The project code is available under the [MIT License](LICENSE).

Geographic data: NYC Open Data and © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL); the other cities are OpenStreetMap's alone. Third-party data and dependencies retain their respective licenses.

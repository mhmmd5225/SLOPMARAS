// Singapore: the Central Area — the CBD & Marina Bay, Chinatown & Tanjong Pagar, the Civic District, Bugis & Kampong
// Glam, Little India, Orchard, River Valley, Tiong Bahru — from OpenStreetMap
export default {
  id: 'singapore',
  name: 'Singapore',
  short: 'SG',
  origin: { lat: 1.28405, lon: 103.85143, label: 'Raffles Place' },
  bearing: 'auto', // no city-wide grid: the frame turns to the streets' dominant direction
  detail: [1.262, 103.822, 1.318, 103.878], // south, west, north, east
  margin: 0.005, // degrees fetched beyond the detail box so its edge blocks are whole
  sidewalk: 5, // property line in from the curb (m)
  strip: 6, // waterfront strip kept clear of blocks (m in from the shore)
  driveSide: 'left',
  // Building styles by neighbourhood: a block takes the style of the nearest centre within its radius (m). Styles:
  // glass-towers, offices, shophouses, housing, midrise, lowrise (js/buildings.js); elsewhere a mix
  districts: [
    { name: 'Raffles Place', at: [1.2840, 103.8514], r: 450, style: 'glass-towers' },
    { name: 'Marina Bay Financial Centre', at: [1.2793, 103.8540], r: 450, style: 'glass-towers' },
    { name: 'Shenton Way', at: [1.2770, 103.8480], r: 450, style: 'offices' },
    { name: 'Chinatown', at: [1.2836, 103.8443], r: 380, style: 'shophouses' },
    { name: 'Tanjong Pagar', at: [1.2780, 103.8430], r: 300, style: 'shophouses' },
    { name: 'Boat Quay', at: [1.2868, 103.8494], r: 130, style: 'shophouses' },
    { name: 'Clarke Quay', at: [1.2895, 103.8460], r: 200, style: 'lowrise' },
    { name: 'Civic District', at: [1.2925, 103.8515], r: 400, style: 'midrise' },
    { name: 'Bugis', at: [1.3000, 103.8556], r: 380, style: 'offices' },
    { name: 'Kampong Glam', at: [1.3023, 103.8590], r: 280, style: 'shophouses' },
    { name: 'Little India', at: [1.3066, 103.8518], r: 500, style: 'shophouses' },
    { name: 'Orchard', at: [1.3040, 103.8318], r: 650, style: 'offices' },
    { name: 'River Valley', at: [1.2935, 103.8370], r: 650, style: 'housing' },
    { name: 'Robertson Quay', at: [1.2905, 103.8400], r: 300, style: 'housing' },
    { name: 'Tiong Bahru', at: [1.2850, 103.8300], r: 450, style: 'midrise' },
    { name: 'Outram', at: [1.2790, 103.8380], r: 350, style: 'housing' },
    { name: 'Lavender', at: [1.3080, 103.8630], r: 500, style: 'housing' }
  ],
  // Teleport destinations & landmarks (arrivals snap to the nearest street)
  places: [
    { id: 'raffles', name: 'Raffles Place', sub: 'Downtown Core', at: [1.2840, 103.8514] },
    { id: 'mbs', name: 'Marina Bay Sands', sub: 'Bayfront', at: [1.2834, 103.8607] },
    { id: 'gardens', name: 'Gardens by the Bay', sub: 'Marina South', at: [1.2816, 103.8636] },
    { id: 'merlion', name: 'Merlion Park', sub: 'Marina Bay', at: [1.2868, 103.8545] },
    { id: 'esplanade', name: 'Esplanade', sub: 'Marina Bay', at: [1.2897, 103.8555] },
    { id: 'clarkequay', name: 'Clarke Quay', sub: 'Singapore River', at: [1.2884, 103.8465] },
    { id: 'chinatown', name: 'Chinatown', sub: 'Outram', at: [1.2836, 103.8443] },
    { id: 'orchard', name: 'Orchard Road', sub: 'Orchard', at: [1.3040, 103.8318] },
    { id: 'littleindia', name: 'Little India', sub: 'Rochor', at: [1.3066, 103.8518] },
    { id: 'kampongglam', name: 'Kampong Glam', sub: 'Rochor', at: [1.3023, 103.8590] }
  ],
  // Map labels: 0 regions, 1 waters, 2 neighbourhoods (the districts above are labelled too)
  labels: [
    { name: 'MARINA BAY', at: [1.2860, 103.8575], kind: 1 },
    { name: 'SINGAPORE RIVER', at: [1.2878, 103.8475], kind: 1 },
    { name: 'KALLANG BASIN', at: [1.3030, 103.8710], kind: 1 },
    { name: 'SINGAPORE STRAIT', at: [1.2640, 103.8640], kind: 1 },
    { name: 'MARINA SOUTH', at: [1.2740, 103.8620], kind: 2 },
    { name: 'MARINA EAST', at: [1.2880, 103.8720], kind: 2 }
  ]
};

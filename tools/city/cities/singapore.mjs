// Singapore: the Central Area — the CBD & Marina Bay, Chinatown & Tanjong Pagar, the Civic District, Bugis & Kampong
// Glam, Little India, Orchard, River Valley, Tiong Bahru — from OpenStreetMap
export default {
  id: 'singapore',
  name: 'Singapore',
  origin: { lat: 1.28405, lon: 103.85143, label: 'Raffles Place' },
  bearing: 'auto', // no city-wide grid: the frame turns to the streets' dominant direction
  detail: [1.262, 103.822, 1.318, 103.878], // south, west, north, east
  margin: 0.005, // degrees fetched beyond the detail box so its edge blocks are whole
  sidewalk: 5, // property line in from the curb (m)
  strip: 6, // waterfront strip kept clear of blocks (m in from the shore)
  driveSide: 'left'
};

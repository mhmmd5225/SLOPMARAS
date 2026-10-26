// Kahramanmaraş: the city centre — Atatürk Meydanı, the Kale & Ulu Camii, the old bazaars, Trabzon Caddesi down to
// Kıbrıs Meydanı and the Belediye, Yenişehir and the station, Bahçelievler, Dulkadiroğlu — from OpenStreetMap
export default {
  id: 'kahramanmaras',
  name: 'Kahramanmaraş',
  short: '46',
  origin: { lat: 37.58515, lon: 36.92683, label: 'Atatürk Meydanı' },
  bearing: 'auto', // no city-wide grid: the frame turns to the streets' dominant direction
  detail: [37.560, 36.900, 37.598, 36.960], // south, west, north, east
  margin: 0.004, // degrees fetched beyond the detail box so its edge blocks are whole
  sidewalk: 4, // property line in from the curb (m)
  strip: 6, // waterfront strip kept clear of blocks (m in from the shore)
  driveSide: 'right',
  // Building styles by neighbourhood: a block takes the style of the nearest centre within its radius (m). Styles:
  // glass-towers, offices, shophouses, housing, midrise, lowrise (js/buildings.js); elsewhere a mix. The old town
  // under the Kale is the bazaars' low shops; the rest of the centre is five- to eight-storey apartment blocks
  districts: [
    { name: 'Kale & Ulu Camii', at: [37.5860, 36.9265], r: 320, style: 'shophouses' },
    { name: 'Kapalı Çarşı', at: [37.5838, 36.9290], r: 260, style: 'shophouses' },
    { name: 'Kıbrıs Meydanı', at: [37.5826, 36.9266], r: 300, style: 'offices' },
    { name: 'Trabzon Caddesi', at: [37.5790, 36.9280], r: 350, style: 'offices' },
    { name: 'Belediye', at: [37.5767, 36.9269], r: 280, style: 'offices' },
    { name: 'Yenişehir', at: [37.5742, 36.9305], r: 450, style: 'midrise' },
    { name: 'Menderes', at: [37.5739, 36.9346], r: 400, style: 'midrise' },
    { name: 'Bahçelievler', at: [37.5685, 36.9374], r: 450, style: 'midrise' },
    { name: 'Şazibey', at: [37.5714, 36.9217], r: 400, style: 'midrise' },
    { name: 'Egemenlik', at: [37.5706, 36.9296], r: 350, style: 'midrise' },
    { name: 'Dulkadiroğlu', at: [37.5787, 36.9485], r: 500, style: 'midrise' },
    { name: 'Şeyh Adil', at: [37.5791, 36.9389], r: 350, style: 'midrise' },
    { name: 'Hayrullah', at: [37.5800, 36.9258], r: 250, style: 'lowrise' },
    { name: 'Ekmekçi', at: [37.5859, 36.9282], r: 250, style: 'lowrise' },
    { name: 'Divanlı', at: [37.5865, 36.9350], r: 350, style: 'lowrise' },
    { name: 'Şehitevliya', at: [37.5850, 36.9168], r: 350, style: 'lowrise' },
    { name: 'Mağralı', at: [37.5908, 36.9197], r: 350, style: 'lowrise' },
    { name: 'Yusuflar', at: [37.5837, 36.9230], r: 250, style: 'lowrise' },
    { name: 'Mevlana', at: [37.5791, 36.9109], r: 450, style: 'housing' },
    { name: 'Ertuğrul Gazi', at: [37.5790, 36.9148], r: 400, style: 'midrise' },
    { name: 'Hacı Bayram Veli', at: [37.5745, 36.9158], r: 400, style: 'housing' },
    { name: 'Karacaoğlan', at: [37.5761, 36.9053], r: 450, style: 'housing' },
    { name: 'Yavuz Selim', at: [37.5690, 36.9494], r: 450, style: 'midrise' },
    { name: 'Bağlarbaşı', at: [37.5765, 36.9482], r: 350, style: 'midrise' },
    { name: 'Namık Kemal', at: [37.5731, 36.9514], r: 400, style: 'midrise' }
  ],
  // Teleport destinations & landmarks (arrivals snap to the nearest street)
  places: [
    { id: 'ataturk', name: 'Atatürk Meydanı', sub: 'Merkez', at: [37.58515, 36.92683] },
    { id: 'kale', name: 'Kahramanmaraş Kalesi', sub: 'Kale', at: [37.58698, 36.92542] },
    { id: 'ulucami', name: 'Ulu Camii', sub: 'Merkez', at: [37.58452, 36.92705] },
    { id: 'tasmedrese', name: 'Taş Medrese', sub: 'Merkez', at: [37.58510, 36.92648] },
    { id: 'kibris', name: 'Kıbrıs Meydanı', sub: 'Trabzon Caddesi', at: [37.58261, 36.92657] },
    { id: 'dondurma', name: 'Dondurma Müzesi', sub: 'Merkez', at: [37.58413, 36.92702] },
    { id: 'sutcuimam', name: 'Sütçü İmam Anıtı', sub: 'Kurtuluş', at: [37.58798, 36.92770] },
    { id: 'kurtulus', name: 'Kurtuluş Müzesi', sub: 'Kurtuluş', at: [37.58886, 36.92694] },
    { id: 'belediye', name: 'Büyükşehir Belediyesi', sub: 'Yenişehir', at: [37.57666, 36.92687] },
    { id: 'milliirade', name: 'Millî İrade Meydanı', sub: 'Yenişehir', at: [37.57539, 36.92682] },
    { id: 'piazza', name: 'Piazza AVM', sub: 'Şazibey', at: [37.57041, 36.92270] },
    { id: 'gar', name: 'Kahramanmaraş Garı', sub: 'Tarihi Lokomotif', at: [37.56400, 36.93072] },
    { id: 'milletbahcesi', name: 'Millet Bahçesi', sub: 'Hacı Bayram Veli', at: [37.57390, 36.91394] },
    { id: 'dulkadiroglu', name: 'Dulkadiroğlu Parkı', sub: 'Dulkadiroğlu', at: [37.57906, 36.95229] }
  ],
  // Trees: OpenStreetMap's mapped trees & tree rows, and trees scattered over the parks & gardens (tools/city/fetch.mjs);
  // the streets of Maraş are lined with plane trees (çınar)
  trees: {
    source: 'osm',
    credit: '© OpenStreetMap contributors',
    shape: 'plane',
    parkSpacing: 14 // m between the trees scattered over a park (on average)
  },
  // The ground (tools/city/terrain.mjs): Maraş climbs the foot of Ahır Dağı, from ~500 m at the station to ~700 m on the
  // northern streets, the Kale on its mound. Heights from AWS's Terrarium tiles: the city's at zoom 14 on a 30 m grid
  // (the radar's own resolution; blurred 25 m to smooth its buildings out of the ground), the region's at zoom 12 on a 100 m grid out to
  // the mountains on the horizon (region: [south, west, north, east])
  terrain: { zoom: 14, cell: 30, smooth: 25, region: [37.46, 36.77, 37.71, 37.08], regionZoom: 12, regionCell: 100, regionSmooth: 60 },
  // Vehicle liveries (js/city-common.js DEFAULT_VEHICLES, overridden part by part): Turkey's yellow taxis with the black
  // TAKSİ lettering and Kahramanmaraş (46) plates, white with the blue TR band; the municipality's white and red buses
  vehicles: {
    taxis: [0xffc40c],
    taxiBadge: 0x121417,
    taxiLettering: 0x121417,
    taxiMedallion: false,
    plate: { front: 0xf4f4f0, bg: '#f4f4f0', ink: '#111111', labels: ['46 KM 728', '46 ABC 319', '46 AT 506', '46 DS 842'] },
    playerTaxi: {
      door: { bg: '#ffc40c', ink: '#111317', emblem: 'T', title: 'TAKSİ', lines: ['KAHRAMANMARAŞ', '46 T 1973'] },
      plate: { bg: '#f4f4f0', band: '#1b3f9a', ink: '#111111', top: 'TR', number: '46 T 1973', bottom: '' }
    },
    bus: { body: 0xf3f4f6, stripe: 0xc8102e, ribbon: 0xe8a33d, skirt: 0x1c2026, route: '6', routeBadge: '#c8102e', destination: 'OTOGAR - KALE' },
    labels: { car: 'Taksi', cyclist: 'Bisikletli' }
  },
  // Map labels: 0 regions, 1 waters, 2 neighbourhoods (the districts above are labelled too)
  labels: [
    { name: 'ONİKİŞUBAT', at: [37.5820, 36.9130], kind: 0 },
    { name: 'DULKADİROĞLU', at: [37.5770, 36.9450], kind: 0 },
    { name: 'AHIR DAĞI ↑', at: [37.5965, 36.9300], kind: 0 },
    { name: 'KURTULUŞ', at: [37.5824, 36.9287], kind: 2 },
    { name: 'TURAN', at: [37.5850, 36.9311], kind: 2 },
    { name: 'GAYBERLİ', at: [37.5696, 36.9128], kind: 2 },
    { name: 'BARBAROS', at: [37.5703, 36.9045], kind: 2 }
  ]
};

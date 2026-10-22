// Leaflet basemap (standard OpenStreetMap tiles) behind a small
// interface the drawing code uses:
//   toPixel(lat, lon) -> {x, y}, bounds() -> {s, w, n, e}, zoom(),
//   onClick(cb(lat, lon)), onView(cb)
export function createMap(el, view) {
  const L = window.L;
  const map = L.map(el, { zoomControl: false, zoomAnimation: false }).setView([view.lat, view.lon], view.zoom);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);

  return {
    toPixel: (lat, lon) => map.latLngToContainerPoint([lat, lon]),
    bounds() {
      const b = map.getBounds();
      return { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() };
    },
    zoom: () => map.getZoom(),
    onClick: (cb) => map.on('click', (e) => cb(e.latlng.lat, e.latlng.lng)),
    onView: (cb) => map.on('move zoom resize viewreset', cb),
  };
}

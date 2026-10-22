// MapLibre basemap with OpenFreeMap vector tiles (free, no API key), behind a
// small interface the drawing code uses:
//   toPixel(lat, lon) -> {x, y}, bounds() -> {s, w, n, e}, zoom(),
//   onClick(cb(lat, lon)), onView(cb), setTheme(name), flyTo(lat, lon, zoom)
const STYLES = {
  dark: 'https://tiles.openfreemap.org/styles/dark',
  light: 'https://tiles.openfreemap.org/styles/positron',
};

export function createMap(el, view, theme) {
  const maplibregl = window.maplibregl;
  const map = new maplibregl.Map({
    container: el,
    style: STYLES[theme],
    center: [view.lon, view.lat],
    zoom: view.zoom,
    // The overlay assumes a north-up, flat map.
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    attributionControl: { compact: true },
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

  return {
    toPixel: (lat, lon) => map.project([lon, lat]),
    bounds() {
      const b = map.getBounds();
      return { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() };
    },
    zoom: () => map.getZoom(),
    onClick: (cb) => map.on('click', (e) => cb(e.lngLat.lat, e.lngLat.lng)),
    onView: (cb) => map.on('move', cb),
    setTheme: (name) => map.setStyle(STYLES[name]),
    flyTo: (lat, lon, zoom) => map.flyTo({ center: [lon, lat], zoom, speed: 1.6 }),

    // Resolves once every visible tile has loaded.
    whenIdle: () => new Promise((resolve) => {
      if (map.loaded() && map.areTilesLoaded()) resolve();
      else map.once('idle', resolve);
    }),

    // Road geometry from the vector tiles currently loaded (OpenMapTiles schema).
    roadFeatures: () => map.querySourceFeatures('openmaptiles', {
      sourceLayer: 'transportation',
      filter: ['in', ['get', 'class'], ['literal', ROAD_CLASSES]],
    }),
  };
}

const ROAD_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service'];

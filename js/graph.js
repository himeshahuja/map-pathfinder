// Fetches the road network from OpenStreetMap (Overpass API) and turns it
// into a weighted graph of nodes (intersections and shape points).

const ROAD_TYPES = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified',
  'residential', 'living_street', 'service', 'road',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
].join('|');

// Public Overpass mirrors, fastest/most reliable first.
const ENDPOINTS = [
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const HEDGE_MS = 6000;     // start the next mirror if the current one hasn't answered by then
const TIMEOUT_MS = 45000;  // give up on a single mirror after this

// Hedged requests: mirrors are tried in order, overlapping when one is slow,
// and the first successful response wins (the rest are aborted).
export function fetchRoads({ s, w, n, e }) {
  const query = `[out:json][timeout:45];way["highway"~"^(${ROAD_TYPES})$"](${s},${w},${n},${e});out geom qt;`;
  const controllers = [];

  return new Promise((resolve, reject) => {
    let failed = 0;
    let settled = false;
    let lastErr = null;
    let next = 0;
    let hedgeTimer = null;

    const launch = () => {
      if (settled || next >= ENDPOINTS.length) return;
      const url = ENDPOINTS[next++];
      const ctl = new AbortController();
      controllers.push(ctl);
      const timeout = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      clearTimeout(hedgeTimer);
      hedgeTimer = setTimeout(launch, HEDGE_MS);

      fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: ctl.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
          const json = await res.json();
          if (settled) return;
          settled = true;
          clearTimeout(hedgeTimer);
          controllers.forEach((c) => c !== ctl && c.abort());
          resolve(json.elements.filter((el) => el.type === 'way' && el.geometry && el.nodes));
        })
        .catch((err) => {
          if (settled) return;
          lastErr = err.name === 'AbortError' ? new Error(`timed out at ${new URL(url).host}`) : err;
          failed++;
          if (failed === ENDPOINTS.length) {
            settled = true;
            clearTimeout(hedgeTimer);
            reject(lastErr);
          } else {
            launch(); // fail fast: don't wait for the hedge timer
          }
        })
        .finally(() => clearTimeout(timeout));
    };

    launch();
  });
}

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371008.8;
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Web Mercator in [0, 1] world units, so drawing never needs per-node map API calls.
export function mercator(lat, lon) {
  const s = Math.sin(lat * Math.PI / 180);
  return {
    x: (lon + 180) / 360,
    y: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI),
  };
}

// 1 = forward only, -1 = reverse only, 0 = both directions.
function onewayDir(tags, respectOneway) {
  if (!respectOneway) return 0;
  const v = tags.oneway;
  if (v === '-1' || v === 'reverse') return -1;
  if (v === 'yes' || v === '1' || v === 'true') return 1;
  if (v === 'no') return 0;
  if (tags.junction === 'roundabout' || tags.junction === 'circular' || tags.highway === 'motorway') return 1;
  return 0;
}

export function buildGraph(ways, respectOneway) {
  const index = new Map();
  const lat = [];
  const lon = [];
  const adj = [];
  const radj = [];
  const roads = [];

  const nodeFor = (id, p) => {
    let i = index.get(id);
    if (i === undefined) {
      i = lat.length;
      index.set(id, i);
      lat.push(p.lat);
      lon.push(p.lon);
      adj.push([]);
      radj.push([]);
    }
    return i;
  };

  const addEdge = (a, b, w) => {
    adj[a].push([b, w]);
    radj[b].push([a, w]);
  };

  for (const way of ways) {
    const dir = onewayDir(way.tags || {}, respectOneway);
    let prev = -1;
    for (let k = 0; k < way.nodes.length; k++) {
      const p = way.geometry[k];
      if (!p) { prev = -1; continue; }
      const cur = nodeFor(way.nodes[k], p);
      if (prev >= 0) {
        const w = haversine(lat[prev], lon[prev], lat[cur], lon[cur]);
        roads.push(prev, cur);
        if (dir !== -1) addEdge(prev, cur, w);
        if (dir !== 1) addEdge(cur, prev, w);
      }
      prev = cur;
    }
  }

  const n = lat.length;
  const g = {
    n,
    lat: Float64Array.from(lat),
    lon: Float64Array.from(lon),
    wx: new Float64Array(n),
    wy: new Float64Array(n),
    adj,
    radj,
    roads: Int32Array.from(roads),
    inMain: new Uint8Array(n),
  };

  for (let i = 0; i < n; i++) {
    const m = mercator(g.lat[i], g.lon[i]);
    g.wx[i] = m.x;
    g.wy[i] = m.y;
  }

  markMainComponent(g);
  return g;
}

// Clicks snap only to the largest connected road network, not stray fragments
// cut off at the edge of the loaded area.
function markMainComponent(g) {
  const parent = new Int32Array(g.n);
  for (let i = 0; i < g.n; i++) parent[i] = i;
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  for (let i = 0; i < g.roads.length; i += 2) {
    const a = find(g.roads[i]);
    const b = find(g.roads[i + 1]);
    if (a !== b) parent[a] = b;
  }
  const sizes = new Map();
  let best = -1;
  let bestSize = 0;
  for (let i = 0; i < g.n; i++) {
    const r = find(i);
    const s = (sizes.get(r) || 0) + 1;
    sizes.set(r, s);
    if (s > bestSize) { bestSize = s; best = r; }
  }
  for (let i = 0; i < g.n; i++) g.inMain[i] = find(i) === best ? 1 : 0;
}

export function nearestNode(g, lat, lon) {
  const kx = Math.cos(lat * Math.PI / 180);
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < g.n; i++) {
    if (!g.inMain[i]) continue;
    const dx = (g.lon[i] - lon) * kx;
    const dy = g.lat[i] - lat;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

export function pathLength(g, path) {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += haversine(g.lat[path[i - 1]], g.lon[path[i - 1]], g.lat[path[i]], g.lon[path[i]]);
  }
  return total;
}

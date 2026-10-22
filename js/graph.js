// A road graph that grows as map tiles load. Nodes are road vertices in global
// tile units; a search asks for the tiles around a node before expanding it,
// so roads stream in exactly where the search goes.
import { fetchRoadTile, Z, EXTENT } from './tiles.js';

export const MAX_TILES = 350;      // ~1,500 km² of streets; keeps memory sane
const JOIN = 2;                    // tile units (~1 m at z14) within which vertices are one node
const CELL_STRIDE = 2 ** 26;       // spatial-hash key = cellX * stride + cellY
const SNAP = 2;                    // tile units: a road end this close to another road joins it
const SEG_CELL = 64;               // spatial-hash cell for segments, in tile units
const CLASS_RANK = { motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, minor: 5, service: 6 };

export class BudgetError extends Error {}

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371008.8;
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Web Mercator in [0, 1] world units.
export function mercator(lat, lon) {
  const s = Math.sin(lat * Math.PI / 180);
  return { x: (lon + 180) / 360, y: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI) };
}

const WORLD = EXTENT * 2 ** Z; // global tile units across the whole world

function unitsToLatLon(gx, gy) {
  const lon = (gx / WORLD) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * gy / WORLD))) * 180 / Math.PI;
  return [lat, lon];
}

export function latLonToTile(lat, lon) {
  const m = mercator(lat, lon);
  return [Math.floor(m.x * 2 ** Z), Math.floor(m.y * 2 ** Z)];
}

// 1 = forward only, -1 = reverse only, 0 = both directions.
function onewayDir(tags, respectOneway) {
  if (!respectOneway) return 0;
  const v = tags.oneway;
  if (v === 1 || v === '1' || v === 'yes') return 1;
  if (v === -1 || v === '-1') return -1;
  return 0;
}

export class RoadGraph {
  constructor() {
    this.respectOneway = true;
    this.tiles = new Map(); // "x,y" -> { promise, ready, ways, path }
    this.onTile = () => {};
    this.clear();
  }

  clear() {
    this.gx = [];
    this.gy = [];
    this.lat = [];
    this.lon = [];
    this.wx = [];
    this.wy = [];
    this.rank = [];
    this.adj = [];
    this.radj = [];
    this.cells = new Map();    // spatial hash: cell -> node ids
    this.segCells = new Map(); // spatial hash: cell -> segments
    this.edges = new Set();
  }

  get n() { return this.lat.length; }
  get tileCount() { return this.tiles.size; }

  // --- Building ----------------------------------------------------------------

  // Vertices within JOIN units of each other are one node. Intersections in the
  // tiles are often a unit apart, and so are the crossing points two
  // neighbouring tiles produce for the same road at their shared edge.
  node(x, y, rank) {
    const cx = Math.floor(x / JOIN);
    const cy = Math.floor(y / JOIN);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = this.cells.get((cx + dx) * CELL_STRIDE + (cy + dy));
        if (!list) continue;
        for (const id of list) {
          if (Math.abs(this.gx[id] - x) <= JOIN && Math.abs(this.gy[id] - y) <= JOIN) {
            if (rank < this.rank[id]) this.rank[id] = rank;
            return id;
          }
        }
      }
    }

    const id = this.lat.length;
    const [lat, lon] = unitsToLatLon(x, y);
    this.gx.push(x);
    this.gy.push(y);
    this.lat.push(lat);
    this.lon.push(lon);
    this.wx.push(x / WORLD);
    this.wy.push(y / WORLD);
    this.rank.push(rank);
    this.adj.push([]);
    this.radj.push([]);
    const key = cx * CELL_STRIDE + cy;
    if (!this.cells.has(key)) this.cells.set(key, []);
    this.cells.get(key).push(id);
    return id;
  }

  dist(a, b) {
    return haversine(this.lat[a], this.lon[a], this.lat[b], this.lon[b]);
  }

  addEdge(a, b) {
    const key = `${a},${b}`;
    if (this.edges.has(key)) return;
    this.edges.add(key);
    const w = this.dist(a, b);
    this.adj[a].push([b, w]);
    this.radj[b].push([a, w]);
  }

  removeEdge(a, b) {
    if (!this.edges.delete(`${a},${b}`)) return false;
    this.adj[a] = this.adj[a].filter(([v]) => v !== b);
    this.radj[b] = this.radj[b].filter(([v]) => v !== a);
    return true;
  }

  // Undirected segments in a coarse spatial hash, for snapping road ends.
  indexSegment(a, b) {
    const seg = { a, b, alive: true };
    const x0 = Math.floor(Math.min(this.gx[a], this.gx[b]) / SEG_CELL);
    const x1 = Math.floor(Math.max(this.gx[a], this.gx[b]) / SEG_CELL);
    const y0 = Math.floor(Math.min(this.gy[a], this.gy[b]) / SEG_CELL);
    const y1 = Math.floor(Math.max(this.gy[a], this.gy[b]) / SEG_CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = cx * CELL_STRIDE + cy;
        if (!this.segCells.has(key)) this.segCells.set(key, []);
        this.segCells.get(key).push(seg);
      }
    }
  }

  addWays(ways) {
    const ends = [];
    for (const way of ways) {
      const dir = onewayDir(way.tags, this.respectOneway);
      const rank = CLASS_RANK[way.tags.class] ?? 6;
      let prev = -1;
      for (const [x, y] of way.pts) {
        const cur = this.node(x, y, rank);
        if (prev >= 0 && prev !== cur) {
          const isNew = !this.edges.has(`${prev},${cur}`) && !this.edges.has(`${cur},${prev}`);
          if (dir !== -1) this.addEdge(prev, cur);
          if (dir !== 1) this.addEdge(cur, prev);
          if (isNew) this.indexSegment(prev, cur);
        }
        prev = cur;
      }
      const first = this.node(way.pts[0][0], way.pts[0][1], rank);
      ends.push(first, prev);
    }
    for (const e of ends) this.snapEnd(e);
  }

  // The tiles simplify roads, which often drops the shared vertex where a side
  // street meets a straight road. A road end lying on another road is joined
  // to it by splitting that road at the end (keeping its one-way direction).
  snapEnd(e) {
    const x = this.gx[e];
    const y = this.gy[e];
    const near = new Set([e]);
    for (const [v] of this.adj[e]) near.add(v);
    for (const [v] of this.radj[e]) near.add(v);

    let best = null;
    let bestD = SNAP;
    const cx = Math.floor(x / SEG_CELL);
    const cy = Math.floor(y / SEG_CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const seg of this.segCells.get((cx + dx) * CELL_STRIDE + (cy + dy)) || []) {
          if (!seg.alive || near.has(seg.a) || near.has(seg.b)) continue;
          const ax = this.gx[seg.a];
          const ay = this.gy[seg.a];
          const vx = this.gx[seg.b] - ax;
          const vy = this.gy[seg.b] - ay;
          const len2 = vx * vx + vy * vy;
          if (!len2) continue;
          const t = ((x - ax) * vx + (y - ay) * vy) / len2;
          if (t <= 0 || t >= 1) continue;
          const d = Math.hypot(ax + t * vx - x, ay + t * vy - y);
          if (d <= bestD) { bestD = d; best = seg; }
        }
      }
    }
    if (!best) return;

    const { a, b } = best;
    best.alive = false;
    if (this.removeEdge(a, b)) { this.addEdge(a, e); this.addEdge(e, b); }
    if (this.removeEdge(b, a)) { this.addEdge(b, e); this.addEdge(e, a); }
    this.indexSegment(a, e);
    this.indexSegment(e, b);
  }

  // Rebuild every loaded tile, e.g. after the one-way setting changes. Node ids change.
  rebuild() {
    this.clear();
    for (const t of this.tiles.values()) if (t.ready && t.ways) this.addWays(t.ways);
  }

  // --- Tiles -------------------------------------------------------------------

  loadTile(tx, ty) {
    const key = `${tx},${ty}`;
    const existing = this.tiles.get(key);
    if (existing) return existing.promise;
    if (this.tiles.size >= MAX_TILES) return Promise.reject(new BudgetError('tile budget reached'));

    const entry = { tx, ty, ready: false, ways: null, path: null };
    entry.promise = fetchRoadTile(tx, ty)
      .catch((err) => { console.warn(err); return []; }) // a failed tile counts as empty
      .then((ways) => {
        entry.ways = ways;
        entry.path = tilePath(ways, tx, ty);
        entry.ready = true;
        this.addWays(ways);
        this.onTile(entry);
      });
    this.tiles.set(key, entry);
    return entry.promise;
  }

  // Tiles that can contribute edges to the node: its own, plus any neighbour
  // whose edge is within joining distance (1, 2 or 4 tiles).
  nodeTiles(i) {
    const x = this.gx[i];
    const y = this.gy[i];
    const xs = [Math.floor(x / EXTENT)];
    const ys = [Math.floor(y / EXTENT)];
    const rx = x - xs[0] * EXTENT;
    const ry = y - ys[0] * EXTENT;
    if (rx <= JOIN) xs.push(xs[0] - 1);
    else if (EXTENT - rx <= JOIN) xs.push(xs[0] + 1);
    if (ry <= JOIN) ys.push(ys[0] - 1);
    else if (EXTENT - ry <= JOIN) ys.push(ys[0] + 1);
    const out = [];
    for (const tx of xs) for (const ty of ys) out.push([tx, ty]);
    return out;
  }

  ready(i) {
    return this.nodeTiles(i).every(([tx, ty]) => this.tiles.get(`${tx},${ty}`)?.ready);
  }

  // Load everything a node's edges can come from, and warm up the ring around it.
  ensure(i) {
    const needed = this.nodeTiles(i);
    const loads = needed.map(([tx, ty]) => this.loadTile(tx, ty));
    if (this.tiles.size < MAX_TILES * 0.85) {
      const [tx, ty] = needed[0];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) this.loadTile(tx + dx, ty + dy).catch(() => {});
      }
    }
    return Promise.all(loads);
  }

  // Nearest road node to a point, loading the tiles around it first. Prefers
  // real streets over service roads (parking lots, driveways) when close.
  async nearest(lat, lon) {
    const [tx, ty] = latLonToTile(lat, lon);
    const loads = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) loads.push(this.loadTile(tx + dx, ty + dy));
    await Promise.all(loads);

    const kx = Math.cos(lat * Math.PI / 180);
    let best = -1;
    let bestD = Infinity;
    let street = -1;
    let streetD = Infinity;
    for (let i = 0; i < this.n; i++) {
      const dx = (this.lon[i] - lon) * kx;
      const dy = this.lat[i] - lat;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
      if (this.rank[i] < 6 && d < streetD) { streetD = d; street = i; }
    }
    if (best < 0) return -1;
    const m = (d) => Math.sqrt(d) * 111320;
    return street >= 0 && m(streetD) <= Math.max(60, m(bestD) * 1.5) ? street : best;
  }
}

// Road segments of one tile as a Path2D in tile-local units, drawn with a
// per-tile transform so huge networks pan smoothly.
function tilePath(ways, tx, ty) {
  const path = new Path2D();
  const ox = tx * EXTENT;
  const oy = ty * EXTENT;
  for (const { pts } of ways) {
    path.moveTo(pts[0][0] - ox, pts[0][1] - oy);
    for (let k = 1; k < pts.length; k++) path.lineTo(pts[k][0] - ox, pts[k][1] - oy);
  }
  return path;
}

export function pathLength(g, path) {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += haversine(g.lat[path[i - 1]], g.lon[path[i - 1]], g.lat[path[i]], g.lon[path[i]]);
  }
  return total;
}

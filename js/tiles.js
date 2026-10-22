// Fetches OpenFreeMap vector tiles (OpenMapTiles schema) directly and pulls out
// the road geometry. Each road is clipped exactly to its tile's edges, so the
// same crossing point is produced by the tiles on both sides of a border and
// neighbouring tiles join up into one network.

export const Z = 14;          // the most detailed zoom the tiles have
export const EXTENT = 4096;   // tile-local units per tile edge (normalised)

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const ROAD_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service']);

let templatePromise = null;

function tileTemplate() {
  if (!templatePromise) {
    templatePromise = fetch(TILEJSON)
      .then((r) => r.json())
      .then((j) => j.tiles[0])
      .catch((err) => { templatePromise = null; throw err; });
  }
  return templatePromise;
}

// Returns road pieces in global tile units ([x, y] with x = tileX * EXTENT + local x).
export async function fetchRoadTile(tx, ty) {
  const url = (await tileTemplate()).replace('{z}', Z).replace('{x}', tx).replace('{y}', ty);
  const res = await fetch(url);
  if (res.status === 204 || res.status === 404) return [];
  if (!res.ok) throw new Error(`tile ${tx},${ty}: HTTP ${res.status}`);
  let bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return extractRoads(bytes, tx, ty);
}

// --- Minimal protobuf reader for the Mapbox Vector Tile format ---------------------

class Reader {
  constructor(buf, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }

  varint() {
    let result = 0;
    let shift = 0;
    let b;
    do {
      b = this.buf[this.pos++];
      result += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return result;
  }

  bytes() {
    const len = this.varint();
    const start = this.pos;
    this.pos += len;
    return [start, this.pos];
  }

  skip(type) {
    if (type === 0) this.varint();
    else if (type === 1) this.pos += 8;
    else if (type === 2) this.pos += this.varint();
    else if (type === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${type}`);
  }

  // Calls fn(field, type) for each field; fn returns true when it consumed the value.
  fields(fn) {
    while (this.pos < this.end) {
      const tag = this.varint();
      const field = tag >> 3;
      const type = tag & 7;
      if (!fn(field, type)) this.skip(type);
    }
  }
}

const utf8 = new TextDecoder();
const zigzag = (n) => (n % 2 ? -(n + 1) / 2 : n / 2);

function readValue(buf, start, end) {
  const r = new Reader(buf, start, end);
  const view = new DataView(buf.buffer, buf.byteOffset);
  let value = null;
  r.fields((field, type) => {
    if (field === 1) { const [s, e] = r.bytes(); value = utf8.decode(buf.subarray(s, e)); return true; }
    if (field === 2) { value = view.getFloat32(r.pos, true); r.pos += 4; return true; }
    if (field === 3) { value = view.getFloat64(r.pos, true); r.pos += 8; return true; }
    if (field === 4 || field === 5) { value = r.varint(); return true; }
    if (field === 6) { value = zigzag(r.varint()); return true; }
    if (field === 7) { value = !!r.varint(); return true; }
    return false;
  });
  return value;
}

function readPacked(r) {
  const [s, e] = r.bytes();
  const sub = new Reader(r.buf, s, e);
  const out = [];
  while (sub.pos < e) out.push(sub.varint());
  return out;
}

function decodeLines(cmds, scale, ox, oy) {
  const lines = [];
  let line = null;
  let x = 0;
  let y = 0;
  for (let i = 0; i < cmds.length;) {
    const cmd = cmds[i] & 7;
    const count = cmds[i] >> 3;
    i++;
    if (cmd === 7) continue; // ClosePath
    for (let k = 0; k < count; k++) {
      x += zigzag(cmds[i++]);
      y += zigzag(cmds[i++]);
      const p = [ox + Math.round(x * scale), oy + Math.round(y * scale)];
      if (cmd === 1) { line = [p]; lines.push(line); } else line.push(p);
    }
  }
  return lines;
}

function extractRoads(buf, tx, ty) {
  const tile = new Reader(buf);
  const out = [];
  tile.fields((field, type) => {
    if (field !== 3 || type !== 2) return false;
    const [ls, le] = tile.bytes();
    const layer = new Reader(buf, ls, le);
    let name = '';
    let extent = 4096;
    const keys = [];
    const values = [];
    const features = [];
    layer.fields((f) => {
      if (f === 1) { const [s, e] = layer.bytes(); name = utf8.decode(buf.subarray(s, e)); return true; }
      if (f === 2) { features.push(layer.bytes()); return true; }
      if (f === 3) { const [s, e] = layer.bytes(); keys.push(utf8.decode(buf.subarray(s, e))); return true; }
      if (f === 4) { const [s, e] = layer.bytes(); values.push(readValue(buf, s, e)); return true; }
      if (f === 5) { extent = layer.varint(); return true; }
      return false;
    });
    if (name !== 'transportation') return true;

    const scale = EXTENT / extent;
    const x0 = tx * EXTENT;
    const y0 = ty * EXTENT;
    for (const [fs, fe] of features) {
      const fr = new Reader(buf, fs, fe);
      let tags = [];
      let geomType = 0;
      let geometry = [];
      fr.fields((f) => {
        if (f === 2) { tags = readPacked(fr); return true; }
        if (f === 3) { geomType = fr.varint(); return true; }
        if (f === 4) { geometry = readPacked(fr); return true; }
        return false;
      });
      if (geomType !== 2) continue; // LineString only
      const props = {};
      for (let i = 0; i < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];
      if (!ROAD_CLASSES.has(props.class)) continue;
      const wayTags = { class: props.class, oneway: props.oneway ?? 0 };
      for (const line of decodeLines(geometry, scale, x0, y0)) {
        for (const pts of clipLine(line, x0, y0, x0 + EXTENT, y0 + EXTENT)) out.push({ pts, tags: wayTags });
      }
    }
    return true;
  });
  return out;
}

// --- Exact clipping to the tile square (Liang–Barsky per segment) ------------------

function clipSegment(ax, ay, bx, by, x0, y0, x1, y1) {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - x0, x1 - ax, ay - y0, y1 - ay];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return [ax + t0 * dx, ay + t0 * dy, ax + t1 * dx, ay + t1 * dy, t1 < 1];
}

function clipLine(line, x0, y0, x1, y1) {
  const pieces = [];
  let cur = null;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1];
    const [bx, by] = line[i];
    const seg = clipSegment(ax, ay, bx, by, x0, y0, x1, y1);
    if (!seg) { cur = null; continue; }
    const p = [Math.round(seg[0]), Math.round(seg[1])];
    const q = [Math.round(seg[2]), Math.round(seg[3])];
    const last = cur && cur[cur.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) {
      cur = [p];
      pieces.push(cur);
    }
    cur.push(q);
    if (seg[4]) cur = null; // left the tile
  }
  return pieces.filter((pts) => pts.length > 1);
}

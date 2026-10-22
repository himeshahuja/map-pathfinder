import { fetchRoads, buildGraph, nearestNode, pathLength, mercator } from './graph.js';
import { ALGORITHMS } from './algorithms.js';
import { createMap } from './maps.js';

// Default view: UVA Grounds to the Downtown Mall, Charlottesville.
const DEFAULT_VIEW = { lat: 38.0335, lon: -78.4925, zoom: 15 };
const DEMO = { start: [38.0356, -78.5034], end: [38.0302, -78.4801] };
const MIN_LOAD_ZOOM = 14;
const SPEEDS = [1, 2, 4, 8, 16, 32, 64, 128, 512, 4096]; // nodes settled per frame

const COLORS = {
  road: 'rgba(60, 64, 67, 0.28)',
  explored: ['rgba(26, 115, 232, 0.8)', 'rgba(147, 52, 230, 0.8)'],
  path: '#ff6d00',
  start: '#188038',
  end: '#d93025',
};

const $ = (id) => document.getElementById(id);

const state = {
  map: null,
  ways: null,
  graph: null,
  bbox: null,
  startLL: null,
  endLL: null,
  start: -1,
  end: -1,
  exFrom: [],
  exTo: [],
  exSide: [],
  path: null,
  pathT: 1,
  run: null,
  raf: 0,
  results: new Map(),
  shownKey: null,
};

// --- Canvas layers ----------------------------------------------------------

const cvExplored = $('layer-explored');
const cvTop = $('layer-top');
const ctxE = cvExplored.getContext('2d');
const ctxT = cvTop.getContext('2d');
let view = { k: 1, ox: 0, oy: 0 };

function resizeCanvases() {
  const dpr = window.devicePixelRatio || 1;
  for (const c of [cvExplored, cvTop]) {
    c.width = Math.round(c.clientWidth * dpr);
    c.height = Math.round(c.clientHeight * dpr);
    c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  redrawAll();
}

// Derive a linear Mercator-world -> container-pixel transform from two points,
// so thousands of nodes can be projected without calling the map API for each.
function updateView() {
  const b = state.map.bounds();
  const p1 = state.map.toPixel(b.n, b.w);
  const p2 = state.map.toPixel(b.s, b.e);
  const w1 = mercator(b.n, b.w);
  const w2 = mercator(b.s, b.e);
  const k = (p2.x - p1.x) / (w2.x - w1.x);
  view = { k, ox: p1.x - w1.x * k, oy: p1.y - w1.y * k };
}

const px = (i) => state.graph.wx[i] * view.k + view.ox;
const py = (i) => state.graph.wy[i] * view.k + view.oy;

function strokeSegments(ctx, color, width, from, to, i0, i1, sideArr, side) {
  ctx.beginPath();
  for (let i = i0; i < i1; i++) {
    if (sideArr && sideArr[i] !== side) continue;
    const a = from[i];
    const b = to[i];
    ctx.moveTo(px(a), py(a));
    ctx.lineTo(px(b), py(b));
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.stroke();
}

function drawExploredRange(i0, i1) {
  for (const side of [0, 1]) {
    strokeSegments(ctxE, COLORS.explored[side], 2.25, state.exFrom, state.exTo, i0, i1, state.exSide, side);
  }
}

function redrawExplored() {
  ctxE.clearRect(0, 0, cvExplored.clientWidth, cvExplored.clientHeight);
  const g = state.graph;
  if (!g) return;

  // Faint overlay of the loaded road network and its boundary.
  ctxE.beginPath();
  for (let i = 0; i < g.roads.length; i += 2) {
    const a = g.roads[i];
    const b = g.roads[i + 1];
    ctxE.moveTo(px(a), py(a));
    ctxE.lineTo(px(b), py(b));
  }
  ctxE.strokeStyle = COLORS.road;
  ctxE.lineWidth = 1;
  ctxE.stroke();

  if (state.bbox) {
    const nw = mercator(state.bbox.n, state.bbox.w);
    const se = mercator(state.bbox.s, state.bbox.e);
    ctxE.save();
    ctxE.setLineDash([6, 6]);
    ctxE.strokeStyle = 'rgba(26, 115, 232, 0.55)';
    ctxE.lineWidth = 1.5;
    ctxE.strokeRect(nw.x * view.k + view.ox, nw.y * view.k + view.oy, (se.x - nw.x) * view.k, (se.y - nw.y) * view.k);
    ctxE.restore();
  }

  drawExploredRange(0, state.exFrom.length);
}

function drawMarker(node, color) {
  if (node < 0) return;
  const x = px(node);
  const y = py(node);
  ctxT.beginPath();
  ctxT.arc(x, y, 8, 0, Math.PI * 2);
  ctxT.fillStyle = color;
  ctxT.fill();
  ctxT.lineWidth = 3;
  ctxT.strokeStyle = '#fff';
  ctxT.stroke();
}

function drawTop() {
  ctxT.clearRect(0, 0, cvTop.clientWidth, cvTop.clientHeight);
  if (!state.graph) return;

  const path = state.path;
  if (path && path.length > 1) {
    const segs = Math.max(1, Math.floor(state.pathT * (path.length - 1)));
    ctxT.beginPath();
    ctxT.moveTo(px(path[0]), py(path[0]));
    for (let i = 1; i <= segs; i++) ctxT.lineTo(px(path[i]), py(path[i]));
    ctxT.lineJoin = 'round';
    ctxT.lineCap = 'round';
    ctxT.strokeStyle = '#fff';
    ctxT.lineWidth = 9;
    ctxT.stroke();
    ctxT.strokeStyle = COLORS.path;
    ctxT.lineWidth = 5;
    ctxT.stroke();
  }

  drawMarker(state.start, COLORS.start);
  drawMarker(state.end, COLORS.end);
}

let redrawQueued = false;
function redrawAll() {
  if (!state.map || redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => {
    redrawQueued = false;
    updateView();
    redrawExplored();
    drawTop();
  });
}

// --- Search and animation -----------------------------------------------------

function clearSearch() {
  stopRun();
  state.exFrom = [];
  state.exTo = [];
  state.exSide = [];
  state.path = null;
  state.pathT = 1;
  $('live').textContent = '';
  redrawAll();
}

function stopRun() {
  state.run = null;
  cancelAnimationFrame(state.raf);
}

function ready() {
  return state.graph && state.start >= 0 && state.end >= 0;
}

function startRun(key) {
  if (!ready()) return;
  clearSearch();
  const algo = ALGORITHMS[key];
  state.run = { key, gen: algo.run(state.graph, state.start, state.end), visited: 0 };
  state.shownKey = key;
  setStatus(`Running ${algo.name}…`);
  renderResults();
  state.raf = requestAnimationFrame(frame);
}

function frame() {
  const run = state.run;
  if (run) {
    const steps = SPEEDS[$('speed').value - 1];
    const i0 = state.exFrom.length;
    let res;
    for (let i = 0; i < steps; i++) {
      res = run.gen.next();
      if (res.done) break;
      const e = res.value;
      run.visited++;
      if (e.from >= 0) {
        state.exFrom.push(e.from);
        state.exTo.push(e.to);
        state.exSide.push(e.side);
      }
    }
    drawExploredRange(i0, state.exFrom.length);
    $('live').textContent = `Visited ${run.visited.toLocaleString()} nodes`;
    if (res.done) finishRun(run, res.value);
  }

  if (state.path && state.pathT < 1) state.pathT = Math.min(1, state.pathT + 1 / 40);
  drawTop();

  if (state.run || (state.path && state.pathT < 1)) state.raf = requestAnimationFrame(frame);
}

function finishRun(run, path) {
  state.run = null;
  const algo = ALGORITHMS[run.key];
  const result = measure(run.key);
  state.results.set(run.key, result);
  renderResults();

  if (!path) {
    setStatus(`${algo.name}: no route found${$('oneway').checked ? ' (one-way streets may block it)' : ''}.`, 'warn');
    return;
  }
  state.path = path;
  state.pathT = 0;
  setStatus(`${algo.name} found a ${fmtKm(result.length)} route.`);
  $('live').textContent = `Visited ${run.visited.toLocaleString()} nodes · ${path.length.toLocaleString()} nodes on path`;
}

// Runs an algorithm to completion off-screen to get honest timings.
function measure(key) {
  const g = state.graph;
  const gen = ALGORITHMS[key].run(g, state.start, state.end);
  const t0 = performance.now();
  let visited = 0;
  let res;
  while (!(res = gen.next()).done) visited++;
  const ms = performance.now() - t0;
  const path = res.value;
  return { visited, ms, path, length: path ? pathLength(g, path) : null };
}

function compareAll() {
  if (!ready()) return;
  clearSearch();
  for (const key of Object.keys(ALGORITHMS)) state.results.set(key, measure(key));
  state.shownKey = null;
  renderResults();
  setStatus('Compared every algorithm. Click a row to replay it.');
}

// --- UI ---------------------------------------------------------------------

const fmtKm = (m) => (m == null ? 'n/a' : `${(m / 1000).toFixed(2)} km`);

function setStatus(text, kind = '') {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${kind}`;
}

function renderResults() {
  const table = $('results');
  const body = table.querySelector('tbody');
  body.replaceChildren();
  if (!state.results.size) { table.hidden = true; return; }
  table.hidden = false;

  const lengths = [...state.results.values()].map((r) => r.length).filter((l) => l != null);
  const shortest = lengths.length ? Math.min(...lengths) : null;

  for (const key of Object.keys(ALGORITHMS)) {
    const r = state.results.get(key);
    if (!r) continue;
    const tr = document.createElement('tr');
    if (key === state.shownKey) tr.className = 'active';

    let tag = '';
    if (r.length != null && shortest != null) {
      const over = (r.length / shortest - 1) * 100;
      tag = over < 0.05
        ? '<div class="tag">shortest</div>'
        : `<div class="tag worse">+${over.toFixed(over < 10 ? 1 : 0)}%</div>`;
    }

    tr.innerHTML = `<td>${ALGORITHMS[key].name}</td>
      <td>${r.visited.toLocaleString()}</td>
      <td>${fmtKm(r.length)}${tag}</td>
      <td>${r.ms < 10 ? r.ms.toFixed(1) : Math.round(r.ms)} ms</td>`;
    tr.addEventListener('click', () => {
      $('algo').value = key;
      updateAlgoDesc();
      startRun(key);
    });
    body.appendChild(tr);
  }
}

function updateAlgoDesc() {
  $('algo-desc').textContent = ALGORITHMS[$('algo').value].desc;
}

function updateSpeedLabel() {
  $('speed-val').textContent = `${SPEEDS[$('speed').value - 1].toLocaleString()} nodes/frame`;
}

function updateButtons() {
  const ok = ready();
  $('run').disabled = !ok;
  $('compare').disabled = !ok;
}

function setPoint(which, lat, lon) {
  const node = nearestNode(state.graph, lat, lon);
  if (which === 'start') { state.startLL = [lat, lon]; state.start = node; }
  else { state.endLL = [lat, lon]; state.end = node; }
}

function handleClick(lat, lon) {
  if (!state.graph) {
    setStatus('Load roads first: zoom in and press "Load roads in view".', 'warn');
    return;
  }
  if (state.start < 0 || state.end >= 0) {
    setPoint('start', lat, lon);
    state.end = -1;
    state.endLL = null;
    state.results.clear();
    renderResults();
    clearSearch();
    setStatus('Start set. Click again to set the goal.');
  } else {
    setPoint('end', lat, lon);
    state.results.clear();
    startRun($('algo').value);
  }
  updateButtons();
  drawTop();
}

function rebuildGraph() {
  stopRun();
  state.graph = buildGraph(state.ways, $('oneway').checked);
  // Re-snap any chosen points onto the new graph.
  state.start = state.startLL ? nearestNode(state.graph, ...state.startLL) : -1;
  state.end = state.endLL ? nearestNode(state.graph, ...state.endLL) : -1;
  state.results.clear();
  renderResults();
  clearSearch();
  updateButtons();
}

const inBbox = ([lat, lon], b) => lat >= b.s && lat <= b.n && lon >= b.w && lon <= b.e;

async function loadRoads({ demo = false } = {}) {
  if (state.map.zoom() < MIN_LOAD_ZOOM) {
    setStatus(`Zoom in a bit more (to level ${MIN_LOAD_ZOOM}+) to load roads.`, 'warn');
    return;
  }
  stopRun();
  const btn = $('load');
  btn.disabled = true;
  setStatus('Loading roads from OpenStreetMap…');
  try {
    const bbox = state.map.bounds();
    state.ways = await fetchRoads(bbox);
    state.bbox = bbox;
    if (demo && inBbox(DEMO.start, bbox) && inBbox(DEMO.end, bbox)) {
      state.startLL = DEMO.start;
      state.endLL = DEMO.end;
    } else if (state.startLL && !inBbox(state.startLL, bbox)) {
      state.startLL = null;
      state.endLL = null;
    }
    rebuildGraph();
    const g = state.graph;
    setStatus(`Loaded ${g.n.toLocaleString()} road nodes. Click the map to set a start.`);
    if (ready()) startRun($('algo').value);
  } catch (err) {
    setStatus(`Couldn't load roads: ${err.message}. Try again in a moment.`, 'error');
  } finally {
    btn.disabled = false;
  }
}

function initControls() {
  const select = $('algo');
  for (const [key, a] of Object.entries(ALGORITHMS)) select.add(new Option(a.name, key));
  select.addEventListener('change', () => {
    updateAlgoDesc();
    if (ready()) startRun(select.value);
  });
  updateAlgoDesc();

  $('speed').addEventListener('input', updateSpeedLabel);
  updateSpeedLabel();

  $('run').addEventListener('click', () => startRun($('algo').value));
  $('compare').addEventListener('click', compareAll);
  $('clear').addEventListener('click', () => {
    state.start = state.end = -1;
    state.startLL = state.endLL = null;
    state.results.clear();
    renderResults();
    clearSearch();
    updateButtons();
    setStatus('Cleared. Click the map to set a start.');
  });
  $('load').addEventListener('click', () => loadRoads());
  $('oneway').addEventListener('change', () => {
    if (!state.ways) return;
    rebuildGraph();
    if (ready()) startRun($('algo').value);
  });

  updateButtons();
}

function init() {
  initControls();
  state.map = createMap($('map'), DEFAULT_VIEW);
  state.map.onClick(handleClick);
  state.map.onView(redrawAll);
  new ResizeObserver(resizeCanvases).observe($('map-wrap'));
  resizeCanvases();

  loadRoads({ demo: true });
}

init();

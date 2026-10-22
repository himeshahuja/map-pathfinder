import { buildGraph, waysFromFeatures, nearestNode, pathLength, mercator } from './graph.js';
import { ALGORITHMS } from './algorithms.js';
import { createMap } from './maps.js';

// Default view: UVA Grounds to the Downtown Mall, Charlottesville.
const DEFAULT_VIEW = { lat: 38.0335, lon: -78.4925, zoom: 14.6 };
const DEMO = { start: [38.0356, -78.5034], end: [38.0302, -78.4801] };
const MIN_ROUTE_ZOOM = 13;     // below this the tiles drop residential streets
const SPEEDS = [1, 2, 4, 8, 16, 32, 64, 128, 512, 4096]; // nodes settled per frame
const THEME_KEY = 'mapPathfinder.theme';

// Keep in sync with the --c-* variables in style.css.
const PALETTES = {
  dark: {
    road: 'rgba(255, 255, 255, 0.08)',
    explored: ['rgba(56, 189, 248, 0.85)', 'rgba(232, 121, 249, 0.85)'],
    path: '#ffb020',
    casing: 'rgba(8, 10, 16, 0.9)',
    glow: 'rgba(255, 176, 32, 0.7)',
    start: '#22c55e',
    end: '#f43f5e',
    area: 'rgba(148, 163, 184, 0.45)',
  },
  light: {
    road: 'rgba(60, 64, 67, 0.18)',
    explored: ['rgba(26, 115, 232, 0.8)', 'rgba(147, 52, 230, 0.8)'],
    path: '#ff6d00',
    casing: '#ffffff',
    glow: 'rgba(255, 109, 0, 0.35)',
    start: '#188038',
    end: '#d93025',
    area: 'rgba(26, 115, 232, 0.45)',
  },
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
  loading: false,
  results: new Map(),
  shownKey: null,
};

let theme = loadTheme();
let C = PALETTES[theme];

function loadTheme() {
  try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch (_) { return 'dark'; }
}

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

function llPx([lat, lon]) {
  const m = mercator(lat, lon);
  return { x: m.x * view.k + view.ox, y: m.y * view.k + view.oy };
}

function strokeExplored(ctx, i0, i1, side) {
  ctx.beginPath();
  for (let i = i0; i < i1; i++) {
    if (state.exSide[i] !== side) continue;
    const a = state.exFrom[i];
    const b = state.exTo[i];
    ctx.moveTo(px(a), py(a));
    ctx.lineTo(px(b), py(b));
  }
  ctx.strokeStyle = C.explored[side];
  ctx.lineWidth = 2.25;
  ctx.lineCap = 'round';
  ctx.stroke();
}

function drawExploredRange(i0, i1) {
  strokeExplored(ctxE, i0, i1, 0);
  strokeExplored(ctxE, i0, i1, 1);
}

function strokeBbox(ctx, bbox, color) {
  const nw = llPx([bbox.n, bbox.w]);
  const se = llPx([bbox.s, bbox.e]);
  ctx.save();
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(nw.x, nw.y, se.x - nw.x, se.y - nw.y);
  ctx.restore();
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
  ctxE.strokeStyle = C.road;
  ctxE.lineWidth = 1;
  ctxE.stroke();

  if (state.bbox) strokeBbox(ctxE, state.bbox, C.area);
  drawExploredRange(0, state.exFrom.length);
}

function drawMarker(node, ll, color) {
  if (!ll) return;
  const p = node >= 0 && state.graph ? { x: px(node), y: py(node) } : llPx(ll);
  ctxT.beginPath();
  ctxT.arc(p.x, p.y, 8, 0, Math.PI * 2);
  ctxT.fillStyle = color;
  ctxT.fill();
  ctxT.lineWidth = 3;
  ctxT.strokeStyle = '#fff';
  ctxT.stroke();
}

function drawTop() {
  ctxT.clearRect(0, 0, cvTop.clientWidth, cvTop.clientHeight);
  if (!state.map) return;

  const path = state.path;
  if (path && path.length > 1 && state.graph) {
    const segs = Math.max(1, Math.floor(state.pathT * (path.length - 1)));
    ctxT.beginPath();
    ctxT.moveTo(px(path[0]), py(path[0]));
    for (let i = 1; i <= segs; i++) ctxT.lineTo(px(path[i]), py(path[i]));
    ctxT.lineJoin = 'round';
    ctxT.lineCap = 'round';
    ctxT.strokeStyle = C.casing;
    ctxT.lineWidth = 9;
    ctxT.stroke();
    ctxT.save();
    ctxT.shadowColor = C.glow;
    ctxT.shadowBlur = 14;
    ctxT.strokeStyle = C.path;
    ctxT.lineWidth = 5;
    ctxT.stroke();
    ctxT.restore();
  }

  drawMarker(state.start, state.startLL, C.start);
  drawMarker(state.end, state.endLL, C.end);
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
  if (refreshPending) {
    refreshPending = false;
    scheduleRefresh();
  }
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

// --- Road data ----------------------------------------------------------------

const inBbox = ([lat, lon], b) => !!b && lat >= b.s && lat <= b.n && lon >= b.w && lon <= b.e;

function snapPoints() {
  const g = state.graph;
  state.start = state.startLL && inBbox(state.startLL, state.bbox) ? nearestNode(g, ...state.startLL) : -1;
  state.end = state.endLL && inBbox(state.endLL, state.bbox) ? nearestNode(g, ...state.endLL) : -1;
}

function rebuildGraph() {
  stopRun();
  state.graph = buildGraph(state.ways, $('oneway').checked);
  snapPoints();
  state.results.clear();
  renderResults();
  clearSearch();
  updateButtons();
}

// Builds the graph from the road geometry in the vector tiles on screen, so
// routing works anywhere without a separate road-data download.
async function buildFromView({ quiet = false } = {}) {
  if (state.map.zoom() < MIN_ROUTE_ZOOM) {
    if (!quiet) setStatus('Zoom in to street level to route.', 'warn');
    return false;
  }
  state.loading = true;
  try {
    await state.map.whenIdle();
    const ways = waysFromFeatures(state.map.roadFeatures());
    if (!ways.length) {
      if (!quiet) setStatus('No roads in view here.', 'warn');
      return false;
    }
    state.ways = ways;
    state.bbox = state.map.bounds();
    rebuildGraph();
    return true;
  } finally {
    state.loading = false;
  }
}

// Whenever the view settles, rebuild the graph from the roads now on screen.
// A route that is still fully in view is re-solved instantly on the new graph.
let refreshTimer = 0;
let refreshPending = false;

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshRoads, 150);
}

async function refreshRoads() {
  if (state.loading) return;
  if (state.run) { refreshPending = true; return; } // finish the animation first
  const hadRoute = !!state.path;
  if (!await buildFromView({ quiet: true })) return;
  if (ready()) {
    if (hadRoute) runInstant($('algo').value);
    else startRun($('algo').value);
  } else if (state.startLL && state.endLL) {
    setStatus('Part of the route is off screen. Pan back, or click a new start.');
  }
}

// Solves without animating, for re-solving after the map moves.
function runInstant(key) {
  clearSearch();
  const gen = ALGORITHMS[key].run(state.graph, state.start, state.end);
  let res;
  while (!(res = gen.next()).done) {
    const e = res.value;
    if (e.from >= 0) {
      state.exFrom.push(e.from);
      state.exTo.push(e.to);
      state.exSide.push(e.side);
    }
  }
  state.shownKey = key;
  finishRun({ key, visited: state.exFrom.length + 1 }, res.value);
  state.pathT = 1;
  redrawAll();
}

async function loadDemo() {
  setStatus('Loading roads…');
  state.startLL = DEMO.start;
  state.endLL = DEMO.end;
  if (await buildFromView()) startRun($('algo').value);
}

async function handleClick(lat, lon) {
  if (state.loading) return;
  const ll = [lat, lon];

  // First click (or a click after a finished route) sets a new start.
  if (!state.startLL || state.endLL) {
    state.startLL = ll;
    state.endLL = null;
    state.start = state.graph && inBbox(ll, state.bbox) ? nearestNode(state.graph, lat, lon) : -1;
    state.end = -1;
    state.results.clear();
    renderResults();
    clearSearch();
    updateButtons();
    setStatus('Start set. Now click the goal.');
    return;
  }

  if (!inBbox(state.startLL, state.map.bounds())) {
    setStatus('Keep the start on screen when you pick the goal.', 'warn');
    return;
  }

  state.endLL = ll;
  drawTop();
  if (!await buildFromView()) {
    state.endLL = null;
    drawTop();
    return;
  }

  state.results.clear();
  renderResults();
  updateButtons();
  if (ready()) startRun($('algo').value);
  else setStatus('No roads near one of those points. Try clicking closer to a street.', 'warn');
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

function applyTheme(next, { updateMap = true } = {}) {
  theme = next;
  C = PALETTES[theme];
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll('[data-theme-btn]').forEach((b) => b.classList.toggle('on', b.dataset.themeBtn === theme));
  try { localStorage.setItem(THEME_KEY, theme); } catch (_) {}
  if (updateMap && state.map) state.map.setTheme(theme);
  redrawAll();
}

async function searchPlace(query) {
  setStatus(`Searching for “${query}”…`);
  // Bias results toward what's on screen so "Main St" finds the local one.
  const b = state.map.bounds();
  const params = new URLSearchParams({ format: 'jsonv2', limit: '1', q: query, viewbox: `${b.w},${b.n},${b.e},${b.s}` });
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
    if (!res.ok) throw new Error(res.status);
    const [hit] = await res.json();
    if (!hit) { setStatus(`Couldn't find “${query}”.`, 'warn'); return; }
    state.map.flyTo(+hit.lat, +hit.lon, 15);
    setStatus(`${hit.display_name.split(',').slice(0, 2).join(',')}. Click a start, then a goal.`);
  } catch (err) {
    setStatus(`Search failed (${err.message}).`, 'error');
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
    setStatus('Cleared. Click anywhere for a start.');
  });
  $('oneway').addEventListener('change', () => {
    if (!state.ways) return;
    rebuildGraph();
    if (ready()) startRun($('algo').value);
  });
  $('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('search-input').value.trim();
    if (q) searchPlace(q);
  });
  document.querySelectorAll('[data-theme-btn]').forEach((b) => {
    b.addEventListener('click', () => applyTheme(b.dataset.themeBtn));
  });

  updateButtons();
}

function init() {
  applyTheme(theme, { updateMap: false });
  initControls();
  state.map = createMap($('map'), DEFAULT_VIEW, theme);
  state.map.onClick(handleClick);
  state.map.onView(redrawAll);
  state.map.onMoveEnd(scheduleRefresh);
  new ResizeObserver(resizeCanvases).observe($('map-wrap'));
  resizeCanvases();
  loadDemo();
}

init();

import { RoadGraph, BudgetError, pathLength, mercator, MAX_TILES } from './graph.js';
import { Z, EXTENT } from './tiles.js';
import { ALGORITHMS } from './algorithms.js';
import { createMap } from './maps.js';

// Default view: UVA Grounds to the Downtown Mall, Charlottesville.
const DEFAULT_VIEW = { lat: 38.0335, lon: -78.4925, zoom: 14.6 };
const DEMO = { start: [38.0356, -78.5034], end: [38.0302, -78.4801] };
const SPEEDS = [1, 2, 4, 8, 16, 32, 64, 128, 512, 4096]; // nodes settled per frame
const THEME_KEY = 'mapPathfinder.theme';

// Keep in sync with the --c-* variables in style.css.
const PALETTES = {
  dark: {
    road: 'rgba(255, 255, 255, 0.09)',
    explored: ['rgba(56, 189, 248, 0.85)', 'rgba(232, 121, 249, 0.85)'],
    path: '#ffb020',
    casing: 'rgba(8, 10, 16, 0.9)',
    glow: 'rgba(255, 176, 32, 0.7)',
    start: '#22c55e',
    end: '#f43f5e',
  },
  light: {
    road: 'rgba(60, 64, 67, 0.2)',
    explored: ['rgba(26, 115, 232, 0.8)', 'rgba(147, 52, 230, 0.8)'],
    path: '#ff6d00',
    casing: '#ffffff',
    glow: 'rgba(255, 109, 0, 0.35)',
    start: '#188038',
    end: '#d93025',
  },
};

const $ = (id) => document.getElementById(id);
const graph = new RoadGraph();

const state = {
  map: null,
  startLL: null,
  endLL: null,
  start: -1,
  end: -1,
  startPromise: null,
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

let theme = loadTheme();
let C = PALETTES[theme];
let clickToken = 0;
let compareToken = 0;

function loadTheme() {
  try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch (_) { return 'dark'; }
}

// --- Canvas layers ----------------------------------------------------------

const cvExplored = $('layer-explored');
const cvTop = $('layer-top');
const ctxE = cvExplored.getContext('2d');
const ctxT = cvTop.getContext('2d');
let view = { k: 1, ox: 0, oy: 0 };
let dpr = 1;

function resizeCanvases() {
  dpr = window.devicePixelRatio || 1;
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

const px = (i) => graph.wx[i] * view.k + view.ox;
const py = (i) => graph.wy[i] * view.k + view.oy;

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

// Loaded roads, one cached Path2D per tile drawn with that tile's transform.
function drawRoads() {
  const w = cvExplored.clientWidth;
  const h = cvExplored.clientHeight;
  const tileWorld = 1 / 2 ** Z;
  const scale = (view.k * tileWorld) / EXTENT; // px per tile unit
  ctxE.save();
  ctxE.strokeStyle = C.road;
  ctxE.lineWidth = 1 / scale;
  for (const t of graph.tiles.values()) {
    if (!t.ready || !t.path) continue;
    const x = t.tx * tileWorld * view.k + view.ox;
    const y = t.ty * tileWorld * view.k + view.oy;
    const size = tileWorld * view.k;
    if (x > w || y > h || x + size < 0 || y + size < 0) continue;
    ctxE.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * x, dpr * y);
    ctxE.stroke(t.path);
  }
  ctxE.restore();
}

function redrawExplored() {
  ctxE.clearRect(0, 0, cvExplored.clientWidth, cvExplored.clientHeight);
  drawRoads();
  drawExploredRange(0, state.exFrom.length);
}

function drawMarker(node, ll, color) {
  if (!ll) return;
  const p = node >= 0 ? { x: px(node), y: py(node) } : llPx(ll);
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
  if (path && path.length > 1) {
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

graph.onTile = () => redrawAll();

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
  return state.start >= 0 && state.end >= 0;
}

function startRun(key) {
  if (!ready()) return;
  compareToken++;
  clearSearch();
  const algo = ALGORITHMS[key];
  state.run = { key, gen: algo.run(graph, state.start, state.end), visited: 0, waiting: false, t0: performance.now() };
  state.shownKey = key;
  renderResults();
  state.raf = requestAnimationFrame(frame);
}

function liveText(run) {
  return `Visited ${run.visited.toLocaleString()} nodes · ${graph.tileCount} map tiles loaded`;
}

function frame() {
  const run = state.run;
  if (run && !run.waiting) {
    const steps = SPEEDS[$('speed').value - 1];
    const i0 = state.exFrom.length;
    for (let i = 0; i < steps; i++) {
      const res = run.gen.next();
      if (res.done) { finishRun(run, res.value); break; }
      const e = res.value;
      if (e.need !== undefined) {
        // The frontier reached roads that haven't loaded yet: fetch them, then carry on.
        run.waiting = true;
        graph.ensure(e.need).then(
          () => { if (state.run === run) run.waiting = false; },
          (err) => { if (state.run === run) failRun(run, err); },
        );
        break;
      }
      run.visited++;
      if (e.from >= 0) {
        state.exFrom.push(e.from);
        state.exTo.push(e.to);
        state.exSide.push(e.side);
      }
    }
    drawExploredRange(i0, state.exFrom.length);
    if (state.run === run) {
      setStatus(`Running ${ALGORITHMS[run.key].name}${run.waiting ? ', loading roads…' : '…'}`);
      $('live').textContent = liveText(run);
    }
  }

  if (state.path && state.pathT < 1) state.pathT = Math.min(1, state.pathT + 1 / 40);
  drawTop();

  if (state.run || (state.path && state.pathT < 1)) state.raf = requestAnimationFrame(frame);
}

function failRun(run, err) {
  state.run = null;
  const algo = ALGORITHMS[run.key];
  if (err instanceof BudgetError) {
    setStatus(`${algo.name} needed more than ${MAX_TILES} map tiles of roads. Try A* or Bidirectional Dijkstra for a trip this long.`, 'warn');
  } else {
    setStatus(`Couldn't load roads: ${err.message}`, 'error');
  }
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
  $('live').textContent = `Visited ${run.visited.toLocaleString()} nodes · ${path.length.toLocaleString()} on the path · ${graph.tileCount} map tiles`;
}

// Re-runs an algorithm off-screen, once its roads are loaded, for honest timings.
function measure(key) {
  const gen = ALGORITHMS[key].run(graph, state.start, state.end);
  const t0 = performance.now();
  let visited = 0;
  let res;
  while (!(res = gen.next()).done) {
    if (res.value.need !== undefined) return { visited, ms: null, path: null, length: null, incomplete: true };
    visited++;
  }
  const ms = performance.now() - t0;
  const path = res.value;
  return { visited, ms, path, length: path ? pathLength(graph, path) : null };
}

// Runs a search to the end without animating, loading roads as it needs them.
async function runToEnd(key, token) {
  const gen = ALGORITHMS[key].run(graph, state.start, state.end);
  let steps = 0;
  for (;;) {
    const res = gen.next();
    if (res.done) return res.value;
    if (res.value.need !== undefined) {
      await graph.ensure(res.value.need);
      if (token !== compareToken) throw new Error('cancelled');
    } else if (++steps % 20000 === 0) {
      await new Promise((r) => setTimeout(r)); // keep the page responsive
      if (token !== compareToken) throw new Error('cancelled');
    }
  }
}

async function compareAll() {
  if (!ready()) return;
  clearSearch();
  const token = ++compareToken;
  state.results.clear();
  state.shownKey = null;
  renderResults();
  for (const [key, algo] of Object.entries(ALGORITHMS)) {
    setStatus(`Comparing: ${algo.name}…`);
    try {
      await runToEnd(key, token);
      state.results.set(key, measure(key));
    } catch (err) {
      if (token !== compareToken) return;
      state.results.set(key, { visited: null, ms: null, length: null, overBudget: err instanceof BudgetError });
    }
    if (token !== compareToken) return;
    renderResults();
  }
  setStatus('Compared every algorithm. Click a row to replay it.');
}

// --- Picking points -------------------------------------------------------------

async function snap(lat, lon) {
  try { return await graph.nearest(lat, lon); } catch (_) { return -1; }
}

function setStart(lat, lon) {
  stopRun();
  compareToken++;
  const token = ++clickToken;
  state.startLL = [lat, lon];
  state.endLL = null;
  state.start = -1;
  state.end = -1;
  state.results.clear();
  renderResults();
  clearSearch();
  updateButtons();
  setStatus('Finding the nearest road…');
  state.startPromise = snap(lat, lon).then((node) => {
    if (token !== clickToken) return -1;
    if (node < 0) {
      state.startLL = null;
      setStatus('No road near there. Try another spot.', 'warn');
    } else {
      state.start = node;
      setStatus('Start set. Now click a goal, anywhere: pan, zoom or search to get there.');
    }
    drawTop();
    return node;
  });
}

async function setGoal(lat, lon) {
  const token = ++clickToken;
  state.endLL = [lat, lon];
  drawTop();
  setStatus('Finding the nearest road…');
  const [startNode, node] = await Promise.all([state.startPromise, snap(lat, lon)]);
  if (token !== clickToken) return;
  if (startNode < 0 || node < 0) {
    state.endLL = null;
    setStatus('No road near there. Try another spot.', 'warn');
    drawTop();
    return;
  }
  state.start = startNode;
  state.end = node;
  updateButtons();
  fitRoute();
  startRun($('algo').value);
}

function handleClick(lat, lon) {
  if (!state.startLL || state.endLL) setStart(lat, lon);
  else setGoal(lat, lon);
}

// Frame both points, leaving room for the panel on wide screens.
function fitRoute() {
  const wide = window.innerWidth > 640;
  state.map.fitBounds([state.startLL, state.endLL], {
    top: 70,
    bottom: wide ? 70 : window.innerHeight * 0.5,
    left: wide ? 400 : 40,
    right: 70,
  });
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
    const visited = r.visited == null ? '–' : r.visited.toLocaleString();
    const length = r.overBudget ? '<span class="tag worse">too far</span>' : `${fmtKm(r.length)}${tag}`;
    const ms = r.ms == null ? '–' : `${r.ms < 10 ? r.ms.toFixed(1) : Math.round(r.ms)} ms`;

    tr.innerHTML = `<td>${ALGORITHMS[key].name}</td><td>${visited}</td><td>${length}</td><td>${ms}</td>`;
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
  const params = new URLSearchParams({ format: 'jsonv2', limit: '5', q: query });
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
    if (!res.ok) throw new Error(res.status);
    const hits = await res.json();
    // Prefer towns, cities and regions over businesses that share the name.
    const hit = hits.find((h) => h.category === 'place' || h.category === 'boundary') || hits[0];
    if (!hit) { setStatus(`Couldn't find “${query}”.`, 'warn'); return; }
    state.map.flyTo(+hit.lat, +hit.lon, 14);
    const where = hit.display_name.split(',').slice(0, 2).join(',');
    setStatus(state.startLL && !state.endLL ? `${where}. Click the goal.` : `${where}. Click a start, then a goal.`);
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
    clickToken++;
    compareToken++;
    state.start = state.end = -1;
    state.startLL = state.endLL = null;
    state.results.clear();
    renderResults();
    clearSearch();
    updateButtons();
    setStatus('Cleared. Click anywhere for a start.');
  });
  $('oneway').addEventListener('change', async () => {
    stopRun();
    compareToken++;
    graph.respectOneway = $('oneway').checked;
    graph.rebuild();
    // Node ids changed; snap the points again on the rebuilt graph.
    if (state.startLL) state.start = await snap(...state.startLL);
    if (state.endLL) state.end = await snap(...state.endLL);
    state.results.clear();
    renderResults();
    clearSearch();
    updateButtons();
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

async function loadDemo() {
  setStart(...DEMO.start);
  await state.startPromise;
  if (state.startLL && !state.endLL) setGoal(...DEMO.end);
}

function init() {
  applyTheme(theme, { updateMap: false });
  initControls();
  state.map = createMap($('map'), DEFAULT_VIEW, theme);
  state.map.onClick(handleClick);
  state.map.onView(redrawAll);
  new ResizeObserver(resizeCanvases).observe($('map-wrap'));
  resizeCanvases();
  loadDemo();
}

init();

// Each algorithm is a generator over a graph that grows while it runs:
//   { need: node }        pause until the tiles around `node` have loaded
//   { from, to, side }    a node was settled (for animating the search)
// and it returns the path as an array of node indices, or null.
// State lives in plain arrays because the graph keeps gaining nodes mid-search.
import { MinHeap } from './heap.js';
import { haversine } from './graph.js';

const INF = Infinity;

function trace(prev, t) {
  const path = [];
  for (let v = t; v !== undefined && v !== -1; v = prev[v]) path.push(v);
  return path.reverse();
}

const straightLine = (g, v, t) => haversine(g.lat[v], g.lon[v], g.lat[t], g.lon[t]);

// A node's edges are complete only once every tile it touches has loaded.
function* loaded(g, u) {
  while (!g.ready(u)) yield { need: u };
}

// Shared engine for Dijkstra, A*, and greedy best-first: they differ only in
// how a node's priority is computed.
function* bestFirst(g, s, t, mode) {
  const dist = [];
  const prev = [];
  const done = [];
  const heap = new MinHeap();
  dist[s] = 0;
  prev[s] = -1;
  heap.push(s, mode === 'dijkstra' ? 0 : straightLine(g, s, t));

  while (heap.size) {
    const u = heap.pop();
    if (done[u]) continue;
    yield* loaded(g, u);
    done[u] = 1;
    yield { from: prev[u], to: u, side: 0 };
    if (u === t) return trace(prev, t);

    for (const [v, w] of g.adj[u]) {
      if (done[v]) continue;
      const nd = dist[u] + w;
      if (mode === 'greedy') {
        if (dist[v] === undefined) {
          dist[v] = nd;
          prev[v] = u;
          heap.push(v, straightLine(g, v, t));
        }
      } else if (nd < (dist[v] ?? INF)) {
        dist[v] = nd;
        prev[v] = u;
        heap.push(v, mode === 'astar' ? nd + straightLine(g, v, t) : nd);
      }
    }
  }
  return null;
}

function* bidirectional(g, s, t) {
  if (s === t) { yield { from: -1, to: s, side: 0 }; return [s]; }
  const dist = [[], []];
  const prev = [[], []];
  const done = [[], []];
  const heaps = [new MinHeap(), new MinHeap()];
  const adjs = [g.adj, g.radj]; // the backward search walks edges in reverse
  dist[0][s] = 0;
  dist[1][t] = 0;
  prev[0][s] = -1;
  prev[1][t] = -1;
  heaps[0].push(s, 0);
  heaps[1].push(t, 0);

  let best = INF;
  let meet = -1;

  while (heaps[0].size && heaps[1].size) {
    // Stop once neither frontier can lead to anything shorter than the best meeting.
    if (heaps[0].peekPri() + heaps[1].peekPri() >= best) break;
    const side = heaps[0].peekPri() <= heaps[1].peekPri() ? 0 : 1;
    const u = heaps[side].pop();
    if (done[side][u]) continue;
    yield* loaded(g, u);
    done[side][u] = 1;
    yield { from: prev[side][u], to: u, side };

    const d = dist[side];
    const other = dist[1 - side];
    for (const [v, w] of adjs[side][u]) {
      const nd = d[u] + w;
      if (nd < (d[v] ?? INF)) {
        d[v] = nd;
        prev[side][v] = u;
        heaps[side].push(v, nd);
      }
      const total = d[v] + (other[v] ?? INF);
      if (total < best) {
        best = total;
        meet = v;
      }
    }
  }

  if (meet < 0) return null;
  const path = trace(prev[0], meet);
  for (let v = prev[1][meet]; v !== undefined && v !== -1; v = prev[1][v]) path.push(v);
  return path;
}

function* bfs(g, s, t) {
  const prev = [];
  const seen = [];
  const queue = [s];
  seen[s] = 1;
  prev[s] = -1;

  for (let head = 0; head < queue.length; head++) {
    const u = queue[head];
    yield* loaded(g, u);
    yield { from: prev[u], to: u, side: 0 };
    if (u === t) return trace(prev, t);
    for (const [v] of g.adj[u]) {
      if (!seen[v]) {
        seen[v] = 1;
        prev[v] = u;
        queue.push(v);
      }
    }
  }
  return null;
}

function* dfs(g, s, t) {
  const prev = [];
  const done = [];
  const stack = [s, -1]; // flat pairs of (node, parent)

  while (stack.length) {
    const p = stack.pop();
    const u = stack.pop();
    if (done[u]) continue;
    yield* loaded(g, u);
    done[u] = 1;
    prev[u] = p;
    yield { from: p, to: u, side: 0 };
    if (u === t) return trace(prev, t);
    const nb = g.adj[u];
    for (let i = nb.length - 1; i >= 0; i--) {
      if (!done[nb[i][0]]) stack.push(nb[i][0], u);
    }
  }
  return null;
}

export const ALGORITHMS = {
  astar: {
    name: 'A*',
    desc: 'Dijkstra steered by straight-line distance to the goal. Shortest path, far fewer nodes.',
    run: (g, s, t) => bestFirst(g, s, t, 'astar'),
  },
  dijkstra: {
    name: 'Dijkstra',
    desc: 'Grows outward by road distance in every direction. Always finds the shortest path.',
    run: (g, s, t) => bestFirst(g, s, t, 'dijkstra'),
  },
  bidirectional: {
    name: 'Bidirectional Dijkstra',
    desc: 'Two Dijkstra searches, one from each end, stopping where they meet. Shortest path.',
    run: bidirectional,
  },
  greedy: {
    name: 'Greedy best-first',
    desc: 'Always expands whatever looks closest to the goal. Very fast, but the path can be long.',
    run: (g, s, t) => bestFirst(g, s, t, 'greedy'),
  },
  bfs: {
    name: 'Breadth-first search',
    desc: 'Expands by number of road segments and ignores length. Fewest hops, not fewest meters.',
    run: bfs,
  },
  dfs: {
    name: 'Depth-first search',
    desc: 'Follows one road as far as it goes before backtracking. Finds a path, rarely a good one.',
    run: dfs,
  },
};

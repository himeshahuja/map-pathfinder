// Each algorithm is a generator over a graph that grows while it runs:
//   { need: node }        pause until the tiles around `node` have loaded
//   { from, to, side }    a node was settled (for animating the search)
// and it returns the path as an array of node indices, or null.
// State lives in plain arrays because the graph keeps gaining nodes mid-search.
import { MinHeap } from './heap.js';
import { haversine } from './graph.js';

const INF = Infinity;
const WEIGHT = 1.6; // weighted A* trusts the straight-line estimate this much more

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
  const weight = mode === 'weighted' ? WEIGHT : 1;
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
        heap.push(v, mode === 'dijkstra' ? nd : nd + weight * straightLine(g, v, t));
      }
    }
  }
  return null;
}

// Joins the two halves of a bidirectional search at the meeting node.
function joinAt(prevF, prevB, meet) {
  const path = trace(prevF, meet);
  for (let v = prevB[meet]; v !== undefined && v !== -1; v = prevB[v]) path.push(v);
  return path;
}

// Bidirectional A* with the average potential p(v) = (h(v,t) - h(s,v)) / 2:
// forward keys are d + p, backward keys d - p, and the search may stop once the
// two smallest keys add up to the best path found. Still optimal.
function* bidirectionalAstar(g, s, t) {
  if (s === t) { yield { from: -1, to: s, side: 0 }; return [s]; }
  const p = (v) => (straightLine(g, v, t) - haversine(g.lat[s], g.lon[s], g.lat[v], g.lon[v])) / 2;
  const dist = [[], []];
  const prev = [[], []];
  const done = [[], []];
  const heaps = [new MinHeap(), new MinHeap()];
  const adjs = [g.adj, g.radj];
  dist[0][s] = 0;
  dist[1][t] = 0;
  prev[0][s] = -1;
  prev[1][t] = -1;
  heaps[0].push(s, p(s));
  heaps[1].push(t, -p(t));

  let best = INF;
  let meet = -1;

  while (heaps[0].size && heaps[1].size) {
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
        heaps[side].push(v, side === 0 ? nd + p(v) : nd - p(v));
      }
      const total = d[v] + (other[v] ?? INF);
      if (total < best) {
        best = total;
        meet = v;
      }
    }
  }
  return meet < 0 ? null : joinAt(prev[0], prev[1], meet);
}

// Breadth-first from both ends, always growing the smaller frontier.
function* bidirectionalBfs(g, s, t) {
  if (s === t) { yield { from: -1, to: s, side: 0 }; return [s]; }
  const prev = [[], []];
  const seen = [[], []];
  const queues = [[s], [t]];
  const heads = [0, 0];
  const adjs = [g.adj, g.radj];
  seen[0][s] = 1;
  seen[1][t] = 1;
  prev[0][s] = -1;
  prev[1][t] = -1;

  while (heads[0] < queues[0].length && heads[1] < queues[1].length) {
    const side = queues[0].length - heads[0] <= queues[1].length - heads[1] ? 0 : 1;
    const u = queues[side][heads[side]++];
    yield* loaded(g, u);
    yield { from: prev[side][u], to: u, side };
    for (const [v] of adjs[side][u]) {
      if (seen[side][v]) continue;
      seen[side][v] = 1;
      prev[side][v] = u;
      queues[side].push(v);
      if (seen[1 - side][v]) return joinAt(prev[0], prev[1], v);
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
  return joinAt(prev[0], prev[1], meet);
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
  bidirectionalAstar: {
    name: 'Bidirectional A*',
    desc: 'A* from both ends at once, balanced so the two searches meet on the shortest path.',
    run: bidirectionalAstar,
  },
  weighted: {
    name: 'Weighted A*',
    desc: `A* that trusts the straight-line estimate ${WEIGHT}× more. Explores far less, for a route that can be a little longer.`,
    run: (g, s, t) => bestFirst(g, s, t, 'weighted'),
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
  bidirectionalBfs: {
    name: 'Bidirectional BFS',
    desc: 'Breadth-first search from both ends, meeting in the middle. Fewest hops, found faster.',
    run: bidirectionalBfs,
  },
  dfs: {
    name: 'Depth-first search',
    desc: 'Follows one road as far as it goes before backtracking. Finds a path, rarely a good one.',
    run: dfs,
  },
};

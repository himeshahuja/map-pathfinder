# Map Pathfinder

Watch search algorithms race across real road networks.

**Live demo:** https://meshhi13.github.io/map-pathfinder/

![Bidirectional Dijkstra from UVA to the Downtown Mall](docs/screenshot.jpg)

## How to use

- Pan to anywhere in the world, zoom to street level, and press **Load roads in view**. This pulls the road network from OpenStreetMap.
- Click the map once to set the start and again to set the goal. The selected algorithm runs as soon as both are set.
- **Compare all** runs every algorithm and lists nodes visited, path length (with how far each is over the shortest), and compute time. Click a row to replay that algorithm.
- Toggle **Respect one-way streets** to search with or without real traffic direction.

## Algorithms

| Algorithm | Optimal? | Idea |
| --- | --- | --- |
| A* | yes | Dijkstra guided by straight-line distance to the goal |
| Dijkstra | yes | Expands outward by road distance in every direction |
| Bidirectional Dijkstra | yes | Searches from both ends and stops where they meet |
| Greedy best-first | no | Always heads for whatever looks closest to the goal |
| Breadth-first search | no | Fewest road segments, ignores length |
| Depth-first search | no | Follows one road as far as it goes, then backtracks |

## How it works

- **Road data:** the [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) returns every drivable `highway` way in the current view. Requests are hedged across several public mirrors and the first one to answer wins.
- **Graph:** every OSM node on a road becomes a vertex, and each segment becomes an edge weighted by its haversine length. One-way, reverse one-way, and roundabout tags set edge direction. Clicks snap to the largest connected component.
- **Algorithms** (`js/algorithms.js`) are generators that yield each node as it is settled, so the UI can animate any of them step by step.
- **Rendering:** everything is drawn on canvas layers over Leaflet. Nodes are pre-projected to Web Mercator, so panning redraws thousands of segments without per-node map API calls.

No build step and no dependencies beyond Leaflet from a CDN. To run locally:

```sh
python3 -m http.server 8000
```

Map data © OpenStreetMap contributors.

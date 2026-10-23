<img src="logo.svg" alt="" width="72">

# Map Pathfinder

Watch search algorithms race across real road networks.

**Live demo:** https://himeshahuja.github.io/map-pathfinder/

![Dijkstra exploring downtown Richmond](docs/screenshot.jpg)

## How to use

- Click a start anywhere, then a goal anywhere. Pan, zoom or **jump to a place** in between, so the two points can be cities apart.
- The route runs immediately. Road data streams in while the search runs, loaded only where its frontier reaches.
- **Compare all** runs every algorithm and lists nodes visited, path length (with how far each is over the shortest), and compute time. Click a row to replay that algorithm.
- Toggle **Respect one-way streets** to search with or without real traffic direction, and switch between dark and light maps.

## Algorithms

| Algorithm | Optimal? | Idea |
| --- | --- | --- |
| A* | yes | Dijkstra guided by straight-line distance to the goal |
| Bidirectional A* | yes | A* from both ends, balanced with averaged straight-line estimates so the meeting point is on the shortest path |
| Weighted A* | no | A* that trusts the estimate 1.6× more: far fewer nodes, slightly longer routes |
| Dijkstra | yes | Expands outward by road distance in every direction |
| Bidirectional Dijkstra | yes | Searches from both ends and stops where they meet |
| Greedy best-first | no | Always heads for whatever looks closest to the goal |
| Breadth-first search | no | Fewest road segments, ignores length |
| Bidirectional BFS | no | Breadth-first from both ends, meeting in the middle |
| Depth-first search | no | Follows one road as far as it goes, then backtracks |

## How it works

- **Road data on demand:** the app fetches [OpenFreeMap](https://openfreemap.org/) vector tiles (OpenMapTiles schema, zoom 14) itself and decodes their road geometry with a small built-in protobuf reader (`js/tiles.js`). Before expanding a node, the search makes sure the tiles around it have loaded. Roads are therefore only fetched where the frontier goes, and long trips need no up-front download.
- **Building the graph:** each road is clipped exactly to its tile, and vertices within about 1 m are merged, so neighbouring tiles join up. The tiles simplify roads, which can drop the shared vertex where a side street meets a straight road. Any road end lying on another road is therefore joined to it by splitting that road there. One-way flags set edge direction. Clicks snap to the nearest street, preferring real streets over parking-lot service roads.
- **Algorithms** (`js/algorithms.js`) are generators that yield each node as it is settled, and pause with a "need these tiles" signal when the frontier reaches unloaded roads. The UI animates any of them step by step.
- **Rendering:** the basemap is [MapLibre](https://maplibre.org/). Loaded roads are drawn from one cached `Path2D` per tile; the search and route sit on canvas layers above it.

No build step and no dependencies beyond MapLibre GL from a CDN. To run locally:

```sh
python3 -m http.server 8000
```

Map data © OpenStreetMap contributors.

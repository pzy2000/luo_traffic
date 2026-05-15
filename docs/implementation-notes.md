# Minhang Traffic Worktree Implementation Notes

This document records the current implementation in this worktree: data pipeline, route graph construction, debug tooling, rendering strategy, and vehicle simulation behavior.

For the current high-quality OSM topology rebuild, full implementation details and statistics are recorded in `docs/topology-quality-implementation.md`.

## Current Entry Points

- `index.html`: the formal traffic visualization page.
- `traffic-debug.html`: road-network and routing debug page for inspecting graph connectivity, dead ends, repairs, and vehicle behavior without the full presentation effects.
- `traffic-debug-fast.html`: lightweight debug variant.
- `data/app-data.js`: generated map and presentation data used by the formal page.
- `data/route-graph.js`: precomputed routable graph used by the browser.
- `js/traffic-graph.js`: browser-side helpers for graph creation and route library loading.
- `tools/*.mjs`: local rebuild, diagnosis, and precompute scripts.

## Local Running

The project is designed to run from a local static server:

```powershell
npm run serve
```

Then open:

```text
http://127.0.0.1:5500/index.html
http://127.0.0.1:5500/traffic-debug.html
```

The current worktree already uses local generated data files, so the formal page does not need a live Overpass request at runtime.

## Data Pipeline

The project moved from embedding Overpass geometry directly in `index.html` to a local generated data pipeline.

Current source:

- Geofabrik Shanghai OSM PBF.
- Minhang boundary relation: `1278189`.
- Road extraction clipped to the Minhang boundary.
- Generated presentation data in `data/app-data.js`.
- Generated route topology in `data/route-graph.js`.

Important scripts:

- `tools/rebuild-geofabrik-data.mjs`: downloads/scans Shanghai PBF and extracts Minhang roads/boundary.
- `tools/rebuild-gdal-data.mjs`: uses GDAL/OGR-style extraction when available.
- `tools/precompute-osm-route-graph.mjs`: builds the persisted OSM node-ref routing graph.
- `tools/diagnose-road-gaps.mjs`: helps inspect road gaps and repair candidates.

Typical rebuild flow:

```powershell
npm run rebuild:geofabrik
npm run rebuild:gdal
npm run precompute:graph
```

The current route graph is based on OSM node references rather than only visual line geometry. This matters because drawn road lines can appear visually close while still being separate routable topology, and conversely short repair connectors can make topology connected even when the visual line has a tiny break.

## Road And Routing Model

The browser keeps two related but separate concepts:

- Visual road geometry: the road polylines drawn on the canvas.
- Route graph topology: directed edge/node graph used by vehicles.

Vehicles follow route-graph edges, while the map draws the road geometries. The precomputed graph contains:

- real OSM-derived directed edges;
- one-way handling;
- road rank and highway class;
- connected-component metadata;
- dead-end metadata;
- generated repair connectors for small topology gaps.

The implementation intentionally avoids building all routing decisions in the browser from raw road features. Expensive topology work is precomputed and persisted in `data/route-graph.js`.

## Road Repair Philosophy

Earlier repair attempts connected too many visually nearby endpoints. That caused bad short connectors, especially between parallel carriageways or opposite directions.

The current direction is conservative:

- prefer real OSM node-ref topology;
- keep repair connectors short;
- restrict synthetic connectors by road rank, angle, distance, and kind;
- avoid broad geometric snapping that connects nearby but semantically different roads;
- use debug pages to inspect where a visible break is a data/topology issue versus a drawing perception issue.

Known issue: the graph still has many components and dead-end nodes. Some of these are real access roads, private roads, parking aisles, clipped boundary fragments, or OSM tagging artifacts. Others may still be fixable with better preprocessing.

## Formal Page Rendering

`index.html` renders a full dashboard:

- static map canvas;
- chain/district panels;
- live vehicle particles;
- transfer beams;
- hover tooltip;
- status and metric panels.

Performance strategy:

- static map content is prerendered into an offscreen canvas;
- each animation frame draws the static canvas plus dynamic overlays;
- vehicle count is currently capped at 64;
- vehicle glow radius was reduced to keep the scene cleaner;
- the road data and graph are loaded from local generated JS files.

## Vehicle Strategy Types

Each vehicle receives one of three strategies:

- `through`: high-rank north/south through traffic, biased to boundary/highway edges.
- `arterial`: main-road traffic, biased to rank 6+ roads.
- `local`: shorter trips, allowed to spend more time on side roads.

The strategy affects:

- initial spawn edge;
- route target distance;
- route target rank preference;
- straight-continuation probability;
- probability of staying on high-rank roads;
- whether boundary exit fading is allowed proactively.

## Vehicle State

Important state fields:

- `currentEdge`: the directed graph edge currently being traversed.
- `edgeProgress`: distance along the current edge.
- `previousNode` / `previousEdgeId`: routing context.
- `recentEdges` / `recentNodes`: loop detection and anti-repeat history.
- `plannedEdges`: route-plan queue.
- `strategy`: `through`, `arterial`, or `local`.
- `throughGoal`: northbound or southbound target direction for through vehicles.
- `speed`: current frame speed.
- `vanish`: active disappearance animation, either `exit` or `park`.
- `retireIntent`: desire to leave the simulation naturally.
- `mainRoadDistanceRemaining`: remaining high-rank road dwell budget.
- `samples`: recent motion samples for loop detection.

## Movement Loop

Each frame:

1. Skip normal movement if the vehicle is already vanishing.
2. Compute cruise speed from highway class and vehicle personality.
3. Apply turn slowdown, incidental slowdown, and stop-at-intersection state.
4. Advance along the current edge.
5. At an edge end, choose a next edge.
6. Update route history, loop samples, district transitions, and transfer effects.
7. If appropriate, trigger boundary exit or natural parking fade.

The movement code tries to avoid tiny local loops by using:

- recent node/edge memory;
- anti-U-turn alignment thresholds;
- straight continuation preference;
- route planning to farther targets;
- loop sample bounding boxes;
- loop-escape mode when a vehicle appears trapped;
- dead-end visual turnaround before any visible retirement animation.

## Route Choice

Route choice combines planned paths and local weighted choice.

Planned path:

- used for non-retiring vehicles when route planning is due;
- targets are chosen by strategy and road rank;
- through vehicles prefer high-rank boundary targets;
- arterial vehicles prefer rank 6+ targets;
- local vehicles can use lower-rank targets.

Local fallback:

- filters hard U-turns;
- prefers routable cruise edges;
- filters dead-end candidates;
- prefers real edges over synthetic ones;
- strongly favors straight continuation;
- weights by road rank, alignment, target progress, recency, and synthetic-connector penalty.

## Main-Road Dwell Model

The latest change adds a high-rank road dwell budget.

`mainRoadDistanceRemaining` is initialized when a vehicle enters or respawns on a main road:

- motorway/rank 9: longest budget;
- trunk/rank 8: long budget;
- primary/rank 7: medium-long budget;
- secondary/rank 6: shorter budget;
- side roads: no main-road budget.

While this budget remains, high-rank vehicles strongly prefer:

- continuing on the same road;
- keeping the same or similar rank;
- straight movement;
- avoiding sudden drops from expressways or primary roads to small residential/service roads.

This addresses the visual problem where cars would enter a main road and almost immediately leave to park or turn repeatedly.

## Dead Ends And Loop Escape

The current formal page avoids instant respawn during normal driving.

When a vehicle reaches a graph dead end:

- high-rank or boundary-side dead ends use a forward exit fade, so the vehicle keeps moving along its current heading while fading out;
- lower-rank interior dead ends try natural parking fade when appropriate;
- if neither is available, the vehicle enters a visible retirement fade instead of instantly respawning;
- the formal page no longer creates temporary visual turnaround edges at dead ends, because those looked like front/back twitching near clipped boundaries.

Loop escape is a temporary routing mode. It records the center of the small area where the vehicle was trapped, clears stale planned routes, and then:

- filters candidates toward edges that move away from the loop center;
- strongly favors rank 6+ roads when available;
- penalizes returning to the same few low-rank roads;
- keeps a short cooldown window so the vehicle does not instantly re-enter the same decision cycle.

## Vanish And Respawn Model

There are now two stages:

- `retireIntent`: the vehicle wants to leave but keeps driving normally.
- `vanish`: the vehicle is actively disappearing.

There are two vanish kinds:

- `exit`: boundary/highway fade. The vehicle keeps its forward motion and continues past the current edge while fading.
- `park`: side-road parking fade. The vehicle decelerates on its current side road, holds visibility briefly, then fades.

Important rule: parking no longer teleports the vehicle to a nearby side road. A vehicle can only park-fade once it is already naturally on a suitable low-rank road.

The previous bad behavior was caused by selecting a nearby side-road edge and directly replacing `vehicle.currentEdge`. That created visible instantaneous jumps. That path has been removed.

## Boundary Exit Fade

Boundary fade is intended for through traffic and retiring vehicles on high-rank roads near the map boundary.

The latest fix restores proactive boundary fading:

- high-rank edge required;
- vehicle must be near a map boundary or, for through traffic, inside the broader boundary approach band;
- vehicle must be moving outward or approaching an edge endpoint near that same boundary;
- spawn grace and a separate minimum trip time prevent newly spawned boundary vehicles from immediately fading.

This is separate from parking fade. A vehicle leaving Minhang on a main road should not look like it parked; it should glide and fade.

## Parking Fade

Parking fade is reserved for lower-rank side roads:

- `residential`;
- `unclassified`;
- `tertiary`;
- `service`.

The animation now:

- starts at the vehicle's actual current position;
- keeps the current edge;
- decelerates based on the current/expected speed;
- holds opacity for the first part of the animation;
- then fades out.

This avoids the earlier snap-to-nearby-road artifact.

## Debug Pages

`traffic-debug.html` is meant for observing route graph problems without full dashboard effects.

It helps inspect:

- connected components;
- dead-end nodes;
- short repair connectors;
- road rank filtering;
- route graph versus visual road geometry;
- vehicle state and movement behavior.

The debug page is useful because many issues are hard to see in the formal page: glow, beams, labels, and dashboard overlays make topology mistakes harder to diagnose.

## Current Known Limitations

- The road graph still has many connected components because real OSM data includes private roads, parking aisles, clipped boundary fragments, and isolated service roads.
- Some visually broken roads may be true OSM topology breaks; others may be artifacts of clipping, line simplification, one-way direction, layer separation, or repair-connector policy.
- Boundary detection currently uses the projected road bounding box, not the exact administrative polygon crossing point.
- The formal page uses a lot of canvas effects; browser screenshots can time out when the in-app browser is busy.
- Chinese text in some generated data appears mojibake in source files, but the core geometry/routing behavior is independent of those labels.

## Current Verification

Recent checks performed in this worktree:

- `index.html` inline script syntax check passes.
- Local HTTP server returns `200` for `http://127.0.0.1:5500/index.html`.
- VM-based simulation ran for 64 vehicles with valid positions.
- Parking vanish appeared only on low-rank side roads in simulation.
- Boundary exit fade has been restored through proactive high-rank boundary checks.

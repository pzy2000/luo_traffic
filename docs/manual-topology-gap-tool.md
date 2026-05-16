# Manual Topology Gap Tool

This project can now repair missing Shanghai PBF road segments that were not included in the current Minhang topology extract. The workflow is intentionally manual: inspect the gap, confirm only the segments that should become real roads, then apply those annotations to the `index.html` data files.

## Current Applied Index

The current committed `index.html` data has manual topology annotations applied:

- `MAP_METADATA.source`: `Strict OSM node-ref topology with manual topology-gap annotations`
- Applied missing road segments: `59`
- Manual endpoint links: `0`
- Total roads in `data/app-data.js`: `14202`
- The applied roads are marked with `supplemental: "manual-topology-gap"`.

The corresponding provenance is stored in:

- `test-results/topology-gap-annotations.json`
- `MAP_METADATA.manualTopology` inside `data/app-data.js`

## Start the Tool

Run this from the repository root:

```powershell
node tools/topology-gap-annotation-server.mjs
```

Then open:

```text
http://127.0.0.1:5510/test-results/topology-gap-debug.html
```

The same server also serves the app:

```text
http://127.0.0.1:5510/index.html
```

## Regenerate the Inspector Data

The inspector uses a large generated JSON file that is not committed because it is over the GitHub single-file limit. Regenerate it when the base map changes:

```powershell
node tools/topology-gap-debug.mjs
```

This writes:

- `test-results/topology-gap-debug.html`
- `test-results/topology-gap-debug.json`

`topology-gap-debug.json` is local-only and ignored by git.

## Manual Repair Workflow

1. Open the topology gap debug page.
2. Dark low-opacity lines are Shanghai PBF road segments not currently in the Minhang index.
3. Click a dark line to make it an inclusion candidate.
4. Click `确认纳入` to add it to `INCLUDE_MISSING`.
5. Repeat until the missing corridor is covered.
6. Click `应用到Index`.
7. Refresh `http://127.0.0.1:5510/index.html`.

Important: `确认纳入` persists in the browser and in the annotation payload, but it does not modify the app by itself. `应用到Index` is the step that writes `data/app-data.js` and rebuilds `data/route-graph.js`.

## Endpoint Repair

Use endpoint repair only when the Shanghai PBF data itself has a real connectivity gap.

1. Switch to `端点修补`.
2. Click the first endpoint.
3. Move to or click the second endpoint to preview a line.
4. Click `确认连接` to add it to `MANUAL_LINKS`.
5. Click `应用到Index` to rebuild the app data.

This project currently has `0` applied manual endpoint links. Prefer including real PBF road segments before adding endpoint links.

## Applying Annotations Without the Browser

If `test-results/topology-gap-annotations.json` already contains the desired annotations, apply them directly:

```powershell
node tools/apply-topology-gap-annotations.mjs
```

You can also pass explicit paths:

```powershell
node tools/apply-topology-gap-annotations.mjs --annotations test-results/topology-gap-annotations.json --debug-json test-results/topology-gap-debug.json
```

This command updates:

- `data/app-data.js`
- `data/route-graph.js`

## What Gets Committed

Commit the source tools, docs, `test-results/topology-gap-annotations.json`, and the rebuilt app data.

Do not commit:

- `test-results/topology-gap-debug.json`
- topology annotation server logs
- local PBF files under `tools/cache/`

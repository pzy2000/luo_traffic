import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const parseOsmPbf = require("osm-pbf-parser");

const DATA_PATH = new URL("../data/app-data.js", import.meta.url);
const GRAPH_LIB_PATH = new URL("../js/traffic-graph.js", import.meta.url);
const OUT_PATH = new URL("../data/route-graph.js", import.meta.url);
const DEFAULT_PBF = new URL("./cache/shanghai-latest.osm.pbf", import.meta.url);
const RELATION_ID = 1278189;
const HIGHWAY_PATTERN = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$/;

const HIGHWAY_RANK = {
  pedestrian: 1,
  service: 1,
  living_street: 2,
  residential: 2,
  unclassified: 3,
  tertiary_link: 4,
  tertiary: 5,
  secondary_link: 5,
  primary_link: 5,
  secondary: 6,
  trunk_link: 6,
  motorway_link: 6,
  primary: 7,
  trunk: 8,
  motorway: 9
};

const WIDTH_BY_RANK = {
  1: 1.15,
  2: 1.8,
  3: 2.4,
  4: 3.1,
  5: 3.8,
  6: 4.8,
  7: 5.8,
  8: 6.6,
  9: 7.4
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode || "full";
  const minRank = Number.parseInt(args.minRank || "5", 10);
  const pbfPath = pathToFileURL(path.resolve(args.pbf || fileURLToPath(DEFAULT_PBF)));
  const profileName = args.profile || "balanced";
  const graphSettings = graphSettingsForProfile(profileName);
  const outPath = pathToFileURL(path.resolve(args.out || fileURLToPath(OUT_PATH)));

  const dataSrc = await fs.readFile(DATA_PATH, "utf8");
  const graphSrc = await fs.readFile(GRAPH_LIB_PATH, "utf8");
  const window = {};
  new Function("window", dataSrc)(window);
  new Function("window", graphSrc)(window);

  console.log("Reading Minhang boundary relation from OSM PBF...");
  const boundaryMemberIds = await readBoundaryMemberIds(pbfPath);
  console.log("Reading OSM nodes, boundary ways, and highway ways...");
  const raw = await readRoadData(pbfPath, boundaryMemberIds, minRank);
  const boundaryRings = buildBoundaryRings(raw.boundaryWays, raw.nodes);
  const boundaryRing = boundaryRings.sort((a, b) => b.length - a.length)[0] || null;
  if (!boundaryRing) throw new Error(`Could not reconstruct boundary relation ${RELATION_ID}`);

  const routeRoads = buildRouteRoads(raw.highwayWays, raw.nodes, window.MAP_METADATA.originalBbox, window.MAP_METADATA.projectedBounds, boundaryRing);
  const appDataForGraph = { roads: routeRoads };
  const started = Date.now();
  const graph = window.TrafficGraph.buildRoadGraph(appDataForGraph, {
    mode,
    ...graphSettings
  });
  const serialized = serializeGraph(graph, {
    mode,
    minRank,
    profileName,
    source: "OSM node-ref topology from Geofabrik Shanghai PBF",
    boundaryRelationId: RELATION_ID,
    routeRoads: routeRoads.length,
    buildMs: Date.now() - started,
    osmTimestamp: raw.osmTimestamp
  });
  await fs.writeFile(outPath, `window.TRAFFIC_ROUTE_GRAPH = ${JSON.stringify(serialized)};\n`, "utf8");
  console.log(JSON.stringify({
    source: serialized.source,
    mode,
    minRank,
    profile: profileName,
    highwayWays: raw.highwayWays.length,
    routeRoads: routeRoads.length,
    nodes: serialized.nodes.length,
    edges: serialized.edges.length,
    components: serialized.componentCount,
    largest: serialized.largestComponentNodeCount,
    connectors: serialized.connectorCount,
    geometryRepairs: serialized.geometryRepairCount,
    buildMs: serialized.buildMs,
    osmTimestamp: serialized.osmTimestamp
  }, null, 2));
}

function graphSettingsForProfile(profile) {
  const profiles = {
    balanced: {
      connectors: true,
      geometryRepairs: true,
      extensionGap: 6,
      midRankExtensionGap: 12,
      highRankExtensionGap: 18,
      junctionGap: 0.45,
      endpointToSegmentGap: 0.75,
      repairMaxNodeDegree: 2,
      repairMinContinuationAlignment: 0.7,
      minHighRankExtensionAlignment: 0.76,
      minMidRankExtensionAlignment: 0.8,
      minLowRankExtensionAlignment: 0.88
    },
    strict: {
      connectors: true,
      geometryRepairs: false,
      extensionGap: 2.2,
      midRankExtensionGap: 7,
      highRankExtensionGap: 14,
      junctionGap: 0.25,
      endpointToSegmentGap: 0,
      repairMaxNodeDegree: 1,
      minHighRankExtensionAlignment: 0.9,
      minMidRankExtensionAlignment: 0.92,
      minLowRankExtensionAlignment: 0.96
    },
    arterial: {
      connectors: true,
      geometryRepairs: false,
      extensionGap: 1.8,
      midRankExtensionGap: 8,
      highRankExtensionGap: 22,
      junctionGap: 0.2,
      endpointToSegmentGap: 0,
      repairMaxNodeDegree: 1,
      minHighRankExtensionAlignment: 0.86,
      minMidRankExtensionAlignment: 0.9,
      minLowRankExtensionAlignment: 0.98
    }
  };
  if (!profiles[profile]) {
    throw new Error(`Unknown profile "${profile}". Expected ${Object.keys(profiles).join(", ")}`);
  }
  return profiles[profile];
}

function readBoundaryMemberIds(fileUrl) {
  return new Promise((resolve, reject) => {
    const memberIds = new Set();
    createReadStream(fileUrl)
      .pipe(parseOsmPbf())
      .on("data", (items) => {
        items.forEach((item) => {
          if (item.type !== "relation" || item.id !== RELATION_ID) return;
          (item.members || []).forEach((member) => {
            if (member.type === "way" && member.role !== "inner") memberIds.add(member.id);
          });
        });
      })
      .on("error", reject)
      .on("end", () => resolve(memberIds));
  });
}

function readRoadData(fileUrl, boundaryMemberIds, minRank) {
  return new Promise((resolve, reject) => {
    const nodes = new Map();
    const highwayWays = [];
    const boundaryWays = [];
    let latestTimestamp = 0;

    createReadStream(fileUrl)
      .pipe(parseOsmPbf())
      .on("data", (items) => {
        items.forEach((item) => {
          if (item.info?.timestamp && item.info.timestamp > latestTimestamp) {
            latestTimestamp = item.info.timestamp;
          }
          if (item.type === "node") {
            nodes.set(item.id, { id: item.id, lat: item.lat, lon: item.lon });
            return;
          }
          if (item.type !== "way") return;
          if (boundaryMemberIds.has(item.id)) {
            boundaryWays.push({ id: item.id, refs: item.refs || [] });
          }
          const highway = item.tags?.highway;
          const rank = HIGHWAY_RANK[highway] || 0;
          if (highway && HIGHWAY_PATTERN.test(highway) && rank >= minRank && item.refs?.length > 1) {
            highwayWays.push({ id: item.id, tags: item.tags || {}, nodes: item.refs });
          }
        });
      })
      .on("error", reject)
      .on("end", () => resolve({
        nodes,
        highwayWays,
        boundaryWays,
        osmTimestamp: latestTimestamp ? new Date(latestTimestamp).toISOString() : null
      }));
  });
}

function buildRouteRoads(ways, nodes, bbox, bounds, boundaryRing) {
  const roads = [];
  ways.forEach((way) => {
    const tags = way.tags || {};
    const highway = tags.highway;
    const rank = HIGHWAY_RANK[highway] || 2;
    let current = null;
    for (let index = 0; index < way.nodes.length - 1; index += 1) {
      const fromId = way.nodes[index];
      const toId = way.nodes[index + 1];
      const from = nodes.get(fromId);
      const to = nodes.get(toId);
      if (!from || !to || !segmentTouchesBoundary(from, to, boundaryRing)) {
        flush();
        continue;
      }
      if (!current) {
        current = { points: [from], nodeIds: [fromId] };
      } else {
        const lastId = current.nodeIds[current.nodeIds.length - 1];
        if (lastId !== fromId) {
          flush();
          current = { points: [from], nodeIds: [fromId] };
        }
      }
      current.points.push(to);
      current.nodeIds.push(toId);
    }
    flush();

    function flush() {
      if (!current || current.points.length < 2) {
        current = null;
        return;
      }
      const projected = current.points.map((point) => projectPoint(point, bbox, bounds));
      const length = polylineLength(projected);
      if (length >= 2.5) {
        roads.push({
          id: `${way.id}:${roads.length}`,
          osmId: way.id,
          name: tags.name || "",
          highway,
          rank,
          width: WIDTH_BY_RANK[rank] || 2,
          length: round(length, 1),
          points: projected.map((point) => [round(point.x, 1), round(point.y, 1)]),
          nodeIds: current.nodeIds,
          oneway: normalizedOneway(tags, highway),
          layer: Number.parseInt(tags.layer || "0", 10) || 0,
          bridge: tags.bridge === "yes",
          tunnel: tags.tunnel === "yes",
          access: tags.access || "",
          service: tags.service || "",
          routable: isRoutable(tags),
          tags: {
            highway,
            name: tags.name || "",
            oneway: tags.oneway,
            layer: tags.layer,
            bridge: tags.bridge,
            tunnel: tags.tunnel
          }
        });
      }
      current = null;
    }
  });
  return roads;
}

function buildBoundaryRings(boundaryWays, nodes) {
  const unused = boundaryWays
    .map((way) => ({ id: way.id, refs: way.refs.filter((ref) => nodes.has(ref)) }))
    .filter((way) => way.refs.length > 1);
  const rings = [];
  while (unused.length) {
    const first = unused.shift();
    let ringRefs = [...first.refs];
    let changed = true;
    while (changed) {
      changed = false;
      for (let index = 0; index < unused.length; index += 1) {
        const candidate = unused[index];
        const ringStart = ringRefs[0];
        const ringEnd = ringRefs[ringRefs.length - 1];
        const candidateStart = candidate.refs[0];
        const candidateEnd = candidate.refs[candidate.refs.length - 1];
        if (ringEnd === candidateStart) ringRefs = ringRefs.concat(candidate.refs.slice(1));
        else if (ringEnd === candidateEnd) ringRefs = ringRefs.concat([...candidate.refs].reverse().slice(1));
        else if (ringStart === candidateEnd) ringRefs = candidate.refs.slice(0, -1).concat(ringRefs);
        else if (ringStart === candidateStart) ringRefs = [...candidate.refs].reverse().slice(0, -1).concat(ringRefs);
        else continue;
        unused.splice(index, 1);
        changed = true;
        break;
      }
    }
    const ring = ringRefs.map((ref) => nodes.get(ref)).filter(Boolean);
    if (ring.length > 2) rings.push(closeRing(ring));
  }
  return rings;
}

function closeRing(points) {
  const first = points[0];
  const last = points[points.length - 1];
  if (first && last && (first.lat !== last.lat || first.lon !== last.lon)) {
    return points.concat([{ lat: first.lat, lon: first.lon }]);
  }
  return points;
}

function segmentTouchesBoundary(start, end, boundaryRing) {
  return pointInPolygon(start, boundaryRing)
    || pointInPolygon(end, boundaryRing)
    || pointInPolygon({ lat: (start.lat + end.lat) / 2, lon: (start.lon + end.lon) / 2 }, boundaryRing);
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lon;
    const yi = polygon[i].lat;
    const xj = polygon[j].lon;
    const yj = polygon[j].lat;
    const intersect = ((yi > point.lat) !== (yj > point.lat))
      && (point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi + Number.EPSILON) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function serializeGraph(graph, metadata) {
  const nodeIds = Array.from(graph.nodes.keys());
  const nodeIndex = new Map(nodeIds.map((id, index) => [id, index]));
  const roadIds = [];
  const roadIndex = new Map();
  const highways = [];
  const highwayIndex = new Map();
  const syntheticKinds = [];
  const syntheticKindIndex = new Map();

  function indexValue(values, lookup, value) {
    const key = value || "";
    if (!lookup.has(key)) {
      lookup.set(key, values.length);
      values.push(key);
    }
    return lookup.get(key);
  }

  return {
    format: "compact-v1",
    topology: "osm-node-refs",
    source: metadata.source,
    mode: metadata.mode,
    minRank: metadata.minRank,
    profileName: metadata.profileName,
    buildMs: metadata.buildMs,
    generatedAt: new Date().toISOString(),
    osmTimestamp: metadata.osmTimestamp,
    boundaryRelationId: metadata.boundaryRelationId,
    routeInputRoadCount: metadata.routeRoads,
    routeRoadCount: graph.routeRoadCount,
    edgeCount: graph.edgeCount,
    prunedNodeCount: graph.prunedNodeCount,
    segmentCount: graph.segmentCount,
    geometryRepairCount: graph.geometryRepairCount || 0,
    connectorCount: graph.connectorCount,
    componentCount: graph.componentCount,
    largestComponentNodeCount: graph.largestComponentNodeCount,
    coreNodeCount: graph.coreNodeCount,
    deadEndBranchNodeCount: graph.deadEndBranchNodeCount,
    deadEndNodeIds: graph.deadEndNodes.map((node) => nodeIndex.get(node.id)).filter((id) => id !== undefined),
    roadIds,
    highways,
    syntheticKinds,
    nodes: nodeIds.map((id) => {
      const node = graph.nodes.get(id);
      return [
        round(node.x, 1),
        round(node.y, 1),
        node.componentId || 0,
        node.componentSize || 0,
        node.isTrafficCore ? 1 : 0,
        node.layer || 0
      ];
    }),
    edges: graph.allEdges.map((edge) => [
      nodeIndex.get(edge.from),
      nodeIndex.get(edge.to),
      indexValue(roadIds, roadIndex, edge.roadId),
      edge.rank || 0,
      indexValue(highways, highwayIndex, edge.highway),
      edge.synthetic ? 1 : 0,
      edge.layer || 0,
      round(edge.length, 2),
      round(edge.points[0][0], 1),
      round(edge.points[0][1], 1),
      round(edge.points[1][0], 1),
      round(edge.points[1][1], 1),
      indexValue(syntheticKinds, syntheticKindIndex, edge.syntheticKind || "")
    ])
  };
}

function projectPoint(point, bbox, bounds) {
  const xRatio = (point.lon - bbox.minlon) / (bbox.maxlon - bbox.minlon);
  const yRatio = (bbox.maxlat - point.lat) / (bbox.maxlat - bbox.minlat);
  return {
    x: bounds.minX + xRatio * (bounds.maxX - bounds.minX),
    y: bounds.minY + yRatio * (bounds.maxY - bounds.minY)
  };
}

function polylineLength(points) {
  let total = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    total += Math.hypot(points[index + 1].x - points[index].x, points[index + 1].y - points[index].y);
  }
  return total;
}

function isRoutable(tags) {
  if (tags.area === "yes") return false;
  if (["no", "private"].includes(tags.access)) return false;
  if (["no", "private"].includes(tags.vehicle)) return false;
  if (["no", "private"].includes(tags.motor_vehicle)) return false;
  if (["no", "private"].includes(tags.motorcar)) return false;
  if (tags.highway === "pedestrian" && tags.motor_vehicle !== "yes" && tags.motorcar !== "yes") return false;
  return true;
}

function normalizedOneway(tags, highway) {
  if (tags.oneway === "-1") return "reverse";
  if (["yes", "true", "1"].includes(tags.oneway) || tags.junction === "roundabout" || highway === "motorway") return "yes";
  return "no";
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--mode") parsed.mode = args[++index];
    else if (args[index] === "--min-rank") parsed.minRank = args[++index];
    else if (args[index] === "--pbf") parsed.pbf = args[++index];
    else if (args[index] === "--profile") parsed.profile = args[++index];
    else if (args[index] === "--out") parsed.out = args[++index];
  }
  return parsed;
}

function fileURLToPath(url) {
  return decodeURIComponent(url.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

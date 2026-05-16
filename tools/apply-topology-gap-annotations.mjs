import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_PATH = new URL("../data/app-data.js", import.meta.url);
const GRAPH_LIB_PATH = new URL("../js/traffic-graph.js", import.meta.url);
const GRAPH_OUT_PATH = new URL("../data/route-graph.js", import.meta.url);
const DEFAULT_DEBUG_JSON = new URL("../test-results/topology-gap-debug.json", import.meta.url);
const DEFAULT_ANNOTATIONS = new URL("../test-results/topology-gap-annotations.json", import.meta.url);

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
  const annotationsPath = path.resolve(args.annotations || fileURLToPath(DEFAULT_ANNOTATIONS));
  const debugJsonPath = path.resolve(args.debugJson || fileURLToPath(DEFAULT_DEBUG_JSON));
  const annotations = JSON.parse(await fs.readFile(annotationsPath, "utf8"));
  const debugData = JSON.parse(await fs.readFile(debugJsonPath, "utf8"));
  const dataSrc = await fs.readFile(DATA_PATH, "utf8");
  const graphSrc = await fs.readFile(GRAPH_LIB_PATH, "utf8");
  const windowData = {};
  const windowGraph = {};
  new Function("window", dataSrc)(windowData);
  new Function("window", graphSrc)(windowGraph);

  const appData = windowData.appData;
  const metadata = windowData.MAP_METADATA;
  if (!appData?.roads || !metadata) throw new Error("Missing appData.roads or MAP_METADATA");
  if (!windowGraph.TrafficGraph?.buildRoadGraph) throw new Error("Missing TrafficGraph.buildRoadGraph");

  const baseRoads = appData.roads.filter((road) => !isManualTopologyRoad(road));
  const referenceRoads = resolveIncludedReferenceRoads(annotations, debugData);
  const manualRoads = [
    ...referenceRoads.map(referenceToRoad),
    ...manualLinksToRoads(annotations.manualLinks || [])
  ];
  const roads = baseRoads.concat(manualRoads)
    .sort((a, b) => a.rank - b.rank || a.length - b.length || String(a.id).localeCompare(String(b.id)));

  const graphStarted = Date.now();
  const graph = windowGraph.TrafficGraph.buildRoadGraph({ roads }, {
    mode: "full",
    connectors: false,
    geometryRepairs: false,
    minSegmentLength: 0.05
  });
  const routeGraph = serializeGraph(graph, {
    mode: "full",
    minRank: metadata.extraction?.minOutputRank || 1,
    source: "Strict OSM node-ref topology with manual topology-gap annotations",
    pbf: debugData.pbf || metadata.extraction?.pbf || "",
    boundaryRelationId: metadata.boundaryRelationId || metadata.relationId || 1278189,
    routeRoads: roads.length,
    buildMs: Date.now() - graphStarted,
    osmTimestamp: metadata.osmTimestamp
  });

  const nextMetadata = {
    ...metadata,
    source: "Strict OSM node-ref topology with manual topology-gap annotations",
    processedRoadCount: roads.length,
    namedRoadCount: roads.filter((road) => road.name).length,
    classDistribution: classDistribution(roads),
    manualTopology: {
      tool: "tools/apply-topology-gap-annotations.mjs",
      annotations: path.relative(process.cwd(), annotationsPath),
      debugJson: path.relative(process.cwd(), debugJsonPath),
      includeMissing: referenceRoads.length,
      manualLinks: (annotations.manualLinks || []).length,
      banAreas: (annotations.banAreas || []).length,
      appliedAt: new Date().toISOString()
    }
  };
  const nextAppData = {
    ...appData,
    roads
  };
  const nextRouteTemplates = selectRouteTemplates(roads);
  const nextDataJs = replaceDataAssignment(
    replaceDataAssignment(
      replaceDataAssignment(dataSrc, "MAP_METADATA", nextMetadata),
      "routeTemplates",
      nextRouteTemplates
    ),
    "appData",
    nextAppData
  );
  await fs.writeFile(DATA_PATH, nextDataJs, "utf8");
  await fs.writeFile(GRAPH_OUT_PATH, `window.TRAFFIC_ROUTE_GRAPH = ${JSON.stringify(routeGraph)};\n`, "utf8");

  console.log(JSON.stringify({
    annotations: annotationsPath,
    debugJson: debugJsonPath,
    baseRoads: baseRoads.length,
    manualRoads: manualRoads.length,
    includeMissing: referenceRoads.length,
    manualLinks: (annotations.manualLinks || []).length,
    roads: roads.length,
    graphNodes: routeGraph.nodes.length,
    graphEdges: routeGraph.edges.length
  }, null, 2));
}

function resolveIncludedReferenceRoads(annotations, debugData) {
  const byCode = new Map((debugData.referenceRoads || []).map((road) => [road.code, road]));
  const byOsmSegment = new Map((debugData.referenceRoads || []).map((road) => [osmSegmentKey(road.osmId, road.segmentIndex), road]));
  const seen = new Set();
  const result = [];
  (annotations.includeMissing || []).forEach((item) => {
    const road = typeof item === "string"
      ? byCode.get(item)
      : byCode.get(item.code) || byOsmSegment.get(osmSegmentKey(item.osmId, item.segmentIndex));
    if (!road) return;
    const key = osmSegmentKey(road.osmId, road.segmentIndex);
    if (seen.has(key)) return;
    seen.add(key);
    result.push(road);
  });
  return result;
}

function referenceToRoad(reference) {
  const tags = reference.tags || {};
  const rank = reference.rank || 2;
  const points = sanitizePoints(reference.points || []);
  return {
    id: manualReferenceRoadId(reference),
    osmId: reference.osmId,
    name: reference.name || "",
    highway: reference.highway || tags.highway || "residential",
    rank,
    width: WIDTH_BY_RANK[rank] || 2,
    length: round(polylineLength(points), 2),
    points,
    nodeIds: (reference.nodeIds || []).map((nodeId) => nodeId || ""),
    oneway: reference.oneway || normalizedOneway(tags, reference.highway),
    layer: Number.parseInt(reference.layer ?? tags.layer ?? "0", 10) || 0,
    bridge: reference.bridge === true || reference.bridge === "yes" || reference.bridge === "viaduct" || tags.bridge === "yes" || tags.bridge === "viaduct",
    tunnel: reference.tunnel === true || reference.tunnel === "yes" || tags.tunnel === "yes",
    access: reference.access || tags.access || "",
    service: reference.service || tags.service || "",
    routable: isRoutable({ ...tags, highway: reference.highway || tags.highway }),
    outsideMinhang: true,
    supplemental: "manual-topology-gap",
    tags: {
      ...tags,
      highway: reference.highway || tags.highway,
      name: reference.name || tags.name || undefined,
      oneway: reference.oneway || tags.oneway || undefined
    }
  };
}

function manualLinksToRoads(links) {
  return links
    .filter((link) => link?.from && link?.to)
    .map((link, index) => {
      const points = sanitizePoints([[link.from.x, link.from.y], [link.to.x, link.to.y]]);
      const rank = Math.max(link.from.rank || 1, link.to.rank || 1, 5);
      const highway = link.from.highway || link.to.highway || "service";
      return {
        id: "manual-link:" + (link.code || index + 1),
        osmId: "manual-link:" + (link.code || index + 1),
        name: "Manual topology link",
        highway,
        rank,
        width: WIDTH_BY_RANK[rank] || 2,
        length: round(polylineLength(points), 2),
        points,
        nodeIds: [
          link.from.nodeId || "manual-link:" + (link.code || index + 1) + ":from",
          link.to.nodeId || "manual-link:" + (link.code || index + 1) + ":to"
        ],
        oneway: "no",
        layer: link.from.layer || link.to.layer || 0,
        bridge: Boolean(link.from.bridge || link.to.bridge),
        tunnel: Boolean(link.from.tunnel || link.to.tunnel),
        access: "",
        service: "",
        routable: true,
        outsideMinhang: true,
        supplemental: "manual-topology-link",
        tags: { highway, name: "Manual topology link" }
      };
    });
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
    format: "compact-v2",
    topology: "strict-osm-node-refs",
    source: metadata.source,
    pbf: metadata.pbf,
    mode: metadata.mode,
    minRank: metadata.minRank,
    buildMs: metadata.buildMs,
    generatedAt: new Date().toISOString(),
    osmTimestamp: metadata.osmTimestamp,
    boundaryRelationId: metadata.boundaryRelationId,
    routeInputRoadCount: metadata.routeRoads,
    routeRoadCount: graph.routeRoadCount,
    edgeCount: graph.edgeCount,
    prunedNodeCount: graph.prunedNodeCount,
    segmentCount: graph.segmentCount,
    geometryRepairCount: 0,
    connectorCount: 0,
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
      const nodeFlags = String(id).includes("clip:") ? 1 : 0;
      return [
        round(node.x, 2),
        round(node.y, 2),
        node.componentId || 0,
        node.componentSize || 0,
        node.isTrafficCore ? 1 : 0,
        node.layer || 0,
        nodeFlags
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
      round(edge.length, 3),
      round(edge.points[0][0], 2),
      round(edge.points[0][1], 2),
      round(edge.points[1][0], 2),
      round(edge.points[1][1], 2),
      indexValue(syntheticKinds, syntheticKindIndex, edge.syntheticKind || ""),
      (edge.bridge ? 1 : 0) | (edge.tunnel ? 2 : 0)
    ])
  };
}

function isManualTopologyRoad(road) {
  return road.supplemental === "manual-topology-gap" || road.supplemental === "manual-topology-link";
}

function manualReferenceRoadId(reference) {
  return "manual:" + reference.osmId + ":" + reference.segmentIndex;
}

function osmSegmentKey(osmId, segmentIndex) {
  return String(osmId) + "#" + String(segmentIndex);
}

function sanitizePoints(points) {
  return points
    .map((point) => [round(Number(point[0]), 2), round(Number(point[1]), 2)])
    .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
}

function polylineLength(points) {
  let total = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    total += Math.hypot(points[index + 1][0] - points[index][0], points[index + 1][1] - points[index][1]);
  }
  return total;
}

function selectRouteTemplates(roads) {
  return roads
    .filter((road) => road.routable !== false && road.rank >= 6 && road.length >= 60)
    .sort((a, b) => b.rank - a.rank || b.length - a.length)
    .slice(0, 12)
    .map((road) => [road.id]);
}

function classDistribution(roads) {
  const result = {};
  roads.forEach((road) => {
    result[road.highway] = (result[road.highway] || 0) + 1;
  });
  return result;
}

function isRoutable(tags) {
  const highway = tags.highway;
  if (!highway || tags.area === "yes") return false;
  if (["construction", "proposed", "raceway"].includes(highway)) return false;
  if (["no", "private"].includes(tags.access)) return false;
  if (["no", "private"].includes(tags.vehicle)) return false;
  if (["no", "private"].includes(tags.motor_vehicle)) return false;
  if (["no", "private"].includes(tags.motorcar)) return false;
  if (highway === "pedestrian" && tags.motor_vehicle !== "yes" && tags.motorcar !== "yes") return false;
  return true;
}

function normalizedOneway(tags, highway) {
  if (tags.oneway === "-1") return "reverse";
  if (["yes", "true", "1"].includes(tags.oneway) || tags.junction === "roundabout" || highway === "motorway") return "yes";
  return "no";
}

function replaceDataAssignment(source, name, value) {
  const marker = `window.${name} = `;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing data assignment ${name}`);
  let index = start + marker.length;
  let depth = 0;
  let quote = null;
  let escape = false;
  for (; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{" || char === "[" || char === "(") depth += 1;
    if (char === "}" || char === "]" || char === ")") depth -= 1;
    if (char === ";" && depth === 0) {
      return source.slice(0, start + marker.length) + JSON.stringify(value) + source.slice(index);
    }
  }
  throw new Error(`Unterminated data assignment ${name}`);
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--annotations") parsed.annotations = args[++index];
    else if (arg === "--debug-json") parsed.debugJson = args[++index];
  }
  return parsed;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

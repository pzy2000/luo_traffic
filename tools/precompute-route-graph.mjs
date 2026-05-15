import fs from "node:fs/promises";

const DATA_PATH = new URL("../data/app-data.js", import.meta.url);
const GRAPH_LIB_PATH = new URL("../js/traffic-graph.js", import.meta.url);
const OUT_PATH = new URL("../data/route-graph.js", import.meta.url);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode || "arterial";
  const dataSrc = await fs.readFile(DATA_PATH, "utf8");
  const graphSrc = await fs.readFile(GRAPH_LIB_PATH, "utf8");
  const window = {};
  new Function("window", dataSrc)(window);
  new Function("window", graphSrc)(window);
  const started = Date.now();
  const graph = window.TrafficGraph.buildRoadGraph(window.appData, {
    mode,
    connectors: true
  });
  const serialized = serializeGraph(graph, mode, Date.now() - started);
  await fs.writeFile(OUT_PATH, `window.TRAFFIC_ROUTE_GRAPH = ${JSON.stringify(serialized)};\n`, "utf8");
  console.log(JSON.stringify({
    mode,
    nodes: serialized.nodes.length,
    edges: serialized.edges.length,
    routeRoadCount: serialized.routeRoadCount,
    components: serialized.componentCount,
    largest: serialized.largestComponentNodeCount,
    connectors: serialized.connectorCount,
    buildMs: serialized.buildMs
  }, null, 2));
}

function serializeGraph(graph, mode, buildMs) {
  const nodeIds = Array.from(graph.nodes.keys());
  const nodeIndex = new Map(nodeIds.map((id, index) => [id, index]));
  const roadIds = [];
  const roadIndex = new Map();
  const highways = [];
  const highwayIndex = new Map();

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
    mode,
    buildMs,
    generatedAt: new Date().toISOString(),
    routeRoadCount: graph.routeRoadCount,
    edgeCount: graph.edgeCount,
    prunedNodeCount: graph.prunedNodeCount,
    segmentCount: graph.segmentCount,
    connectorCount: graph.connectorCount,
    componentCount: graph.componentCount,
    largestComponentNodeCount: graph.largestComponentNodeCount,
    coreNodeCount: graph.coreNodeCount,
    deadEndBranchNodeCount: graph.deadEndBranchNodeCount,
    deadEndNodeIds: graph.deadEndNodes.map((node) => nodeIndex.get(node.id)).filter((id) => id !== undefined),
    roadIds,
    highways,
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
      round(edge.points[1][1], 1)
    ])
  };
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--mode") parsed.mode = args[++index];
  }
  return parsed;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

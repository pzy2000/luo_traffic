import fs from "node:fs";
import path from "node:path";
import { performance as nodePerformance } from "node:perf_hooks";

const ROOT = process.cwd();
const SIM_SECONDS = Number(process.argv.find((arg) => arg.startsWith("--seconds="))?.split("=")[1] || 150);
const STEP_MS = Number(process.argv.find((arg) => arg.startsWith("--step-ms="))?.split("=")[1] || 100);
const SCENARIO = process.argv.find((arg) => arg.startsWith("--scenario="))?.split("=")[1] || "current";
const INSPECT_EDGE = process.argv.find((arg) => arg.startsWith("--inspect-edge="))?.split("=")[1] || "";
const START_MS = 10000;

let fakeNow = START_MS;

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function makeNoopContext() {
  const gradient = { addColorStop() {} };
  const handler = {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === "measureText") return () => ({ width: 0 });
      if (prop === "createLinearGradient" || prop === "createRadialGradient") return () => gradient;
      if (prop === "getImageData") return () => ({ data: new Uint8ClampedArray([0, 0, 0, 0]) });
      return () => undefined;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    }
  };
  return new Proxy({}, handler);
}

function makeElement(id = "element") {
  return {
    id,
    style: {},
    dataset: {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; }
    },
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 1600, height: 900 };
    },
    appendChild() {},
    set innerHTML(value) { this._innerHTML = value; },
    get innerHTML() { return this._innerHTML || ""; },
    set textContent(value) { this._textContent = value; },
    get textContent() { return this._textContent || ""; }
  };
}

function makeCanvas(id = "canvas") {
  return {
    ...makeElement(id),
    width: 1600,
    height: 900,
    getContext() { return makeNoopContext(); }
  };
}

function installFakeBrowser() {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, id === "cityCanvas" ? makeCanvas(id) : makeElement(id));
      }
      return elements.get(id);
    },
    createElement(tag) {
      return tag === "canvas" ? makeCanvas("created-canvas") : makeElement(tag);
    }
  };
  const performance = {
    now: () => fakeNow,
    mark: nodePerformance.mark?.bind(nodePerformance),
    measure: nodePerformance.measure?.bind(nodePerformance)
  };
  const window = {
    document,
    devicePixelRatio: 1,
    innerWidth: 1600,
    innerHeight: 900,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame() { return 0; },
    cancelAnimationFrame() {},
    performance,
    __trafficDiagnosticMode: true
  };
  globalThis.window = window;
  globalThis.document = document;
  globalThis.performance = performance;
  globalThis.requestAnimationFrame = window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame;
  return window;
}

function loadRuntime() {
  const window = installFakeBrowser();
  new Function("window", read("data/app-data.js"))(window);
  new Function("window", read("js/traffic-graph.js"))(window);
  new Function("window", read("data/route-graph.js"))(window);

  const html = read("index.html");
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  let inline = scripts.find((script) => script.includes("const canvas = document.getElementById(\"cityCanvas\")"));
  if (!inline) throw new Error("Could not find main inline traffic script.");
  if (SCENARIO === "patched") {
    inline = applyPatchedScenario(inline);
  }

  const exposeSnippet = `
      if (window.__trafficDiagnosticMode) {
        window.__trafficInternals = {
          vehicles,
          routeLibrary,
          roadBounds,
          roadLookup,
          advanceVehicle,
          respawnTrafficVehicle,
          assignVehicleTrip,
          planTrafficRoute,
          findTrafficPath,
          collectTripRoutingTargets,
          chooseNextTrafficEdge,
          isLegalTrafficTransition,
          isTrafficSyntheticTraversable,
          isElevatedOrExpressway,
          isBoundaryDeadEndNode,
          isBoundaryExitCandidate,
          shouldStartBoundaryExit,
          canParkNaturally,
          canStopOrParkOnEdge,
          hasImmediateForwardExit,
          hasSustainedForwardPathAfterEdge,
          isDriveCoreNode,
          isCruiseTrafficEdge,
          isRouteSearchNode,
          nodeRoadRank,
          edgeMidpoint,
          nearestMapBoundary,
          vectorAlignment,
          distance,
          sampleEdge
        };
      }
`;
  inline = inline.replace("      requestAnimationFrame(frame);", `      requestAnimationFrame(frame);\n${exposeSnippet}`);
  new Function("window", inline)(window);
  if (!window.__trafficInternals) throw new Error("Traffic internals were not exposed.");
  return window.__trafficInternals;
}

function applyPatchedScenario(source) {
  let patched = source;
  patched = patched.replace(
    `        if (!incomingSeparated && nextSeparated && isElevatedMainline(nextEdge) && !incomingLink && !nextLink && !sameRoad) {
          return false;
        }`,
    `        if (!incomingSeparated && nextSeparated && isElevatedMainline(nextEdge) && !incomingLink && !nextLink && !sameRoad) {
          const incomingRoad = roadLookup.get(String(incomingEdge.roadId));
          const nextRoad = roadLookup.get(String(nextEdge.roadId));
          const sameNamedRoad = incomingRoad && nextRoad && incomingRoad.name && incomingRoad.name === nextRoad.name;
          const straightGradeContinuation = alignment > 0.86
            && nextEdge.rank >= incomingEdge.rank - 1
            && (sameNamedRoad || nextEdge.highway === incomingEdge.highway || nextEdge.rank >= incomingEdge.rank);
          if (!straightGradeContinuation) {
            return false;
          }
        }`
  );
  patched = patched.replace(
    `          ? 0.1 + (((sequence || 0) * 0.38196601125) % 1) * 0.78
          : 0.015 + rng() * 0.055;`,
    `          ? 0.015 + (((sequence || 0) * 0.38196601125) % 1) * 0.055
          : 0.015 + rng() * 0.055;`
  );
  patched = patched.replace(
    `        vehicle.spawnGraceUntil = timestamp + 1200;
        vehicle.exitAllowedAt = timestamp + 0;`,
    `        vehicle.spawnGraceUntil = timestamp + 3200;
        vehicle.exitAllowedAt = timestamp + 8500 + rng() * 4500;`
  );
  patched = patched.replace(
    `      function canStopOrParkOnEdge(edge) {
        return Boolean(edge
          && isSideRoadEdge(edge)
          && !isElevatedOrExpressway(edge)
          && !isLinkEdge(edge)
          && edge.highway !== "motorway"
          && edge.highway !== "trunk");
      }`,
    `      function canStopOrParkOnEdge(edge) {
        const road = edge ? roadLookup.get(String(edge.roadId)) : null;
        const surfaceParkingClass = isSideRoadEdge(edge)
          || (edge && edge.highway === "residential" && edge.rank <= 3 && (!road || !["private", "no"].includes(road.access || "")));
        return Boolean(edge
          && surfaceParkingClass
          && !isElevatedOrExpressway(edge)
          && !isLinkEdge(edge)
          && edge.highway !== "motorway"
          && edge.highway !== "trunk");
      }`
  );
  return patched;
}

function edgeInfo(edge, internals) {
  if (!edge) return null;
  const from = internals.routeLibrary.graph.nodes.get(edge.from);
  const to = internals.routeLibrary.graph.nodes.get(edge.to);
  const mid = from && to ? { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 } : null;
  const road = internals.roadLookup.get(String(edge.roadId));
  return {
    id: edge.id,
    roadId: edge.roadId,
    roadName: road?.name || "",
    highway: edge.highway,
    rank: edge.rank,
    layer: edge.layer || 0,
    bridge: Boolean(edge.bridge),
    tunnel: Boolean(edge.tunnel),
    synthetic: Boolean(edge.synthetic),
    syntheticKind: edge.syntheticKind || "",
    length: round(edge.length),
    from: edge.from,
    to: edge.to,
    mid: mid ? { x: round(mid.x), y: round(mid.y) } : null
  };
}

function edgeInfoById(edgeId, internals) {
  const edges = internals.routeLibrary.allEdges || [];
  const edge = edges.find((item) => String(item.id) === String(edgeId));
  return edgeInfo(edge, internals);
}

function edgeById(edgeId, internals) {
  const edges = internals.routeLibrary.allEdges || [];
  return edges.find((item) => String(item.id) === String(edgeId)) || null;
}

function nodeInfo(nodeId, internals) {
  const node = internals.routeLibrary.graph.nodes.get(nodeId);
  if (!node) return null;
  const boundary = internals.nearestMapBoundary(node);
  return {
    id: nodeId,
    x: round(node.x),
    y: round(node.y),
    componentId: node.componentId,
    componentSize: node.componentSize,
    isTrafficCore: Boolean(node.isTrafficCore),
    boundaryClip: Boolean(node.boundaryClip),
    boundary: boundary ? { side: boundary.side, distance: round(boundary.distance) } : null,
    outDegree: (internals.routeLibrary.graph.adjacency.get(nodeId) || []).length
  };
}

function round(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function pos(vehicle) {
  return vehicle.position ? { x: vehicle.position.x, y: vehicle.position.y } : null;
}

function snapshot(vehicle) {
  const position = pos(vehicle);
  return {
    id: vehicle.id,
    edgeId: vehicle.currentEdge?.id ?? null,
    edgeProgress: round(vehicle.edgeProgress),
    x: position ? round(position.x) : null,
    y: position ? round(position.y) : null,
    speed: round(vehicle.speed),
    vanishKind: vehicle.vanish?.kind ?? null,
    vanishReason: vehicle.vanish?.reason ?? null,
    retireReason: vehicle.retireIntent?.reason ?? null,
    lastDecision: vehicle.lastDecision,
    loopEscapeCount: vehicle.loopEscapeCount || 0,
    tripCount: vehicle.tripCount || 0,
    targetNode: vehicle.targetNode,
    originKind: vehicle.originKind,
    destinationKind: vehicle.destinationKind,
    strategy: vehicle.strategy,
    fixedThrough: Boolean(vehicle.fixedThrough),
    tripDistance: round(vehicle.tripProfile?.distance),
    routeReady: Boolean(vehicle.tripProfile?.routeReady),
    routeFailureCount: vehicle.routeFailureCount || 0,
    mainRoadDistanceRemaining: round(vehicle.mainRoadDistanceRemaining)
  };
}

function movementDistance(a, b) {
  if (!a || !b) return 0;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function simulate(internals) {
  const vehicles = internals.vehicles;
  const states = new Map();
  const vanishEvents = [];
  const loopEvents = [];
  const stuckEvents = [];
  const highRankVanishEvents = [];
  const lifecycleSummaries = [];

  vehicles.forEach((vehicle) => {
    states.set(vehicle.id, {
      cycleStartMs: START_MS,
      distance: 0,
      lastPosition: pos(vehicle),
      lastSnapshot: snapshot(vehicle),
      stuckMs: 0,
      stuckReported: false,
      cycleIndex: 0
    });
  });

  const steps = Math.ceil((SIM_SECONDS * 1000) / STEP_MS);
  for (let step = 1; step <= steps; step += 1) {
    fakeNow = START_MS + step * STEP_MS;
    const dt = STEP_MS / 1000;
    vehicles.forEach((vehicle, index) => {
      const state = states.get(vehicle.id);
      const before = snapshot(vehicle);
      const beforePosition = pos(vehicle);
      internals.advanceVehicle(vehicle, dt, fakeNow, index);
      const after = snapshot(vehicle);
      const afterPosition = pos(vehicle);
      const moved = movementDistance(beforePosition, afterPosition);
      state.distance += moved;

      if (!before.vanishKind && after.vanishKind) {
        const event = {
          timeSec: round((fakeNow - START_MS) / 1000, 1),
          vehicle: after.id,
          cycleIndex: state.cycleIndex,
          cycleAgeSec: round((fakeNow - state.cycleStartMs) / 1000, 1),
          cycleDistance: round(state.distance),
          kind: after.vanishKind,
          reason: after.vanishReason,
          lastDecision: after.lastDecision,
          strategy: after.strategy,
          originKind: after.originKind,
          destinationKind: after.destinationKind,
          tripDistance: after.tripDistance,
          routeReady: after.routeReady,
          routeFailureCount: after.routeFailureCount,
          loopEscapeCount: after.loopEscapeCount,
          speed: after.speed,
          edge: edgeInfo(vehicle.currentEdge, internals),
          node: nodeInfo(vehicle.currentEdge?.to, internals),
          boundaryExitNow: internals.isBoundaryExitCandidate(vehicle, after.strategy === "through" ? 210 : 110, false),
          canParkNaturally: internals.canParkNaturally(vehicle)
        };
        vanishEvents.push(event);
        if (vehicle.currentEdge && (vehicle.currentEdge.rank >= 7 || internals.isElevatedOrExpressway(vehicle.currentEdge))) {
          highRankVanishEvents.push(event);
        }
      }

      if (before.vanishKind && !after.vanishKind) {
        lifecycleSummaries.push({
          vehicle: after.id,
          endedAtSec: round((fakeNow - START_MS) / 1000, 1),
          previousKind: before.vanishKind,
          previousReason: before.vanishReason,
          distanceBeforeRespawn: round(state.distance)
        });
        state.cycleIndex += 1;
        state.cycleStartMs = fakeNow;
        state.distance = 0;
        state.stuckMs = 0;
        state.stuckReported = false;
      }

      if (after.loopEscapeCount > before.loopEscapeCount) {
        loopEvents.push({
          timeSec: round((fakeNow - START_MS) / 1000, 1),
          vehicle: after.id,
          strategy: after.strategy,
          loopEscapeCount: after.loopEscapeCount,
          lastDecision: after.lastDecision,
          speed: after.speed,
          edge: edgeInfo(vehicle.currentEdge, internals),
          targetNode: after.targetNode,
          tripDistance: after.tripDistance,
          routeFailureCount: after.routeFailureCount,
          position: afterPosition ? { x: round(afterPosition.x), y: round(afterPosition.y) } : null
          ,
          recentEdges: (vehicle.recentEdges || []).slice(-14).map((edgeId) => edgeInfoById(edgeId, internals)),
          recentNodes: (vehicle.recentNodes || []).slice(-14)
        });
      }

      if (after.speed > 8 && moved < 0.05) {
        state.stuckMs += STEP_MS;
      } else {
        state.stuckMs = 0;
        state.stuckReported = false;
      }
      if (state.stuckMs >= 1200 && !state.stuckReported) {
        stuckEvents.push({
          timeSec: round((fakeNow - START_MS) / 1000, 1),
          vehicle: after.id,
          stuckMs: state.stuckMs,
          speed: after.speed,
          movedLastStep: round(moved, 4),
          vanishKind: after.vanishKind,
          vanishReason: after.vanishReason,
          lastDecision: after.lastDecision,
          edge: edgeInfo(vehicle.currentEdge, internals),
          edgeProgress: after.edgeProgress,
          edgeLength: round(vehicle.currentEdge?.length),
          strategy: after.strategy,
          originKind: after.originKind,
          destinationKind: after.destinationKind,
          tripDistance: after.tripDistance,
          routeReady: after.routeReady,
          loopEscapeCount: after.loopEscapeCount
        });
        state.stuckReported = true;
      }

      state.lastPosition = afterPosition;
      state.lastSnapshot = after;
    });
  }

  const finalSnapshots = vehicles.map(snapshot);
  return {
    sim: {
      seconds: SIM_SECONDS,
      stepMs: STEP_MS,
      scenario: SCENARIO,
      vehicles: vehicles.length
    },
    initial: vehicles.map((vehicle) => snapshot(vehicle)).slice(0, 8),
    vanishEvents,
    shortVanishEvents: vanishEvents.filter((event) => event.cycleAgeSec < 15 || event.cycleDistance < 150),
    highRankVanishEvents,
    loopEvents,
    stuckEvents,
    stuckWhileVanishing: stuckEvents.filter((event) => event.vanishKind),
    stuckWhileNotVanishing: stuckEvents.filter((event) => !event.vanishKind),
    lifecycleSummaries: lifecycleSummaries.slice(-20),
    finalCounts: summarizeFinal(finalSnapshots)
  };
}

function summarizeFinal(snapshots) {
  const byDecision = {};
  const byVanish = {};
  const byStrategy = {};
  snapshots.forEach((item) => {
    byDecision[item.lastDecision || ""] = (byDecision[item.lastDecision || ""] || 0) + 1;
    byVanish[item.vanishReason || item.vanishKind || "active"] = (byVanish[item.vanishReason || item.vanishKind || "active"] || 0) + 1;
    byStrategy[item.strategy || ""] = (byStrategy[item.strategy || ""] || 0) + 1;
  });
  return { byDecision, byVanish, byStrategy };
}

function analyzeGraph(internals) {
  const graph = internals.routeLibrary.graph;
  const allEdges = internals.routeLibrary.allEdges || Array.from(graph.adjacency.values()).flat();
  const edgeIndex = new Map(allEdges.map((edge, index) => [edge.id, index]));
  const nextByIndex = allEdges.map((edge) => {
    return (graph.adjacency.get(edge.to) || [])
      .filter((nextEdge) => internals.isLegalTrafficTransition(graph, edge, nextEdge))
      .map((nextEdge) => edgeIndex.get(nextEdge.id))
      .filter((index) => index !== undefined);
  });
  const terminalEdges = allEdges.filter((edge, index) => nextByIndex[index].length === 0);
  const terminalHighRank = terminalEdges
    .filter((edge) => edge.rank >= 7 || internals.isElevatedOrExpressway(edge))
    .map((edge) => ({
      edge: edgeInfo(edge, internals),
      toNode: nodeInfo(edge.to, internals),
      boundaryDeadEnd: internals.isBoundaryDeadEndNode(graph, edge.to, edge),
      outgoingCount: (graph.adjacency.get(edge.to) || []).length
    }));

  const highRankNoImmediateExit = allEdges
    .filter((edge) => (edge.rank >= 7 || internals.isElevatedOrExpressway(edge)) && !internals.hasImmediateForwardExit(graph, edge))
    .map((edge) => ({
      edge: edgeInfo(edge, internals),
      toNode: nodeInfo(edge.to, internals),
      boundaryDeadEnd: internals.isBoundaryDeadEndNode(graph, edge.to, edge)
    }));

  const sccSummary = SCENARIO === "patched"
    ? { count: null, skipped: "skipped for patched scenario to avoid recursive SCC stack growth" }
    : summarizeSmallClosedSccs(allEdges, nextByIndex, internals);
  return {
    graph: {
      nodes: graph.nodes.size,
      edges: allEdges.length,
      componentCount: graph.componentCount,
      largestComponentNodeCount: graph.largestComponentNodeCount,
      coreNodeCount: graph.coreNodeCount,
      deadEndBranchNodeCount: graph.deadEndBranchNodeCount,
      precomputed: Boolean(graph.precomputed)
    },
    routeLibrary: {
      seedNodes: internals.routeLibrary.seedNodes.length,
      boundaryNodes: internals.routeLibrary.boundaryNodes.length,
      driveCoreNodes: internals.routeLibrary.driveCoreNodes.length,
      localEndpointNodes: internals.routeLibrary.localEndpointNodes.length,
      localSpawnEdges: internals.routeLibrary.localSpawnEdges.length,
      outsideEntryEdges: internals.routeLibrary.outsideEntryEdges.length,
      throughRoutes: internals.routeLibrary.throughRoutes.length
    },
    terminalEdges: {
      count: terminalEdges.length,
      highRankCount: terminalHighRank.length,
      highRankBoundaryDeadEndCount: terminalHighRank.filter((item) => item.boundaryDeadEnd).length,
      highRankSamples: terminalHighRank.slice(0, 12)
    },
    highRankNoImmediateExit: {
      count: highRankNoImmediateExit.length,
      boundaryDeadEndCount: highRankNoImmediateExit.filter((item) => item.boundaryDeadEnd).length,
      samples: highRankNoImmediateExit.slice(0, 12)
    },
    smallClosedSccs: sccSummary
  };
}

function inspectEdge(edgeId, internals) {
  const graph = internals.routeLibrary.graph;
  const edge = edgeById(edgeId, internals);
  if (!edge) {
    return { error: `edge ${edgeId} not found` };
  }
  const outgoing = graph.adjacency.get(edge.to) || [];
  return {
    edge: edgeInfo(edge, internals),
    toNode: nodeInfo(edge.to, internals),
    hasImmediateForwardExit: internals.hasImmediateForwardExit(graph, edge),
    hasSustainedForwardPathAfterEdge: internals.hasSustainedForwardPathAfterEdge(graph, edge),
    outgoing: outgoing.map((nextEdge) => ({
      edge: edgeInfo(nextEdge, internals),
      legal: internals.isLegalTrafficTransition(graph, edge, nextEdge),
      sustained: internals.hasSustainedForwardPathAfterEdge(graph, nextEdge),
      alignment: round(internals.vectorAlignment(edge.vector, nextEdge.vector), 4),
      backtrack: nextEdge.to === edge.from,
      syntheticTraversable: internals.isTrafficSyntheticTraversable(nextEdge)
    }))
  };
}

function summarizeSmallClosedSccs(allEdges, nextByIndex, internals) {
  const index = { value: 0 };
  const stack = [];
  const onStack = new Uint8Array(allEdges.length);
  const indices = new Int32Array(allEdges.length).fill(-1);
  const lowlinks = new Int32Array(allEdges.length).fill(-1);
  const closed = [];

  function strongConnect(v) {
    indices[v] = index.value;
    lowlinks[v] = index.value;
    index.value += 1;
    stack.push(v);
    onStack[v] = 1;
    for (const w of nextByIndex[v]) {
      if (indices[w] === -1) {
        strongConnect(w);
        lowlinks[v] = Math.min(lowlinks[v], lowlinks[w]);
      } else if (onStack[w]) {
        lowlinks[v] = Math.min(lowlinks[v], indices[w]);
      }
    }
    if (lowlinks[v] === indices[v]) {
      const members = [];
      let w;
      do {
        w = stack.pop();
        onStack[w] = 0;
        members.push(w);
      } while (w !== v);
      if (members.length > 1 && members.length <= 10) {
        const memberSet = new Set(members);
        const hasExit = members.some((member) => nextByIndex[member].some((next) => !memberSet.has(next)));
        if (!hasExit) {
          closed.push(members);
        }
      }
    }
  }

  for (let i = 0; i < allEdges.length; i += 1) {
    if (indices[i] === -1) strongConnect(i);
  }

  const samples = closed.slice(0, 12).map((members) => {
    const edges = members.map((member) => allEdges[member]);
    return {
      size: members.length,
      maxRank: Math.max(...edges.map((edge) => edge.rank || 0)),
      highways: [...new Set(edges.map((edge) => edge.highway))],
      edges: edges.slice(0, 6).map((edge) => edgeInfo(edge, internals))
    };
  });
  return {
    count: closed.length,
    samples
  };
}

function printReport(graphReport, simReport) {
  const report = {
    generatedAt: new Date().toISOString(),
    graphReport,
    simulationReport: {
      sim: simReport.sim,
      finalCounts: simReport.finalCounts,
      vanishCount: simReport.vanishEvents.length,
      shortVanishCount: simReport.shortVanishEvents.length,
      highRankVanishCount: simReport.highRankVanishEvents.length,
      loopEventCount: simReport.loopEvents.length,
      stuckEventCount: simReport.stuckEvents.length,
      stuckWhileVanishingCount: simReport.stuckWhileVanishing.length,
      stuckWhileNotVanishingCount: simReport.stuckWhileNotVanishing.length,
      vanishByReason: histogram(simReport.vanishEvents, (event) => event.reason || event.kind || "unknown"),
      vanishByDecision: histogram(simReport.vanishEvents, (event) => event.lastDecision || "unknown"),
      vanishByRoadClass: histogram(simReport.vanishEvents, (event) => `${event.edge?.highway || "unknown"}:${event.edge?.rank ?? "?"}`),
      shortVanishByReason: histogram(simReport.shortVanishEvents, (event) => event.reason || event.kind || "unknown"),
      highRankVanishByReason: histogram(simReport.highRankVanishEvents, (event) => event.reason || event.kind || "unknown"),
      loopByDecision: histogram(simReport.loopEvents, (event) => event.lastDecision || "unknown"),
      stuckByDecision: histogram(simReport.stuckEvents, (event) => event.lastDecision || "unknown"),
      stuckByRoadClass: histogram(simReport.stuckEvents, (event) => `${event.edge?.highway || "unknown"}:${event.edge?.rank ?? "?"}`),
      shortVanishSamples: simReport.shortVanishEvents.slice(0, 12),
      highRankVanishSamples: simReport.highRankVanishEvents.slice(0, 12),
      loopSamples: simReport.loopEvents.slice(0, 12),
      stuckSamples: simReport.stuckEvents.slice(0, 12),
      lifecycleTail: simReport.lifecycleSummaries
    }
  };
  console.log(JSON.stringify(report, null, 2));
}

function histogram(items, keyFn) {
  const counts = {};
  items.forEach((item) => {
    const key = keyFn(item);
    counts[key] = (counts[key] || 0) + 1;
  });
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

const internals = loadRuntime();
if (INSPECT_EDGE) {
  console.log(JSON.stringify(inspectEdge(INSPECT_EDGE, internals), null, 2));
  process.exit(0);
}
const graphReport = analyzeGraph(internals);
const simReport = simulate(internals);
printReport(graphReport, simReport);

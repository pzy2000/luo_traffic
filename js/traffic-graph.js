(function attachTrafficGraph(global) {
  function distance(first, second) {
    const firstX = Array.isArray(first) ? first[0] : first.x;
    const firstY = Array.isArray(first) ? first[1] : first.y;
    const secondX = Array.isArray(second) ? second[0] : second.x;
    const secondY = Array.isArray(second) ? second[1] : second.y;
    return Math.hypot(firstX - secondX, firstY - secondY);
  }

  function round(value, digits) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }

  function roadDirections(road) {
    if (road.oneway === "reverse") return { forward: false, backward: true };
    if (road.oneway === "yes") return { forward: true, backward: false };
    return { forward: true, backward: true };
  }

  function isRouteRoad(road, mode) {
    if (road.routable === false || road.points.length < 2) return false;
    if (mode === "primary" && road.rank < 7) return false;
    if (mode === "vehicle-core" && road.rank < 2) return false;
    if (mode === "arterial" && road.rank < 5) return false;
    return true;
  }

  function createEdge(edgeId, road, from, to, start, end, length) {
    return {
      id: edgeId,
      roadId: road.id,
      from,
      to,
      rank: road.rank,
      highway: road.highway || "residential",
      synthetic: Boolean(road.synthetic),
      syntheticKind: road.syntheticKind || road.connectorType || road.repairType || "",
      layer: road.layer || 0,
      bridge: Boolean(road.bridge),
      tunnel: Boolean(road.tunnel),
      length,
      points: [start, end],
      vector: { x: end[0] - start[0], y: end[1] - start[1] }
    };
  }

  function normalizeVector(vector) {
    const length = Math.hypot(vector.x, vector.y) || 1;
    return { x: vector.x / length, y: vector.y / length };
  }

  function dot(first, second) {
    return first.x * second.x + first.y * second.y;
  }

  function buildRoadGraph(appData, options) {
    const settings = {
      mode: "full",
      connectors: false,
      looseGap: 1.5,
      tightGap: 0.4,
      minSegmentLength: 0.5,
      geometryRepairs: false,
      highRankExtensionGap: 18,
      midRankExtensionGap: 12,
      endpointToSegmentGap: 0.75,
      repairMaxNodeDegree: 1,
      repairMinContinuationAlignment: 0.78,
      ...options
    };
    const nodes = new Map();
    const adjacency = new Map();
    const allEdges = [];
    let segmentCount = 0;
    const routeRoads = appData.roads.filter((road) => isRouteRoad(road, settings.mode));

    function nodeKey(point, road, pointIndex) {
      const osmNodeId = road.nodeIds ? road.nodeIds[pointIndex] : null;
      if (osmNodeId !== null && osmNodeId !== undefined) return "osm:" + osmNodeId;
      return "coord:" + Math.round(point[0] / 2) + ":" + Math.round(point[1] / 2);
    }

    function ensureNode(point, road, pointIndex) {
      const id = nodeKey(point, road, pointIndex);
      if (!nodes.has(id)) {
        const osmNodeId = road.nodeIds ? road.nodeIds[pointIndex] : null;
        nodes.set(id, {
          id,
          x: point[0],
          y: point[1],
          osmNodeId,
          officialOsmNode: typeof osmNodeId === "number",
          layer: road.layer || 0,
          roads: new Set([road.id])
        });
        adjacency.set(id, []);
      } else {
        nodes.get(id).roads.add(road.id);
      }
      return id;
    }

    routeRoads.forEach((road) => {
      const directions = roadDirections(road);
      for (let index = 0; index < road.points.length - 1; index += 1) {
        const start = road.points[index];
        const end = road.points[index + 1];
        const length = distance(start, end);
        if (length < settings.minSegmentLength) continue;
        const from = ensureNode(start, road, index);
        const to = ensureNode(end, road, index + 1);
        const edgeId = road.id + ":" + index;
        if (directions.forward) {
          const edge = createEdge(edgeId + ":f", road, from, to, start, end, length);
          adjacency.get(from).push(edge);
          allEdges.push(edge);
        }
        if (directions.backward) {
          const edge = createEdge(edgeId + ":b", road, to, from, end, start, length);
          adjacency.get(to).push(edge);
          allEdges.push(edge);
        }
        segmentCount += 1;
      }
    });

    const geometryRepairCount = settings.geometryRepairs
      ? addEndpointToSegmentRepairs(nodes, adjacency, allEdges, settings)
      : 0;
    const connectorCount = settings.connectors ? addNearbyConnectors(nodes, adjacency, allEdges, settings) : 0;
    const componentStats = annotateComponents(nodes, adjacency);
    const coreStats = annotateCore(nodes, adjacency);
    const neighbors = buildNeighborMap(nodes, adjacency);
    const deadEndNodes = [];
    neighbors.forEach((linkedNodes, nodeId) => {
      if (linkedNodes.size <= 1) deadEndNodes.push(nodes.get(nodeId));
    });

    return {
      nodes,
      adjacency,
      allEdges,
      routeRoads,
      edgeCount: segmentCount,
      routeRoadCount: routeRoads.length,
      prunedNodeCount: 0,
      segmentCount,
      geometryRepairCount,
      connectorCount,
      componentCount: componentStats.count,
      largestComponentNodeCount: componentStats.largestNodeCount,
      coreNodeCount: coreStats.coreNodeCount,
      deadEndBranchNodeCount: coreStats.deadEndBranchNodeCount,
      deadEndNodes
    };
  }

  function hydrateRoadGraph(serialized) {
    if (serialized.format === "compact-v1" || serialized.format === "compact-v2") {
      return hydrateCompactRoadGraph(serialized);
    }
    const nodes = new Map();
    const adjacency = new Map();
    serialized.nodes.forEach((node) => {
      nodes.set(node.id, {
        ...node,
        roads: new Set(node.roads || [])
      });
      adjacency.set(node.id, []);
    });
    const allEdges = serialized.edges.map((edge) => ({
      ...edge,
      vector: edge.vector || {
        x: edge.points[1][0] - edge.points[0][0],
        y: edge.points[1][1] - edge.points[0][1]
      }
    }));
    allEdges.forEach((edge) => {
      if (!adjacency.has(edge.from)) {
        adjacency.set(edge.from, []);
      }
      adjacency.get(edge.from).push(edge);
    });
    const deadEndNodes = (serialized.deadEndNodeIds || [])
      .map((nodeId) => nodes.get(nodeId))
      .filter(Boolean);
    return {
      nodes,
      adjacency,
      allEdges,
      routeRoads: [],
      routeRoadCount: serialized.routeRoadCount || 0,
      edgeCount: serialized.edgeCount || serialized.segmentCount || 0,
      prunedNodeCount: serialized.prunedNodeCount || 0,
      segmentCount: serialized.segmentCount || serialized.edgeCount || 0,
      connectorCount: serialized.connectorCount || 0,
      geometryRepairCount: serialized.geometryRepairCount || 0,
      componentCount: serialized.componentCount || 0,
      largestComponentNodeCount: serialized.largestComponentNodeCount || 0,
      coreNodeCount: serialized.coreNodeCount || 0,
      deadEndBranchNodeCount: serialized.deadEndBranchNodeCount || 0,
      deadEndNodes,
      precomputed: true
    };
  }

  function hydrateCompactRoadGraph(serialized) {
    const nodes = new Map();
    const adjacency = new Map();
    serialized.nodes.forEach((entry, index) => {
      nodes.set(index, {
        id: index,
        x: entry[0],
        y: entry[1],
        componentId: entry[2],
        componentSize: entry[3],
        isTrafficCore: Boolean(entry[4]),
        layer: entry[5] || 0,
        boundaryClip: Boolean(entry[6] & 1),
        roads: new Set()
      });
      adjacency.set(index, []);
    });
    const allEdges = serialized.edges.map((entry, index) => {
      const start = [entry[8], entry[9]];
      const end = [entry[10], entry[11]];
      const flags = entry[13] || 0;
      return {
        id: index,
        roadId: serialized.roadIds[entry[2]],
        from: entry[0],
        to: entry[1],
        rank: entry[3],
        highway: serialized.highways[entry[4]] || "",
        synthetic: Boolean(entry[5]),
        syntheticKind: serialized.syntheticKinds?.[entry[12]] || "",
        layer: entry[6] || 0,
        bridge: Boolean(flags & 1),
        tunnel: Boolean(flags & 2),
        length: entry[7],
        points: [start, end],
        vector: { x: end[0] - start[0], y: end[1] - start[1] }
      };
    });
    allEdges.forEach((edge) => {
      if (!adjacency.has(edge.from)) {
        adjacency.set(edge.from, []);
      }
      adjacency.get(edge.from).push(edge);
    });
    const deadEndNodes = (serialized.deadEndNodeIds || [])
      .map((nodeId) => nodes.get(nodeId))
      .filter(Boolean);
    return {
      nodes,
      adjacency,
      allEdges,
      routeRoads: [],
      routeRoadCount: serialized.routeRoadCount || 0,
      edgeCount: serialized.edgeCount || serialized.segmentCount || 0,
      prunedNodeCount: serialized.prunedNodeCount || 0,
      segmentCount: serialized.segmentCount || serialized.edgeCount || 0,
      connectorCount: serialized.connectorCount || 0,
      geometryRepairCount: serialized.geometryRepairCount || 0,
      componentCount: serialized.componentCount || 0,
      largestComponentNodeCount: serialized.largestComponentNodeCount || 0,
      coreNodeCount: serialized.coreNodeCount || 0,
      deadEndBranchNodeCount: serialized.deadEndBranchNodeCount || 0,
      deadEndNodes,
      precomputed: true
    };
  }

  function addNearbyConnectors(nodes, adjacency, allEdges, settings) {
    const extensionGap = settings.extensionGap || 2.4;
    const junctionGap = settings.junctionGap || 0.85;
    const cellSize = Math.max(extensionGap, junctionGap);
    const buckets = new Map();
    const connectorUse = new Map();
    const candidates = [];
    const neighbors = buildNeighborMap(nodes, adjacency);
    nodes.forEach((node) => {
      const key = bucketKey(node.x, node.y, cellSize);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(node);
    });
    nodes.forEach((node) => {
      const cellX = Math.floor(node.x / cellSize);
      const cellY = Math.floor(node.y / cellSize);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          const bucket = buckets.get((cellX + dx) + ":" + (cellY + dy)) || [];
          bucket.forEach((other) => {
            if (node.id >= other.id || hasConnection(adjacency, node.id, other.id)) return;
            if ((node.layer || 0) !== (other.layer || 0)) return;
            if (shareRoad(node, other) || neighbors.get(node.id).has(other.id)) return;
            const firstDegree = neighbors.get(node.id).size;
            const secondDegree = neighbors.get(other.id).size;
            const gap = distance(node, other);
            const firstProfile = dominantProfile(adjacency, node.id);
            const secondProfile = dominantProfile(adjacency, other.id);
            const connector = classifyConnector(node, other, adjacency, gap, firstDegree, secondDegree, {
              extensionGap,
              junctionGap,
              highRankExtensionGap: settings.highRankExtensionGap || extensionGap,
              midRankExtensionGap: settings.midRankExtensionGap || extensionGap,
              minHighRankExtensionAlignment: settings.minHighRankExtensionAlignment,
              minMidRankExtensionAlignment: settings.minMidRankExtensionAlignment,
              minLowRankExtensionAlignment: settings.minLowRankExtensionAlignment
            }, firstProfile, secondProfile);
            if (!connector) return;
            candidates.push({
              from: node,
              to: other,
              length: gap,
              type: connector.type,
              score: connector.score,
              rank: Math.max(2, Math.round((firstProfile.rank + secondProfile.rank) / 2)),
              highway: betterRoadClass(firstProfile.highway, secondProfile.highway)
            });
          });
        }
      }
    });
    candidates.sort((a, b) => b.score - a.score || a.length - b.length);
    let added = 0;
    candidates.forEach((candidate) => {
      const fromCount = connectorUse.get(candidate.from.id) || 0;
      const toCount = connectorUse.get(candidate.to.id) || 0;
      const maxUse = candidate.type === "junction" ? 3 : 1;
      if (fromCount >= maxUse || toCount >= maxUse || hasConnection(adjacency, candidate.from.id, candidate.to.id)) return;
      const road = {
        id: "connector:" + candidate.from.id + ":" + candidate.to.id,
        rank: candidate.rank,
        highway: candidate.highway,
        layer: candidate.from.layer || 0,
        synthetic: true,
        connectorType: candidate.type,
        syntheticKind: "short-" + candidate.type
      };
      const start = [candidate.from.x, candidate.from.y];
      const end = [candidate.to.x, candidate.to.y];
      const forward = createEdge(road.id + ":f", road, candidate.from.id, candidate.to.id, start, end, candidate.length);
      const backward = createEdge(road.id + ":b", road, candidate.to.id, candidate.from.id, end, start, candidate.length);
      adjacency.get(candidate.from.id).push(forward);
      adjacency.get(candidate.to.id).push(backward);
      allEdges.push(forward, backward);
      connectorUse.set(candidate.from.id, fromCount + 1);
      connectorUse.set(candidate.to.id, toCount + 1);
      added += 1;
    });
    return added;
  }

  function addEndpointToSegmentRepairs(nodes, adjacency, allEdges, settings) {
    const maxGap = settings.endpointToSegmentGap || 0.75;
    const maxNodeDegree = settings.repairMaxNodeDegree || 1;
    const minSegmentT = settings.repairMinSegmentT || 0.08;
    const minContinuationAlignment = settings.repairMinContinuationAlignment || 0.78;
    const neighbors = buildNeighborMap(nodes, adjacency);
    const segments = collectUndirectedSegments(allEdges);
    const incidentDirections = buildIncidentRealDirectionMap(allEdges);
    const buckets = new Map();

    segments.forEach((segment) => {
      const minX = Math.min(segment.start[0], segment.end[0]) - maxGap;
      const maxX = Math.max(segment.start[0], segment.end[0]) + maxGap;
      const minY = Math.min(segment.start[1], segment.end[1]) - maxGap;
      const maxY = Math.max(segment.start[1], segment.end[1]) + maxGap;
      for (let x = Math.floor(minX / maxGap); x <= Math.floor(maxX / maxGap); x += 1) {
        for (let y = Math.floor(minY / maxGap); y <= Math.floor(maxY / maxGap); y += 1) {
          const key = x + ":" + y;
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(segment);
        }
      }
    });

    const candidates = [];
    nodes.forEach((node, nodeId) => {
      const degree = (neighbors.get(nodeId) || new Set()).size;
      if (degree > maxNodeDegree) return;
      const nodeProfile = dominantProfile(adjacency, nodeId);
      const nodeVectors = incidentDirections.get(nodeId) || [];
      if (!nodeVectors.length) return;
      let best = null;
      const cellX = Math.floor(node.x / maxGap);
      const cellY = Math.floor(node.y / maxGap);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          const bucket = buckets.get((cellX + dx) + ":" + (cellY + dy)) || [];
          bucket.forEach((segment) => {
            if (segment.from === nodeId || segment.to === nodeId) return;
            if ((node.layer || 0) !== (segment.layer || 0)) return;
            if (Boolean(nodeProfile.bridge) !== Boolean(segment.bridge)) return;
            if (Boolean(nodeProfile.tunnel) !== Boolean(segment.tunnel)) return;
            if (node.roads && node.roads.has(segment.roadId)) return;
            const projection = projectOntoSegment(node, segment.start, segment.end);
            if (projection.t <= minSegmentT || projection.t >= 1 - minSegmentT) return;
            if (projection.distance > maxGap) return;
            const bridgeVector = normalizeVector({ x: projection.x - node.x, y: projection.y - node.y });
            const continuationAlignment = bestDirectionAlignment(nodeVectors, bridgeVector);
            if (continuationAlignment < minContinuationAlignment) return;
            const score = projection.distance
              + Math.max(0, 4 - segment.rank) * 0.05
              + (1 - continuationAlignment) * 0.45;
            if (!best || score < best.score) {
              best = { node, nodeId, segment, projection, score, nodeProfile, continuationAlignment };
            }
          });
        }
      }
      if (best) candidates.push(best);
    });

    candidates.sort((a, b) => a.score - b.score);
    let added = 0;
    const repairedNodes = new Set();
    candidates.forEach((candidate) => {
      if (repairedNodes.has(candidate.nodeId)) return;
      if (hasConnection(adjacency, candidate.nodeId, candidate.segment.from)
        || hasConnection(adjacency, candidate.nodeId, candidate.segment.to)) return;
      const repairId = "repair:" + candidate.segment.key + ":" + Math.round(candidate.projection.t * 1000) + ":" + candidate.nodeId;
      if (nodes.has(repairId)) return;
      const repairPoint = [round(candidate.projection.x, 1), round(candidate.projection.y, 1)];
      const repairNode = {
        id: repairId,
        x: repairPoint[0],
        y: repairPoint[1],
        layer: candidate.segment.layer || 0,
        roads: new Set([candidate.segment.roadId]),
        synthetic: true,
        repair: "endpoint-to-segment"
      };
      nodes.set(repairId, repairNode);
      adjacency.set(repairId, []);

      candidate.segment.edges.forEach((edge) => {
        addDirectedRepairEdge(adjacency, allEdges, edge, edge.from, repairId, edge.points[0], repairPoint);
        addDirectedRepairEdge(adjacency, allEdges, edge, repairId, edge.to, repairPoint, edge.points[1]);
      });

      const connectorRoad = {
        id: "repair-connector:" + candidate.nodeId + ":" + repairId,
        rank: Math.max(candidate.nodeProfile.rank || 2, candidate.segment.rank || 2),
        highway: betterRoadClass(candidate.nodeProfile.highway, candidate.segment.highway),
        layer: candidate.segment.layer || 0,
        bridge: candidate.segment.bridge,
        tunnel: candidate.segment.tunnel,
        synthetic: true,
        syntheticKind: "repair-connector"
      };
      const nodePoint = [candidate.node.x, candidate.node.y];
      const connectorLength = distance(nodePoint, repairPoint);
      const forward = createEdge(connectorRoad.id + ":f", connectorRoad, candidate.nodeId, repairId, nodePoint, repairPoint, connectorLength);
      const backward = createEdge(connectorRoad.id + ":b", connectorRoad, repairId, candidate.nodeId, repairPoint, nodePoint, connectorLength);
      adjacency.get(candidate.nodeId).push(forward);
      adjacency.get(repairId).push(backward);
      allEdges.push(forward, backward);
      repairedNodes.add(candidate.nodeId);
      added += 1;
    });
    return added;
  }

  function collectUndirectedSegments(allEdges) {
    const segments = new Map();
    allEdges.forEach((edge) => {
      if (edge.synthetic || edge.length <= 0.2) return;
      const endpoints = [String(edge.from), String(edge.to)].sort();
      const key = edge.roadId + ":" + endpoints[0] + ":" + endpoints[1];
      if (!segments.has(key)) {
        segments.set(key, {
          key,
          from: edge.from,
          to: edge.to,
          roadId: edge.roadId,
          rank: edge.rank || 0,
          highway: edge.highway || "residential",
          layer: edge.layer || 0,
          bridge: Boolean(edge.bridge),
          tunnel: Boolean(edge.tunnel),
          start: edge.points[0],
          end: edge.points[1],
          edges: []
        });
      }
      segments.get(key).edges.push(edge);
    });
    return Array.from(segments.values());
  }

  function addDirectedRepairEdge(adjacency, allEdges, sourceEdge, from, to, start, end) {
    const length = distance(start, end);
    if (length <= 0.05 || hasConnection(adjacency, from, to)) return;
    const road = {
      id: "repair-onroad:" + sourceEdge.id + ":" + from + ":" + to,
      rank: sourceEdge.rank,
      highway: sourceEdge.highway,
      layer: sourceEdge.layer || 0,
      bridge: sourceEdge.bridge,
      tunnel: sourceEdge.tunnel,
      synthetic: false,
      syntheticKind: "repair-onroad"
    };
    const edge = createEdge(road.id, road, from, to, start, end, length);
    adjacency.get(from).push(edge);
    allEdges.push(edge);
  }

  function buildIncidentRealDirectionMap(allEdges) {
    const directions = new Map();
    const seen = new Set();
    allEdges.forEach((edge) => {
      if (edge.synthetic || edge.length <= 0.2) return;
      const key = edge.roadId + ":" + edge.from + ":" + edge.to;
      if (seen.has(key)) return;
      seen.add(key);
      addIncidentDirection(directions, edge.from, edge.vector);
      addIncidentDirection(directions, edge.to, { x: -edge.vector.x, y: -edge.vector.y });
    });
    return directions;
  }

  function addIncidentDirection(directions, nodeId, vector) {
    if (!directions.has(nodeId)) directions.set(nodeId, []);
    directions.get(nodeId).push(normalizeVector(vector));
  }

  function bestDirectionAlignment(vectors, targetVector) {
    return vectors.reduce((best, vector) => Math.max(best, dot(vector, targetVector)), -1);
  }

  function projectOntoSegment(point, start, end) {
    const px = Array.isArray(point) ? point[0] : point.x;
    const py = Array.isArray(point) ? point[1] : point.y;
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const lengthSquared = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - start[0]) * dx + (py - start[1]) * dy) / lengthSquared));
    const x = start[0] + dx * t;
    const y = start[1] + dy * t;
    return { x, y, t, distance: Math.hypot(px - x, py - y) };
  }

  function classifyConnector(firstNode, secondNode, adjacency, gap, firstDegree, secondDegree, settings, firstProfile, secondProfile) {
    if (gap <= 0.01) {
      return { type: "junction", score: 100 };
    }
    firstProfile = firstProfile || dominantProfile(adjacency, firstNode.id);
    secondProfile = secondProfile || dominantProfile(adjacency, secondNode.id);
    if (Boolean(firstProfile.bridge) !== Boolean(secondProfile.bridge)) return null;
    if (Boolean(firstProfile.tunnel) !== Boolean(secondProfile.tunnel)) return null;
    const bridgeVector = normalizeVector({ x: secondNode.x - firstNode.x, y: secondNode.y - firstNode.y });
    const firstVectors = outgoingDirections(adjacency, firstNode.id, true);
    const secondVectors = outgoingDirections(adjacency, secondNode.id, false);
    const bestExtension = bestExtensionAlignment(firstVectors, secondVectors, bridgeVector);
    const minRank = Math.min(firstProfile.rank || 0, secondProfile.rank || 0);
    const maxExtensionGap = minRank >= 6
      ? settings.highRankExtensionGap
      : minRank >= 5
        ? settings.midRankExtensionGap
        : settings.extensionGap;
    const maxExtensionDegree = minRank >= 5 ? 2 : 1;
    let extensionAlignment = minRank >= 6
      ? settings.minHighRankExtensionAlignment || 0.76
      : minRank >= 5
        ? settings.minMidRankExtensionAlignment || 0.8
        : settings.minLowRankExtensionAlignment || 0.88;
    if (gap > 8) extensionAlignment = Math.max(extensionAlignment, 0.88);
    if (gap > 12) extensionAlignment = Math.max(extensionAlignment, 0.92);
    if ((firstDegree <= maxExtensionDegree || secondDegree <= maxExtensionDegree)
      && gap <= maxExtensionGap
      && bestExtension >= extensionAlignment) {
      return { type: "extension", score: 60 + bestExtension * 34 + minRank * 2 - gap * (minRank >= 6 ? 2.2 : 6) };
    }
    const bestCrossing = bestCrossingAlignment(firstVectors, secondVectors);
    if (gap <= settings.junctionGap && bestCrossing <= 0.35 && firstVectors.length && secondVectors.length) {
      return { type: "junction", score: 45 + (1 - bestCrossing) * 20 - gap * 8 };
    }
    return null;
  }

  function outgoingDirections(adjacency, nodeId, awayFromNode) {
    return (adjacency.get(nodeId) || [])
      .filter((edge) => !edge.synthetic && edge.length > 0.2)
      .map((edge) => normalizeVector(awayFromNode ? edge.vector : { x: -edge.vector.x, y: -edge.vector.y }));
  }

  function bestExtensionAlignment(firstVectors, secondVectors, bridgeVector) {
    let best = -1;
    firstVectors.forEach((first) => {
      secondVectors.forEach((second) => {
        const firstForward = dot(first, bridgeVector);
        const secondForward = dot(second, { x: -bridgeVector.x, y: -bridgeVector.y });
        const collinear = -dot(first, second);
        best = Math.max(best, Math.min(firstForward, secondForward, collinear));
      });
    });
    return best;
  }

  function bestCrossingAlignment(firstVectors, secondVectors) {
    let best = 1;
    firstVectors.forEach((first) => {
      secondVectors.forEach((second) => {
        best = Math.min(best, Math.abs(dot(first, second)));
      });
    });
    return best;
  }

  function bucketKey(x, y, cellSize) {
    return Math.floor(x / cellSize) + ":" + Math.floor(y / cellSize);
  }

  function buildNeighborMap(nodes, adjacency) {
    const neighbors = new Map();
    nodes.forEach((node, nodeId) => neighbors.set(nodeId, new Set()));
    adjacency.forEach((edges, nodeId) => {
      edges.forEach((edge) => {
        if (!nodes.has(edge.to)) return;
        neighbors.get(nodeId).add(edge.to);
        neighbors.get(edge.to).add(nodeId);
      });
    });
    return neighbors;
  }

  function annotateComponents(nodes, adjacency) {
    const neighbors = buildNeighborMap(nodes, adjacency);
    let componentId = 0;
    let largestNodeCount = 0;
    nodes.forEach((node, nodeId) => {
      if (node.componentId !== undefined) return;
      const queue = [nodeId];
      const componentNodes = [];
      node.componentId = componentId;
      for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
        const currentId = queue[queueIndex];
        componentNodes.push(currentId);
        (neighbors.get(currentId) || []).forEach((nextId) => {
          const nextNode = nodes.get(nextId);
          if (!nextNode || nextNode.componentId !== undefined) return;
          nextNode.componentId = componentId;
          queue.push(nextId);
        });
      }
      largestNodeCount = Math.max(largestNodeCount, componentNodes.length);
      componentNodes.forEach((currentId) => {
        nodes.get(currentId).componentSize = componentNodes.length;
      });
      componentId += 1;
    });
    return { count: componentId, largestNodeCount };
  }

  function annotateCore(nodes, adjacency) {
    const neighbors = buildNeighborMap(nodes, adjacency);
    const degree = new Map();
    const queue = [];
    neighbors.forEach((linkedNodes, nodeId) => {
      degree.set(nodeId, linkedNodes.size);
      if (linkedNodes.size <= 1) queue.push(nodeId);
    });
    const removed = new Set();
    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      const nodeId = queue[queueIndex];
      if (removed.has(nodeId) || (degree.get(nodeId) || 0) > 1) continue;
      removed.add(nodeId);
      (neighbors.get(nodeId) || []).forEach((neighborId) => {
        if (removed.has(neighborId)) return;
        const nextDegree = (degree.get(neighborId) || 0) - 1;
        degree.set(neighborId, nextDegree);
        if (nextDegree <= 1) queue.push(neighborId);
      });
    }
    let coreNodeCount = 0;
    nodes.forEach((node, nodeId) => {
      node.isTrafficCore = !removed.has(nodeId);
      if (node.isTrafficCore) coreNodeCount += 1;
    });
    return { coreNodeCount, deadEndBranchNodeCount: removed.size };
  }

  function hasConnection(adjacency, from, to) {
    return (adjacency.get(from) || []).some((edge) => edge.to === to);
  }

  function shareRoad(firstNode, secondNode) {
    if (!firstNode.roads || !secondNode.roads) return false;
    for (const roadId of firstNode.roads) {
      if (secondNode.roads.has(roadId)) return true;
    }
    return false;
  }

  function dominantProfile(adjacency, nodeId) {
    const edges = adjacency.get(nodeId) || [];
    if (!edges.length) return { rank: 2, highway: "residential" };
    return edges.reduce((best, edge) => (edge.rank > best.rank ? edge : best), edges[0]);
  }

  function betterRoadClass(first, second) {
    const order = ["residential", "unclassified", "tertiary", "secondary", "primary", "trunk", "motorway"];
    return order.indexOf(first) >= order.indexOf(second) ? first : second;
  }

  global.TrafficGraph = {
    buildRoadGraph,
    hydrateRoadGraph,
    buildNeighborMap,
    distance,
    isRouteRoad
  };
})(window);

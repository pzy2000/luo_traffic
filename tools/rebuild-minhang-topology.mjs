import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const parseOsmPbf = require("osm-pbf-parser");

const DATA_PATH = new URL("../data/app-data.js", import.meta.url);
const GRAPH_LIB_PATH = new URL("../js/traffic-graph.js", import.meta.url);
const GRAPH_OUT_PATH = new URL("../data/route-graph.js", import.meta.url);
const DEFAULT_PBF = new URL("./cache/shanghai-260513.osm.pbf", import.meta.url);
const RELATION_ID = 1278189;
const EPSILON = 1e-10;

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

const ROAD_TAGS_TO_KEEP = [
  "highway",
  "name",
  "oneway",
  "junction",
  "access",
  "vehicle",
  "motor_vehicle",
  "motorcar",
  "service",
  "bridge",
  "tunnel",
  "layer",
  "area"
];

const CONTROL_ROADS = ["外环", "嘉闵", "沪闵", "七莘", "虹梅", "莲花", "顾戴", "吴中", "申长"];
const JIAMIN_NAME_PATTERN = /嘉闵/;
const SUPPLEMENTAL_BBOX_MARGIN_DEGREES = 0.018;
const SUPPLEMENTAL_NORTH_MARGIN_DEGREES = 0;
const SUPPLEMENTAL_NORTH_TRIM_DEGREES = 0.032;
const JIAMIN_CORRIDOR_BUFFER_DEGREES = 0.0062;
const JIAMIN_MAINLINE_BUFFER_DEGREES = 0.012;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pbfPath = pathToFileURL(path.resolve(args.pbf || fileURLToPathname(DEFAULT_PBF)));
  const minRank = Number.parseInt(args.minRank || "1", 10);
  const graphMode = args.mode || "full";
  const dataSrc = await fs.readFile(DATA_PATH, "utf8");
  const graphSrc = await fs.readFile(GRAPH_LIB_PATH, "utf8");
  const windowData = {};
  const windowGraph = {};
  new Function("window", dataSrc)(windowData);
  new Function("window", graphSrc)(windowGraph);

  const metadata = windowData.MAP_METADATA;
  const appData = windowData.appData;
  if (!metadata?.originalBbox || !metadata?.projectedBounds) {
    throw new Error("data/app-data.js is missing MAP_METADATA.originalBbox or projectedBounds");
  }

  console.log(`Using PBF ${fileURLToPathname(pbfPath)}`);
  console.log("Scanning Minhang boundary relation...");
  const boundaryMemberRoles = await readBoundaryMemberRoles(pbfPath);
  if (!boundaryMemberRoles.size) {
    throw new Error(`Could not find relation ${RELATION_ID} in ${fileURLToPathname(pbfPath)}`);
  }

  console.log("Reading OSM nodes, boundary ways, and highway ways...");
  const raw = await readRoadData(pbfPath, boundaryMemberRoles, minRank);
  const outerBoundaryWays = raw.boundaryWays.filter((way) => way.role !== "inner");
  const boundaryRings = buildBoundaryRings(outerBoundaryWays, raw.nodes);
  const boundaryRing = boundaryRings.sort((a, b) => b.length - a.length)[0] || null;
  if (!boundaryRing) throw new Error(`Could not reconstruct outer ring for relation ${RELATION_ID}`);

  console.log("Clipping road ways to Minhang polygon while preserving OSM node ids...");
  const roads = buildRoads(
    raw.highwayWays,
    raw.nodes,
    metadata.originalBbox,
    metadata.projectedBounds,
    boundaryRing
  );
  const classDistribution = {};
  roads.forEach((road) => {
    classDistribution[road.highway] = (classDistribution[road.highway] || 0) + 1;
  });

  console.log("Building strict OSM node-ref route graph...");
  const started = Date.now();
  const graph = windowGraph.TrafficGraph.buildRoadGraph({ roads }, {
    mode: graphMode,
    connectors: false,
    geometryRepairs: false,
    minSegmentLength: 0.05
  });
  const routeGraph = serializeGraph(graph, {
    mode: graphMode,
    minRank,
    source: "Strict OSM node-ref topology clipped to Minhang with bounded Jiamin corridor supplement from Shanghai PBF",
    pbf: path.basename(fileURLToPathname(pbfPath)),
    boundaryRelationId: RELATION_ID,
    routeRoads: roads.length,
    buildMs: Date.now() - started,
    osmTimestamp: raw.osmTimestamp
  });

  const {
    supplementalSummary: _discardSupplementalSummary,
    highRankContinuityAudit: _discardHighRankContinuityAudit,
    ...baseMetadata
  } = metadata;
  const nextMetadata = {
    ...baseMetadata,
    source: "Strict OSM node-ref topology from Shanghai PBF with bounded Jiamin corridor supplement",
    licence: "Data © OpenStreetMap contributors, ODbL 1.0",
    geofabrikUrl: null,
    osmTimestamp: raw.osmTimestamp || metadata.osmTimestamp,
    areaTimestamp: null,
    sourceWayCount: raw.highwayWays.length,
    processedRoadCount: roads.length,
    namedRoadCount: roads.filter((road) => road.name).length,
    classDistribution,
    boundaryRelationId: RELATION_ID,
    boundaryRingPointCount: boundaryRing.length,
    sourceQuery: null,
    extraction: {
      tool: "tools/rebuild-minhang-topology.mjs",
      pbf: path.relative(process.cwd(), fileURLToPathname(pbfPath)),
      clip: "relation polygon segment clipping plus Jiamin corridor supplement",
      topology: "OSM node refs only; no geometric snapping; no synthetic connectors",
      minOutputRank: minRank,
      graphMode,
      supplementalCorridor: "Jiamin elevated road and nearby interchange roads outside Minhang relation; no north-side extension above Minhang bbox"
    },
    controlMatches: buildControlMatches(roads)
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
    source: nextMetadata.source,
    pbf: path.basename(fileURLToPathname(pbfPath)),
    highwayWays: raw.highwayWays.length,
    boundaryMemberWays: boundaryMemberRoles.size,
    boundaryRingPointCount: boundaryRing.length,
    roads: roads.length,
    namedRoads: nextMetadata.namedRoadCount,
    routableRoads: roads.filter((road) => road.routable !== false).length,
    routeTemplates: nextRouteTemplates,
    graphNodes: routeGraph.nodes.length,
    graphEdges: routeGraph.edges.length,
    weakComponents: routeGraph.componentCount,
    largestWeakNodes: routeGraph.largestComponentNodeCount,
    largestWeakRatio: round(routeGraph.largestComponentNodeCount / Math.max(1, routeGraph.nodes.length), 4),
    connectors: routeGraph.connectorCount,
    geometryRepairs: routeGraph.geometryRepairCount,
    osmTimestamp: nextMetadata.osmTimestamp
  }, null, 2));
}

function readBoundaryMemberRoles(fileUrl) {
  return new Promise((resolve, reject) => {
    const roles = new Map();
    createReadStream(fileUrl)
      .pipe(parseOsmPbf())
      .on("data", (items) => {
        items.forEach((item) => {
          if (item.type !== "relation" || item.id !== RELATION_ID) return;
          (item.members || []).forEach((member) => {
            if (member.type === "way") roles.set(member.id, member.role || "outer");
          });
        });
      })
      .on("error", reject)
      .on("end", () => resolve(roles));
  });
}

function readRoadData(fileUrl, boundaryMemberRoles, minRank) {
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
          if (boundaryMemberRoles.has(item.id)) {
            boundaryWays.push({ id: item.id, role: boundaryMemberRoles.get(item.id), refs: item.refs || [] });
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
    return points.concat([{ id: first.id, lat: first.lat, lon: first.lon }]);
  }
  return points;
}

function buildRoads(ways, nodes, bbox, bounds, boundaryRing) {
  const roads = [];
  const polygon = {
    ring: boundaryRing,
    edges: buildPolygonEdges(boundaryRing),
    bbox: bboxFromPoints(boundaryRing)
  };
  const supplementalCorridor = buildJiaminSupplementalCorridor(ways, nodes, polygon.bbox);

  ways.forEach((way) => {
    const geometry = way.nodes.map((nodeId) => nodes.get(nodeId) || null);
    const wayBbox = bboxFromPoints(geometry.filter(Boolean));
    const tags = way.tags || {};
    const highway = tags.highway;
    const rank = HIGHWAY_RANK[highway] || 2;
    const clippedParts = bboxOverlaps(wayBbox, polygon.bbox)
      ? clipWayToPolygon(way, geometry, polygon)
      : [];
    const supplementalParts = clipWayToJiaminSupplement(way, geometry, polygon, supplementalCorridor, rank);
    const allParts = clippedParts.concat(supplementalParts);

    allParts.forEach((part, partIndex) => {
      if (part.points.length < 2) return;
      const projected = part.points.map((point) => projectPoint(point, bbox, bounds));
      const length = polylineLength(projected);
      if (length < 0.3) return;
      const keptTags = {};
      ROAD_TAGS_TO_KEEP.forEach((key) => {
        if (tags[key] !== undefined) keptTags[key] = tags[key];
      });
      roads.push({
        id: roadPartId(way.id, partIndex, allParts.length, part.supplemental),
        osmId: way.id,
        name: tags.name || "",
        highway,
        rank,
        width: WIDTH_BY_RANK[rank] || 2,
        length: round(length, 2),
        points: projected.map((point) => [round(point.x, 2), round(point.y, 2)]),
        nodeIds: part.nodeIds,
        oneway: normalizedOneway(tags, highway),
        layer: Number.parseInt(tags.layer || "0", 10) || 0,
        bridge: tags.bridge === "yes" || tags.bridge === "viaduct",
        tunnel: tags.tunnel === "yes",
        access: tags.access || "",
        service: tags.service || "",
        routable: isRoutable(tags),
        outsideMinhang: Boolean(part.supplemental),
        supplemental: part.supplemental ? "jiamin-corridor" : "",
        tags: keptTags
      });
    });
  });
  roads.sort((a, b) => a.rank - b.rank || a.length - b.length || String(a.id).localeCompare(String(b.id)));
  return roads;
}

function roadPartId(wayId, partIndex, partCount, supplemental) {
  if (supplemental) {
    return `${wayId}-j${partIndex}`;
  }
  return partCount > 1 ? `${wayId}-${partIndex}` : String(wayId);
}

function buildJiaminSupplementalCorridor(ways, nodes, polygonBbox) {
  const searchBbox = jiaminSupplementalBbox(polygonBbox, SUPPLEMENTAL_BBOX_MARGIN_DEGREES * 2);
  const segments = [];
  ways.forEach((way) => {
    const tags = way.tags || {};
    if (!JIAMIN_NAME_PATTERN.test(tags.name || "")) {
      return;
    }
    const highway = tags.highway;
    const rank = HIGHWAY_RANK[highway] || 2;
    if (rank < 6) {
      return;
    }
    const geometry = way.nodes.map((nodeId) => nodes.get(nodeId) || null);
    const wayBbox = bboxFromPoints(geometry.filter(Boolean));
    if (!bboxOverlaps(wayBbox, searchBbox)) {
      return;
    }
    for (let index = 0; index < geometry.length - 1; index += 1) {
      const start = geometry[index];
      const end = geometry[index + 1];
      if (!start || !end) {
        continue;
      }
      segments.push({ start, end, bbox: bboxFromPoints([start, end]) });
    }
  });
  return {
    bbox: jiaminSupplementalBbox(polygonBbox, SUPPLEMENTAL_BBOX_MARGIN_DEGREES),
    segments
  };
}

function jiaminSupplementalBbox(bbox, margin) {
  const northLimit = jiaminSupplementalNorthLimit(bbox);
  return {
    minlat: bbox.minlat - margin,
    minlon: bbox.minlon - margin,
    maxlat: Math.min(bbox.maxlat + Math.min(margin, SUPPLEMENTAL_NORTH_MARGIN_DEGREES), northLimit),
    maxlon: bbox.maxlon + margin
  };
}

function jiaminSupplementalNorthLimit(bbox) {
  return bbox.maxlat - SUPPLEMENTAL_NORTH_TRIM_DEGREES;
}

function clipWayToJiaminSupplement(way, geometry, polygon, corridor, rank) {
  if (!corridor.segments.length) {
    return [];
  }
  const tags = way.tags || {};
  if (!isJiaminSupplementCandidate(tags, rank)) {
    return [];
  }
  const parts = [];
  let current = null;
  const namedJiamin = JIAMIN_NAME_PATTERN.test(tags.name || "");

  for (let index = 0; index < geometry.length - 1; index += 1) {
    const start = geometry[index];
    const end = geometry[index + 1];
    if (!start || !end) {
      flush();
      continue;
    }
    const segmentBbox = bboxFromPoints([start, end]);
    if (!bboxOverlaps(segmentBbox, corridor.bbox)) {
      flush();
      continue;
    }
    const clipped = clipSegmentToBbox(start, end, corridor.bbox);
    if (!clipped) {
      flush();
      continue;
    }
    const mid = interpolateGeo(start, end, (clipped.t0 + clipped.t1) / 2);
    if (pointInPolygonOrBoundary(mid, polygon.ring)) {
      flush();
      continue;
    }
    if (mid.lat > jiaminSupplementalNorthLimit(polygon.bbox)) {
      flush();
      continue;
    }
    const buffer = namedJiamin ? JIAMIN_MAINLINE_BUFFER_DEGREES : JIAMIN_CORRIDOR_BUFFER_DEGREES;
    if (!isNearCorridor(mid, corridor.segments, buffer)) {
      flush();
      continue;
    }
    const startNode = nodeIdForT(way.id, index, way.nodes[index], way.nodes[index + 1], clipped.t0);
    const endNode = nodeIdForT(way.id, index, way.nodes[index], way.nodes[index + 1], clipped.t1);
    if (!current) {
      current = { points: [clipped.start], nodeIds: [startNode], supplemental: true };
    } else {
      const last = current.points[current.points.length - 1];
      const lastNode = current.nodeIds[current.nodeIds.length - 1];
      if (lastNode !== startNode && pointDistanceDegrees(last, clipped.start) > 1e-9) {
        flush();
        current = { points: [clipped.start], nodeIds: [startNode], supplemental: true };
      }
    }
    current.points.push(clipped.end);
    current.nodeIds.push(endNode);
  }
  flush();
  return parts;

  function flush() {
    if (current && current.points.length > 1) parts.push(current);
    current = null;
  }
}

function isJiaminSupplementCandidate(tags, rank) {
  if (JIAMIN_NAME_PATTERN.test(tags.name || "")) {
    return true;
  }
  if (rank >= 5) {
    return true;
  }
  if (/_link$/.test(tags.highway || "")) {
    return true;
  }
  return rank >= 3 && (tags.bridge === "yes" || tags.bridge === "viaduct" || tags.tunnel === "yes" || tags.layer !== undefined);
}

function isNearCorridor(point, segments, maxDistance) {
  const pointBbox = {
    minlat: point.lat - maxDistance,
    maxlat: point.lat + maxDistance,
    minlon: point.lon - maxDistance,
    maxlon: point.lon + maxDistance
  };
  return segments.some((segment) => {
    if (!bboxOverlaps(pointBbox, segment.bbox)) {
      return false;
    }
    return pointToSegmentDistanceDegrees(point, segment.start, segment.end) <= maxDistance;
  });
}

function pointToSegmentDistanceDegrees(point, start, end) {
  const dx = end.lon - start.lon;
  const dy = end.lat - start.lat;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) {
    return pointDistanceDegrees(point, start);
  }
  const t = clamp(((point.lon - start.lon) * dx + (point.lat - start.lat) * dy) / lengthSquared, 0, 1);
  return pointDistanceDegrees(point, {
    lon: start.lon + dx * t,
    lat: start.lat + dy * t
  });
}

function clipSegmentToBbox(start, end, bbox) {
  const dx = end.lon - start.lon;
  const dy = end.lat - start.lat;
  let t0 = 0;
  let t1 = 1;
  if (!clipTest(-dx, start.lon - bbox.minlon)) return null;
  if (!clipTest(dx, bbox.maxlon - start.lon)) return null;
  if (!clipTest(-dy, start.lat - bbox.minlat)) return null;
  if (!clipTest(dy, bbox.maxlat - start.lat)) return null;
  if (t1 < t0) return null;
  return {
    t0,
    t1,
    start: interpolateGeo(start, end, t0),
    end: interpolateGeo(start, end, t1)
  };

  function clipTest(p, q) {
    if (Math.abs(p) < EPSILON) return q >= -EPSILON;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  }
}

function expandBbox(bbox, margin) {
  return {
    minlat: bbox.minlat - margin,
    minlon: bbox.minlon - margin,
    maxlat: bbox.maxlat + margin,
    maxlon: bbox.maxlon + margin
  };
}

function clipWayToPolygon(way, geometry, polygon) {
  const parts = [];
  let current = null;

  for (let index = 0; index < geometry.length - 1; index += 1) {
    const start = geometry[index];
    const end = geometry[index + 1];
    if (!start || !end) {
      flush();
      continue;
    }
    const pieces = clipSegmentToPolygon(start, end, polygon);
    if (!pieces.length) {
      flush();
      continue;
    }
    pieces.forEach((piece) => {
      const startNode = nodeIdForT(way.id, index, way.nodes[index], way.nodes[index + 1], piece.t0);
      const endNode = nodeIdForT(way.id, index, way.nodes[index], way.nodes[index + 1], piece.t1);
      if (!current) {
        current = { points: [piece.start], nodeIds: [startNode] };
      } else {
        const last = current.points[current.points.length - 1];
        const lastNode = current.nodeIds[current.nodeIds.length - 1];
        if (lastNode !== startNode && pointDistanceDegrees(last, piece.start) > 1e-9) {
          flush();
          current = { points: [piece.start], nodeIds: [startNode] };
        }
      }
      current.points.push(piece.end);
      current.nodeIds.push(endNode);
    });
  }
  flush();
  return parts;

  function flush() {
    if (current && current.points.length > 1) parts.push(current);
    current = null;
  }
}

function clipSegmentToPolygon(start, end, polygon) {
  const segmentBbox = bboxFromPoints([start, end]);
  if (!bboxOverlaps(segmentBbox, polygon.bbox)) return [];
  const tValues = [0, 1];
  polygon.edges.forEach((edge) => {
    if (!bboxOverlaps(segmentBbox, edge.bbox)) return;
    const hit = segmentIntersection(start, end, edge.start, edge.end);
    if (!hit) return;
    if (hit.t >= -EPSILON && hit.t <= 1 + EPSILON && hit.u >= -EPSILON && hit.u <= 1 + EPSILON) {
      addT(tValues, clamp(hit.t, 0, 1));
    }
  });
  tValues.sort((a, b) => a - b);
  const pieces = [];
  for (let index = 0; index < tValues.length - 1; index += 1) {
    const t0 = tValues[index];
    const t1 = tValues[index + 1];
    if (t1 - t0 < 1e-9) continue;
    const mid = interpolateGeo(start, end, (t0 + t1) / 2);
    if (!pointInPolygonOrBoundary(mid, polygon.ring)) continue;
    pieces.push({
      t0,
      t1,
      start: interpolateGeo(start, end, t0),
      end: interpolateGeo(start, end, t1)
    });
  }
  return pieces;
}

function buildPolygonEdges(ring) {
  const edges = [];
  for (let index = 0; index < ring.length - 1; index += 1) {
    const start = ring[index];
    const end = ring[index + 1];
    edges.push({ start, end, bbox: bboxFromPoints([start, end]) });
  }
  return edges;
}

function segmentIntersection(p, p2, q, q2) {
  const r = { lon: p2.lon - p.lon, lat: p2.lat - p.lat };
  const s = { lon: q2.lon - q.lon, lat: q2.lat - q.lat };
  const denominator = cross(r, s);
  if (Math.abs(denominator) < EPSILON) return null;
  const qp = { lon: q.lon - p.lon, lat: q.lat - p.lat };
  return {
    t: cross(qp, s) / denominator,
    u: cross(qp, r) / denominator
  };
}

function pointInPolygonOrBoundary(point, polygon) {
  for (let index = 0; index < polygon.length - 1; index += 1) {
    if (pointOnSegment(point, polygon[index], polygon[index + 1])) return true;
  }
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

function pointOnSegment(point, start, end) {
  const dx = end.lon - start.lon;
  const dy = end.lat - start.lat;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return pointDistanceDegrees(point, start) < 1e-10;
  const t = ((point.lon - start.lon) * dx + (point.lat - start.lat) * dy) / lengthSquared;
  if (t < -1e-8 || t > 1 + 1e-8) return false;
  const projected = { lon: start.lon + dx * t, lat: start.lat + dy * t };
  return pointDistanceDegrees(point, projected) < 1e-9;
}

function nodeIdForT(wayId, segmentIndex, fromId, toId, t) {
  if (t <= 1e-8) return fromId;
  if (t >= 1 - 1e-8) return toId;
  return `clip:${wayId}:${segmentIndex}:${round(t, 6)}`;
}

function interpolateGeo(start, end, t) {
  return {
    lat: start.lat + (end.lat - start.lat) * t,
    lon: start.lon + (end.lon - start.lon) * t
  };
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

function selectRouteTemplates(roads) {
  return roads
    .filter((road) => road.routable !== false && road.rank >= 6 && road.length >= 60)
    .sort((a, b) => b.rank - a.rank || b.length - a.length)
    .slice(0, 12)
    .map((road) => [road.id]);
}

function buildControlMatches(roads) {
  return CONTROL_ROADS.map((key) => {
    const samples = roads
      .filter((road) => road.name && road.name.includes(key))
      .slice(0, 5)
      .map((road) => road.name);
    return { key, found: samples.length > 0, samples };
  });
}

function projectPoint(point, bbox, bounds) {
  const xRatio = (point.lon - bbox.minlon) / (bbox.maxlon - bbox.minlon);
  const yRatio = (bbox.maxlat - point.lat) / (bbox.maxlat - bbox.minlat);
  return {
    x: bounds.minX + xRatio * (bounds.maxX - bounds.minX),
    y: bounds.minY + yRatio * (bounds.maxY - bounds.minY)
  };
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

function bboxFromPoints(points) {
  const bbox = { minlat: Infinity, minlon: Infinity, maxlat: -Infinity, maxlon: -Infinity };
  points.forEach((point) => {
    bbox.minlat = Math.min(bbox.minlat, point.lat);
    bbox.minlon = Math.min(bbox.minlon, point.lon);
    bbox.maxlat = Math.max(bbox.maxlat, point.lat);
    bbox.maxlon = Math.max(bbox.maxlon, point.lon);
  });
  return bbox;
}

function bboxOverlaps(first, second) {
  if (!Number.isFinite(first.minlat) || !Number.isFinite(second.minlat)) return false;
  return first.maxlon >= second.minlon - EPSILON
    && first.minlon <= second.maxlon + EPSILON
    && first.maxlat >= second.minlat - EPSILON
    && first.minlat <= second.maxlat + EPSILON;
}

function polylineLength(points) {
  let total = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    total += Math.hypot(points[index + 1].x - points[index].x, points[index + 1].y - points[index].y);
  }
  return total;
}

function pointDistanceDegrees(first, second) {
  return Math.hypot(first.lon - second.lon, first.lat - second.lat);
}

function cross(first, second) {
  return first.lon * second.lat - first.lat * second.lon;
}

function addT(values, value) {
  if (!values.some((existing) => Math.abs(existing - value) < 1e-8)) values.push(value);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--pbf") parsed.pbf = args[++index];
    else if (args[index] === "--min-rank") parsed.minRank = args[++index];
    else if (args[index] === "--mode") parsed.mode = args[++index];
  }
  return parsed;
}

function extractDataAssignment(source, name) {
  const marker = `window.${name} = `;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing data assignment ${name}`);
  let index = start + marker.length;
  const expressionStart = index;
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
    if (char === ";" && depth === 0) return source.slice(expressionStart, index).trim();
  }
  throw new Error(`Unterminated data assignment ${name}`);
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

function fileURLToPathname(url) {
  return decodeURIComponent(url.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

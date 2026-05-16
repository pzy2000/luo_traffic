import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const parseOsmPbf = require("osm-pbf-parser");

const DATA_PATH = new URL("../data/app-data.js", import.meta.url);
const ROUTE_GRAPH_PATH = new URL("../data/route-graph.js", import.meta.url);
const DEFAULT_PBF = new URL("./cache/shanghai-260513.osm.pbf", import.meta.url);
const DEFAULT_JSON_OUT = new URL("../test-results/topology-gap-debug.json", import.meta.url);
const DEFAULT_HTML_OUT = new URL("../test-results/topology-gap-debug.html", import.meta.url);

const HIGHWAY_PATTERN = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$/;
const DEFAULT_FOCUS = "沪闵|沪昆|沪渝|金都|银都";
const DEFAULT_CANDIDATE = "沪闵|沪昆|沪渝|金都|银都|莘庄|虹梅|莲花|七莘";
const DEFAULT_RADIUS = 95;
const DEFAULT_MAX_CANDIDATES = 180;
const DEFAULT_MAX_REFERENCE_ROADS = 0;
const DEFAULT_VIEW_PAD = 120;
const DEFAULT_REFERENCE_PAD = 120;
const DEFAULT_BOUNDARY_RECHECK_PAD = 18;
const EXISTING_COVERAGE_TOLERANCE = 2;
const EXISTING_COVERAGE_SAMPLES = 9;

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pbfPath = pathToFileURL(path.resolve(args.pbf || fileURLToPath(DEFAULT_PBF)));
  const jsonOut = path.resolve(args.out || fileURLToPath(DEFAULT_JSON_OUT));
  const htmlOut = path.resolve(args.html || fileURLToPath(DEFAULT_HTML_OUT));
  const focusPattern = args.focus || DEFAULT_FOCUS;
  const candidatePattern = args.candidates || DEFAULT_CANDIDATE;
  const focusRegex = new RegExp(focusPattern, "i");
  const candidateRegex = new RegExp(candidatePattern, "i");
  const radius = Number.parseFloat(args.radius || String(DEFAULT_RADIUS));
  const maxCandidates = Number.parseInt(args.maxCandidates || String(DEFAULT_MAX_CANDIDATES), 10);
  const maxReferenceRoads = Number.parseInt(args.maxReferenceRoads || String(DEFAULT_MAX_REFERENCE_ROADS), 10);
  const viewPad = Number.parseFloat(args.viewPad || String(DEFAULT_VIEW_PAD));
  const referencePad = Number.parseFloat(args.referencePad || String(DEFAULT_REFERENCE_PAD));
  const boundaryRecheckPad = Number.parseFloat(args.boundaryRecheckPad || String(DEFAULT_BOUNDARY_RECHECK_PAD));

  const { metadata, roads, routeGraph } = await readCurrentData();
  const decoded = decodeRouteGraph(routeGraph, roads);
  const gaps = buildFocusGaps(decoded, focusRegex);
  const viewBounds = args.mapBounds
    ? parseMapBounds(args.mapBounds)
    : args.focusBounds
      ? boundsAroundGaps(gaps, metadata.projectedBounds)
      : expandMapBounds(metadata.projectedBounds, viewPad);
  const pbf = await readPbfRoads(pbfPath, metadata.boundaryRelationId || metadata.relationId);
  const boundaryRing = (pbf.boundaryRing || [])
    .map((point) => projectPoint(point, metadata.originalBbox, metadata.projectedBounds));
  const candidates = buildCandidates({
    pbf,
    metadata,
    roads,
    gaps,
    viewBounds,
    candidateRegex,
    radius,
    maxCandidates
  });
  const contextRoads = buildContextRoads(roads, viewBounds, focusRegex);
  const referenceResult = buildReferenceRoads({
    pbf,
    metadata,
    roads,
    viewBounds,
    referencePad,
    boundaryRecheckPad,
    boundaryRing,
    maxReferenceRoads
  });
  const referenceRoads = referenceResult.roads;

  const result = {
    generatedAt: new Date().toISOString(),
    pbf: path.basename(fileURLToPath(pbfPath)),
    purpose: "Interactive topology gap debug. Dark translucent roads are true Shanghai PBF ways not present in the current Minhang map extract.",
    instructions: {
      include: "告诉我需要补入的候选编号，例如：加 CAND-003 CAND-014。",
      exclude: "告诉我不要补入的候选编号，例如：不要 CAND-021 CAND-022。",
      gap: "如果候选不够清楚，也可以只报断点编号，例如：重点看 GAP-002。"
    },
    filters: {
      focusPattern,
      candidatePattern,
      radius,
      maxCandidates,
      maxReferenceRoads,
      viewMode: args.mapBounds ? "manual-map-bounds" : args.focusBounds ? "focus-gap-bounds" : "full-current-map-plus-pad",
      viewPad,
      referencePad,
      boundaryRecheckPad
    },
    metadata: {
      source: metadata.source,
      extraction: metadata.extraction,
      originalBbox: metadata.originalBbox,
      projectedBounds: metadata.projectedBounds
    },
    summary: {
      roads: roads.length,
      routeNodes: routeGraph.nodes.length,
      routeEdges: routeGraph.edges.length,
      focusGaps: gaps.length,
      candidates: candidates.length,
      contextRoads: contextRoads.length,
      referenceRoads: referenceRoads.length,
      candidateStatusCounts: countBy(candidates, (item) => item.status),
      referenceStatusCounts: countBy(referenceRoads, (item) => item.status),
      referenceAudit: referenceResult.audit
    },
    view: {
      bounds: viewBounds,
      width: round(viewBounds.maxX - viewBounds.minX, 2),
      height: round(viewBounds.maxY - viewBounds.minY, 2)
    },
    boundaryRing: boundaryRing.map((point) => [round(point[0], 2), round(point[1], 2)]),
    gaps,
    candidates,
    contextRoads,
    referenceRoads
  };

  await fs.mkdir(path.dirname(jsonOut), { recursive: true });
  await fs.writeFile(jsonOut, JSON.stringify(result), "utf8");
  await fs.mkdir(path.dirname(htmlOut), { recursive: true });
  await fs.writeFile(htmlOut, buildHtml(result), "utf8");

  console.log(JSON.stringify({
    json: jsonOut,
    html: htmlOut,
    focusGaps: gaps.length,
    candidates: candidates.length,
    contextRoads: contextRoads.length,
    referenceRoads: referenceRoads.length
  }, null, 2));
}

async function readCurrentData() {
  const dataSrc = await fs.readFile(DATA_PATH, "utf8");
  const graphSrc = await fs.readFile(ROUTE_GRAPH_PATH, "utf8");
  const window = {};
  new Function("window", dataSrc)(window);
  new Function("window", graphSrc)(window);
  if (!window.MAP_METADATA || !window.appData?.roads || !window.TRAFFIC_ROUTE_GRAPH) {
    throw new Error("Missing MAP_METADATA, appData.roads, or TRAFFIC_ROUTE_GRAPH");
  }
  return {
    metadata: window.MAP_METADATA,
    roads: window.appData.roads,
    routeGraph: window.TRAFFIC_ROUTE_GRAPH
  };
}

function decodeRouteGraph(routeGraph, roads) {
  const roadLookup = new Map(roads.map((road) => [String(road.id), road]));
  const edges = routeGraph.edges.map((row, index) => {
    const roadId = String(routeGraph.roadIds[row[2]]);
    const flags = row[13] || 0;
    return {
      index,
      from: row[0],
      to: row[1],
      roadId,
      road: roadLookup.get(roadId),
      rank: row[3],
      highway: routeGraph.highways[row[4]] || "",
      synthetic: Boolean(row[5]),
      layer: row[6] || 0,
      length: row[7] || 0,
      fromPoint: [row[8], row[9]],
      toPoint: [row[10], row[11]],
      bridge: Boolean(flags & 1),
      tunnel: Boolean(flags & 2)
    };
  });
  const outgoing = new Map();
  edges.forEach((edge) => {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge);
  });
  return { routeGraph, roads, edges, outgoing };
}

function buildFocusGaps(decoded, focusRegex) {
  const terminals = [];
  decoded.edges.forEach((edge) => {
    if (edge.synthetic || !edge.road || edge.road.routable === false) return;
    if (!focusRegex.test(edge.road.name || "")) return;
    if (edge.rank < 5 && !/_link$/.test(edge.highway)) return;
    if (isBoundaryNode(decoded.routeGraph, edge.to)) return;
    const outgoing = (decoded.outgoing.get(edge.to) || [])
      .filter((next) => !next.synthetic && !(next.to === edge.from && next.roadId === edge.roadId));
    if (outgoing.length) return;
    terminals.push(edge);
  });

  const groups = [];
  terminals
    .sort((a, b) => a.toPoint[0] - b.toPoint[0] || a.toPoint[1] - b.toPoint[1])
    .forEach((edge) => {
      const group = groups.find((item) => distancePoint(edge.toPoint, item.point) <= 7);
      if (group) {
        group.edges.push(edge);
        group.point = averagePoints(group.edges.map((item) => item.toPoint));
      } else {
        groups.push({ point: edge.toPoint, edges: [edge] });
      }
    });

  return groups.map((group, index) => {
    const names = unique(group.edges.map((edge) => edge.road?.name || "").filter(Boolean));
    const highways = unique(group.edges.map((edge) => edge.highway).filter(Boolean));
    return {
      code: code("GAP", index),
      x: round(group.point[0], 2),
      y: round(group.point[1], 2),
      names,
      highways,
      edgeCount: group.edges.length,
      endpoints: group.edges.slice(0, 12).map((edge) => ({
        roadId: edge.roadId,
        osmId: edge.road?.osmId,
        name: edge.road?.name || "",
        highway: edge.highway,
        rank: edge.rank,
        layer: edge.layer,
        bridge: edge.bridge,
        tunnel: edge.tunnel,
        x: round(edge.toPoint[0], 2),
        y: round(edge.toPoint[1], 2)
      }))
    };
  });
}

async function readPbfRoads(fileUrl, boundaryRelationId) {
  const boundaryMemberRoles = boundaryRelationId
    ? await readBoundaryMemberRoles(fileUrl, boundaryRelationId)
    : new Map();
  return new Promise((resolve, reject) => {
    const nodes = new Map();
    const ways = [];
    const boundaryWays = [];
    createReadStream(fileUrl)
      .pipe(parseOsmPbf())
      .on("data", (items) => {
        items.forEach((item) => {
          if (item.type === "node") {
            nodes.set(item.id, { id: item.id, lat: item.lat, lon: item.lon });
            return;
          }
          if (item.type !== "way") return;
          if (boundaryMemberRoles.has(item.id)) {
            boundaryWays.push({ id: item.id, role: boundaryMemberRoles.get(item.id), refs: item.refs || [] });
          }
          const highway = item.tags?.highway;
          if (!highway || !HIGHWAY_PATTERN.test(highway) || !item.refs?.length) return;
          ways.push({ id: item.id, nodes: item.refs, tags: item.tags || {} });
        });
      })
      .on("error", reject)
      .on("end", () => {
        const rings = buildBoundaryRings(boundaryWays, nodes);
        const boundaryRing = rings.sort((a, b) => b.length - a.length)[0] || [];
        resolve({ nodes, ways, boundaryRing });
      });
  });
}

function readBoundaryMemberRoles(fileUrl, relationId) {
  return new Promise((resolve, reject) => {
    const roles = new Map();
    createReadStream(fileUrl)
      .pipe(parseOsmPbf())
      .on("data", (items) => {
        items.forEach((item) => {
          if (item.type !== "relation" || item.id !== relationId) return;
          (item.members || []).forEach((member) => {
            if (member.type === "way") roles.set(member.id, member.role || "outer");
          });
        });
      })
      .on("error", reject)
      .on("end", () => resolve(roles));
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

function buildCandidates({ pbf, metadata, roads, gaps, viewBounds, candidateRegex, radius, maxCandidates }) {
  const existingByOsm = groupBy(roads, (road) => String(road.osmId || road.id));
  const candidates = [];
  pbf.ways.forEach((way) => {
    const tags = way.tags || {};
    const highway = tags.highway || "";
    const rank = HIGHWAY_RANK[highway] || 0;
    const name = tags.name || "";
    const geoPoints = way.nodes.map((nodeId) => pbf.nodes.get(nodeId)).filter(Boolean);
    if (geoPoints.length < 2) return;
    const projected = geoPoints.map((point) => projectPoint(point, metadata.originalBbox, metadata.projectedBounds));
    const namedCandidate = candidateRegex.test(name);
    const elevated = isElevatedOrLink(tags, rank);
    const minGapDistance = gaps.length
      ? minDistanceToGaps(projected, gaps)
      : 0;
    if (!namedCandidate && !(minGapDistance <= radius && (rank >= 5 || elevated))) {
      return;
    }
    const parts = splitWayIntoCandidateParts(way, geoPoints, projected, viewBounds, gaps, radius, namedCandidate);
    parts.forEach((part) => {
      if (part.points.length < 2) return;
      const existing = classifyExistingPart(part.points, existingByOsm.get(String(way.id)) || []);
      const existingStatus = existing.status;
      if (existingStatus === "already-rendered" && !part.nearGap) return;
      const score = candidateScore({ tags, rank, namedCandidate, minGapDistance: part.minGapDistance, existingStatus });
      candidates.push({
        code: "",
        osmId: way.id,
        name,
        highway,
        rank,
        oneway: tags.oneway || "",
        layer: Number.parseInt(tags.layer || "0", 10) || 0,
        bridge: tags.bridge || "",
        tunnel: tags.tunnel || "",
        access: tags.access || "",
        service: tags.service || "",
        tags: keepRoadTags(tags),
        status: existingStatus,
        coverageRatio: existing.coverageRatio,
        endpointCoverage: existing.endpointCoverage,
        score,
        minGapDistance: round(part.minGapDistance, 2),
        nearGaps: part.nearGaps,
        reason: candidateReason({ name, tags, rank, namedCandidate, minGapDistance: part.minGapDistance, existingStatus }),
        nodeIds: part.nodeIds,
        points: part.points.map((point) => [round(point[0], 2), round(point[1], 2)]),
        lonlat: part.geoPoints.map((point) => [round(point.lon, 7), round(point.lat, 7)]),
        bbox: boundsFromPoints(part.points)
      });
    });
  });

  return candidates
    .sort((a, b) => b.score - a.score || a.minGapDistance - b.minGapDistance || String(a.osmId).localeCompare(String(b.osmId)))
    .slice(0, maxCandidates)
    .map((candidate, index) => ({ ...candidate, code: code("CAND", index) }));
}

function splitWayIntoCandidateParts(way, geoPoints, projected, viewBounds, gaps, radius, namedCandidate) {
  const parts = [];
  let current = null;
  for (let index = 0; index < projected.length - 1; index += 1) {
    const start = projected[index];
    const end = projected[index + 1];
    const segmentBounds = boundsFromPoints([start, end]);
    const minGapDistance = gaps.length ? minSegmentDistanceToGaps(start, end, gaps) : 0;
    const include = boundsOverlap(segmentBounds, viewBounds)
      || (minGapDistance <= radius)
      || (namedCandidate && pointInBounds(start, viewBounds));
    if (!include) {
      flush();
      continue;
    }
    const nearGaps = gaps
      .filter((gap) => pointToSegmentDistance([gap.x, gap.y], start, end) <= radius)
      .map((gap) => gap.code);
    if (!current) {
      current = {
        points: [start],
        geoPoints: [geoPoints[index]],
        nodeIds: [way.nodes[index]],
        minGapDistance,
        nearGap: minGapDistance <= radius,
        nearGaps: new Set(nearGaps)
      };
    }
    current.points.push(end);
    current.geoPoints.push(geoPoints[index + 1]);
    current.nodeIds.push(way.nodes[index + 1]);
    current.minGapDistance = Math.min(current.minGapDistance, minGapDistance);
    current.nearGap ||= minGapDistance <= radius;
    nearGaps.forEach((gapCode) => current.nearGaps.add(gapCode));
  }
  flush();
  return parts;

  function flush() {
    if (current && current.points.length > 1) {
      parts.push({
        ...current,
        nearGaps: Array.from(current.nearGaps)
      });
    }
    current = null;
  }
}

function buildContextRoads(roads, viewBounds, focusRegex) {
  const expanded = expandMapBounds(viewBounds, 40);
  const segments = [];
  roads.forEach((road) => {
    if (!road.points?.length || road.points.length < 2) return;
    const alwaysInclude = road.rank >= 6
      || road.supplemental
      || focusRegex.test(road.name || "");
    for (let index = 0; index < road.points.length - 1; index += 1) {
      const start = road.points[index];
      const end = road.points[index + 1];
      const bbox = boundsFromPoints([start, end]);
      if (!alwaysInclude && !boundsOverlap(bbox, expanded)) continue;
      if (!boundsOverlap(bbox, expanded)) continue;
      segments.push({
        code: "",
        source: "current-minhang",
        id: `${road.id}#${index}`,
        roadId: road.id,
        osmId: road.osmId,
        segmentIndex: index,
        name: road.name || "",
        highway: road.highway,
        rank: road.rank,
        oneway: road.oneway || "",
        layer: road.layer || 0,
        bridge: road.bridge || "",
        tunnel: road.tunnel || "",
        status: "in-current-minhang-map",
        supplemental: road.supplemental || "",
        nodeIds: [
          road.nodeIds?.[index] ?? "",
          road.nodeIds?.[index + 1] ?? ""
        ],
        points: [
          [round(start[0], 2), round(start[1], 2)],
          [round(end[0], 2), round(end[1], 2)]
        ],
        bbox: roundBounds(bbox)
      });
    }
  });
  return segments.map((segment, index) => ({ ...segment, code: code("MH", index, 5) }));
}

function buildReferenceRoads({ pbf, metadata, roads, viewBounds, referencePad, boundaryRecheckPad, boundaryRing, maxReferenceRoads }) {
  const existingByOsm = groupBy(roads, (road) => String(road.osmId || road.id));
  const expanded = expandMapBounds(viewBounds, referencePad);
  const referenceRoads = [];
  const audit = {
    segmentsSeenInBounds: 0,
    skippedAlreadyRendered: 0,
    skippedInteriorAlreadyRendered: 0,
    keptBoundaryCovered: 0,
    keptPartialOverlap: 0,
    keptSameOsmMissing: 0,
    keptNotInCurrentData: 0
  };
  pbf.ways.forEach((way) => {
    const tags = way.tags || {};
    const highway = tags.highway || "";
    const rank = HIGHWAY_RANK[highway] || 0;
    const geoPoints = way.nodes.map((nodeId) => pbf.nodes.get(nodeId)).filter(Boolean);
    if (geoPoints.length < 2) return;
    const projected = geoPoints.map((point) => projectPoint(point, metadata.originalBbox, metadata.projectedBounds));
    for (let index = 0; index < projected.length - 1; index += 1) {
      const start = projected[index];
      const end = projected[index + 1];
      const bbox = boundsFromPoints([start, end]);
      if (!boundsOverlap(bbox, expanded)) continue;
      audit.segmentsSeenInBounds += 1;
      const points = [start, end];
      const existing = classifyExistingPart(points, existingByOsm.get(String(way.id)) || []);
      let existingStatus = existing.status;
      if (existingStatus === "already-rendered") {
        if (nearOrOutsideBounds(bbox, metadata.projectedBounds, boundaryRecheckPad) || nearPolyline(points, boundaryRing, boundaryRecheckPad)) {
          existingStatus = "same-osm-way-boundary-covered";
          audit.keptBoundaryCovered += 1;
        } else {
          audit.skippedAlreadyRendered += 1;
          audit.skippedInteriorAlreadyRendered += 1;
          continue;
        }
      }
      if (existingStatus === "same-osm-way-partial-overlap") audit.keptPartialOverlap += 1;
      else if (existingStatus === "same-osm-way-missing-part") audit.keptSameOsmMissing += 1;
      else if (existingStatus === "not-in-current-data") audit.keptNotInCurrentData += 1;
      referenceRoads.push({
        code: "",
        source: "shanghai-pbf-missing",
        id: `${way.id}#${index}`,
        osmId: way.id,
        segmentIndex: index,
        name: tags.name || "",
        highway,
        rank,
        oneway: tags.oneway || "",
        layer: Number.parseInt(tags.layer || "0", 10) || 0,
        bridge: tags.bridge || "",
        tunnel: tags.tunnel || "",
        status: existingStatus,
        coverageRatio: existing.coverageRatio,
        endpointCoverage: existing.endpointCoverage,
        length: round(distancePoint(start, end), 2),
        nodeIds: [
          way.nodes[index] ?? "",
          way.nodes[index + 1] ?? ""
        ],
        points: [
          [round(start[0], 2), round(start[1], 2)],
          [round(end[0], 2), round(end[1], 2)]
        ],
        bbox: roundBounds(bbox)
      });
    }
  });

  const sorted = referenceRoads
    .sort((a, b) => {
      const statusScore = (item) => item.status === "same-osm-way-partial-overlap"
        ? 3
        : item.status === "same-osm-way-boundary-covered" ? 2
        : item.status === "same-osm-way-missing-part" ? 1 : 0;
      return statusScore(b) - statusScore(a)
        || b.rank - a.rank
        || b.length - a.length
        || String(a.name).localeCompare(String(b.name), "zh-Hans-CN")
        || String(a.osmId).localeCompare(String(b.osmId));
    });
  const limited = maxReferenceRoads > 0
    ? sorted.slice(0, maxReferenceRoads)
    : sorted;
  return {
    roads: limited.map((road, index) => ({ ...road, code: code("SH", index, 5) })),
    audit
  };
}

function classifyExistingPart(points, existingRoads) {
  if (!existingRoads.length) {
    return { status: "not-in-current-data", coverageRatio: 0, endpointCoverage: 0 };
  }
  const coverage = existingCoverage(points, existingRoads);
  if (coverage.coverageRatio >= 0.86 && coverage.endpointCoverage === 2) {
    return { status: "already-rendered", ...coverage };
  }
  if (coverage.coveredSamples > 0) {
    return { status: "same-osm-way-partial-overlap", ...coverage };
  }
  return { status: "same-osm-way-missing-part", ...coverage };
}

function existingCoverage(points, existingRoads) {
  const samples = samplePolyline(points, EXISTING_COVERAGE_SAMPLES);
  const distances = samples.map((point) => pointDistanceToExistingRoads(point, existingRoads));
  const coveredSamples = distances.filter((distance) => distance <= EXISTING_COVERAGE_TOLERANCE).length;
  const endpointCoverage = [
    points[0],
    points[points.length - 1]
  ].filter((point) => pointDistanceToExistingRoads(point, existingRoads) <= EXISTING_COVERAGE_TOLERANCE).length;
  return {
    coverageRatio: round(coveredSamples / Math.max(1, samples.length), 2),
    coveredSamples,
    sampleCount: samples.length,
    endpointCoverage,
    minDistance: round(Math.min(...distances), 2),
    maxDistance: round(Math.max(...distances), 2)
  };
}

function pointDistanceToExistingRoads(point, existingRoads) {
  let best = Infinity;
  existingRoads.forEach((road) => {
    best = Math.min(best, pointDistanceToPolyline(point, road.points || []));
  });
  return best;
}

function pointDistanceToPolyline(point, points) {
  if (points.length < 2) return Infinity;
  let best = Infinity;
  for (let index = 0; index < points.length - 1; index += 1) {
    best = Math.min(best, pointToSegmentDistance(point, points[index], points[index + 1]));
  }
  return best;
}

function samplePolyline(points, sampleCount) {
  if (points.length < 2) return points.slice();
  const totalLength = polylineLength(points);
  if (!totalLength) return [points[0]];
  const samples = [];
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    samples.push(pointAtPolylineDistance(points, (totalLength * sampleIndex) / (sampleCount - 1)));
  }
  return samples;
}

function pointAtPolylineDistance(points, targetDistance) {
  let walked = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const segmentLength = distancePoint(start, end);
    if (walked + segmentLength >= targetDistance) {
      const ratio = segmentLength ? (targetDistance - walked) / segmentLength : 0;
      return [
        start[0] + (end[0] - start[0]) * ratio,
        start[1] + (end[1] - start[1]) * ratio
      ];
    }
    walked += segmentLength;
  }
  return points[points.length - 1];
}

function candidateScore({ tags, rank, namedCandidate, minGapDistance, existingStatus }) {
  let score = rank * 6;
  const name = tags.name || "";
  if (/沪闵/.test(name)) score += 120;
  if (/沪昆|沪渝/.test(name)) score += 90;
  if (/金都|银都/.test(name)) score += 55;
  if (namedCandidate) score += 35;
  if (isElevatedOrLink(tags, rank)) score += 35;
  score += Math.max(0, 80 - minGapDistance);
  if (existingStatus === "same-osm-way-partial-overlap") score += 38;
  if (existingStatus === "same-osm-way-missing-part") score += 30;
  if (existingStatus === "not-in-current-data") score += 12;
  if (existingStatus === "already-rendered") score -= 70;
  return round(score, 2);
}

function candidateReason({ name, tags, rank, namedCandidate, minGapDistance, existingStatus }) {
  const parts = [];
  if (name) parts.push(`name:${name}`);
  if (namedCandidate) parts.push("matches candidate name filter");
  if (minGapDistance < 9999) parts.push(`near focus gap ${round(minGapDistance, 1)}px`);
  if (isElevatedOrLink(tags, rank)) parts.push("elevated/link/high-rank");
  parts.push(existingStatus);
  return parts.join("; ");
}

function isElevatedOrLink(tags, rank) {
  return rank >= 7
    || /_link$/.test(tags.highway || "")
    || tags.bridge === "yes"
    || tags.bridge === "viaduct"
    || tags.tunnel === "yes"
    || tags.layer !== undefined;
}

function boundsAroundGaps(gaps, fallbackBounds) {
  if (!gaps.length) {
    return {
      minX: fallbackBounds.minX,
      minY: fallbackBounds.minY,
      maxX: fallbackBounds.maxX,
      maxY: fallbackBounds.maxY
    };
  }
  const bounds = boundsFromPoints(gaps.map((gap) => [gap.x, gap.y]));
  return expandMapBounds(bounds, 230);
}

function parseMapBounds(value) {
  const parts = value.split(",").map((item) => Number.parseFloat(item.trim()));
  if (parts.length !== 4 || parts.some((item) => Number.isNaN(item))) {
    throw new Error("--map-bounds expects minX,minY,maxX,maxY");
  }
  return { minX: parts[0], minY: parts[1], maxX: parts[2], maxY: parts[3] };
}

function projectPoint(point, bbox, bounds) {
  const x = bounds.minX + ((point.lon - bbox.minlon) / (bbox.maxlon - bbox.minlon)) * (bounds.maxX - bounds.minX);
  const y = bounds.maxY - ((point.lat - bbox.minlat) / (bbox.maxlat - bbox.minlat)) * (bounds.maxY - bounds.minY);
  return [x, y];
}

function isBoundaryNode(routeGraph, nodeIndex) {
  return Boolean((routeGraph.nodes[nodeIndex]?.[6] || 0) & 1);
}

function minDistanceToGaps(points, gaps) {
  let minDistance = Infinity;
  for (let index = 0; index < points.length - 1; index += 1) {
    minDistance = Math.min(minDistance, minSegmentDistanceToGaps(points[index], points[index + 1], gaps));
  }
  return minDistance;
}

function minSegmentDistanceToGaps(start, end, gaps) {
  let minDistance = Infinity;
  gaps.forEach((gap) => {
    minDistance = Math.min(minDistance, pointToSegmentDistance([gap.x, gap.y], start, end));
  });
  return minDistance;
}

function minPolylineDistance(points, otherPoints) {
  if (points.length < 2 || otherPoints.length < 2) return Infinity;
  let minDistance = Infinity;
  for (let index = 0; index < points.length; index += 1) {
    for (let otherIndex = 0; otherIndex < otherPoints.length - 1; otherIndex += 1) {
      minDistance = Math.min(minDistance, pointToSegmentDistance(points[index], otherPoints[otherIndex], otherPoints[otherIndex + 1]));
    }
  }
  return minDistance;
}

function polylineOverlapsBounds(points, bounds) {
  for (let index = 0; index < points.length - 1; index += 1) {
    if (boundsOverlap(boundsFromPoints([points[index], points[index + 1]]), bounds)) return true;
  }
  return false;
}

function pointToSegmentDistance(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSq = dx * dx + dy * dy;
  if (!lengthSq) return distancePoint(point, start);
  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSq));
  return distancePoint(point, [start[0] + dx * t, start[1] + dy * t]);
}

function distancePoint(first, second) {
  return Math.hypot(first[0] - second[0], first[1] - second[1]);
}

function polylineLength(points) {
  let length = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    length += distancePoint(points[index], points[index + 1]);
  }
  return length;
}

function averagePoints(points) {
  const sum = points.reduce((acc, point) => [acc[0] + point[0], acc[1] + point[1]], [0, 0]);
  return [sum[0] / points.length, sum[1] / points.length];
}

function boundsFromPoints(points) {
  return points.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point[0]),
    minY: Math.min(bounds.minY, point[1]),
    maxX: Math.max(bounds.maxX, point[0]),
    maxY: Math.max(bounds.maxY, point[1])
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

function roundBounds(bounds) {
  return {
    minX: round(bounds.minX, 2),
    minY: round(bounds.minY, 2),
    maxX: round(bounds.maxX, 2),
    maxY: round(bounds.maxY, 2)
  };
}

function expandMapBounds(bounds, amount) {
  return {
    minX: bounds.minX - amount,
    minY: bounds.minY - amount,
    maxX: bounds.maxX + amount,
    maxY: bounds.maxY + amount
  };
}

function clampBounds(bounds, limit) {
  return {
    minX: Math.max(limit.minX, bounds.minX),
    minY: Math.max(limit.minY, bounds.minY),
    maxX: Math.min(limit.maxX, bounds.maxX),
    maxY: Math.min(limit.maxY, bounds.maxY)
  };
}

function boundsOverlap(first, second) {
  return first.minX <= second.maxX
    && first.maxX >= second.minX
    && first.minY <= second.maxY
    && first.maxY >= second.minY;
}

function pointInBounds(point, bounds) {
  return point[0] >= bounds.minX && point[0] <= bounds.maxX && point[1] >= bounds.minY && point[1] <= bounds.maxY;
}

function nearOrOutsideBounds(bbox, bounds, pad) {
  return bbox.minX <= bounds.minX + pad
    || bbox.minY <= bounds.minY + pad
    || bbox.maxX >= bounds.maxX - pad
    || bbox.maxY >= bounds.maxY - pad;
}

function nearPolyline(points, targetPolyline, pad) {
  if (!targetPolyline?.length) return false;
  return samplePolyline(points, EXISTING_COVERAGE_SAMPLES)
    .some((point) => pointDistanceToPolyline(point, targetPolyline) <= pad);
}

function keepRoadTags(tags) {
  const keys = ["highway", "name", "oneway", "junction", "access", "vehicle", "motor_vehicle", "motorcar", "service", "bridge", "tunnel", "layer", "area"];
  const result = {};
  keys.forEach((key) => {
    if (tags[key] !== undefined) result[key] = tags[key];
  });
  return result;
}

function groupBy(items, keyFn) {
  const result = new Map();
  items.forEach((item) => {
    const key = keyFn(item);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(item);
  });
  return result;
}

function countBy(items, keyFn) {
  const result = {};
  items.forEach((item) => {
    const key = keyFn(item) || "unknown";
    result[key] = (result[key] || 0) + 1;
  });
  return result;
}

function unique(items) {
  return Array.from(new Set(items));
}

function code(prefix, index, digits = 3) {
  return `${prefix}-${String(index + 1).padStart(digits, "0")}`;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function buildHtml(data) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Topology Gap Inspector</title>
  <style>
    :root { color-scheme: light; font-family: Arial, "Microsoft YaHei", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; display: grid; grid-template-columns: minmax(620px, 1fr) 420px; height: 100vh; color: #17202a; background: #eef2f6; }
    #stage { position: relative; min-width: 0; min-height: 0; background: #f8fafc; }
    #map { width: 100%; height: 100%; display: block; cursor: crosshair; }
    #map.dragging { cursor: grabbing; }
    #toolbar { position: absolute; left: 14px; top: 14px; display: flex; align-items: center; gap: 6px; padding: 7px; border: 1px solid rgba(15, 23, 42, .12); border-radius: 6px; background: rgba(255,255,255,.9); box-shadow: 0 10px 28px rgba(15, 23, 42, .12); }
    #tooltip { position: absolute; left: 0; top: 0; max-width: 320px; padding: 7px 9px; border: 1px solid rgba(15,23,42,.14); border-radius: 6px; background: rgba(255,255,255,.96); box-shadow: 0 10px 28px rgba(15,23,42,.16); font-size: 12px; line-height: 1.45; color: #17202a; pointer-events: none; transform: translate(-9999px, -9999px); }
    aside { overflow: auto; border-left: 1px solid #d7e0ea; background: #fff; padding: 16px; }
    h1 { font-size: 18px; margin: 0 0 8px; }
    h2 { font-size: 15px; margin: 16px 0 6px; }
    .meta { font-size: 12px; color: #5d6b7a; line-height: 1.5; margin-bottom: 12px; }
    .legend { display: grid; grid-template-columns: 1fr 1fr; gap: 7px 10px; margin: 10px 0 12px; font-size: 12px; color: #475569; }
    .legend span { display: inline-flex; align-items: center; gap: 7px; min-width: 0; }
    .swatch { width: 28px; height: 0; border-top: 3px solid #758397; flex: none; }
    .swatch.current { border-top-color: rgba(14,116,144,.86); }
    .swatch.missing { border-top-color: rgba(15,23,42,.20); }
    .swatch.partial { border-top-color: rgba(88,28,135,.36); }
    .swatch.candidate { border-top-color: rgba(217,119,6,.72); }
    .swatch.included { border-top-color: rgba(22,128,84,.82); }
    .swatch.boundary { border-top-color: rgba(220,38,38,.42); }
    .swatch.gap { width: 11px; height: 11px; border: 2px solid #fff; border-radius: 50%; background: #dc2626; box-shadow: 0 0 0 1px rgba(15,23,42,.2); }
    .item { border: 1px solid #e1e7ee; border-radius: 6px; padding: 10px; margin: 8px 0; background: #fff; cursor: pointer; }
    .item.active { border-color: #d97706; box-shadow: 0 0 0 2px rgba(217,119,6,.16); }
    .code { font-weight: 700; font-family: Consolas, "Microsoft YaHei", monospace; }
    .small { font-size: 12px; color: #506070; line-height: 1.45; }
    .detail { min-height: 86px; border: 1px solid #e1e7ee; border-radius: 6px; padding: 10px; background: #f8fafc; font-size: 12px; line-height: 1.55; color: #334155; }
    button { border: 1px solid #b8c3cf; background: #fff; border-radius: 5px; padding: 5px 8px; margin: 0; cursor: pointer; color: #17202a; }
    button.active { border-color: #2563eb; background: #eff6ff; color: #1d4ed8; }
    button:disabled { opacity: .44; cursor: not-allowed; }
    button.confirm { border-color: #7e22ce; color: #581c87; }
    button.cancel { border-color: #94a3b8; color: #334155; }
    button.include { border-color: #168054; color: #0f6844; }
    button.apply { border-color: #0f766e; color: #0f766e; }
    button.need { border-color: #1d9a65; color: #0d7048; margin-top: 7px; margin-right: 4px; }
    button.no { border-color: #d33b3b; color: #a12424; margin-top: 7px; }
    textarea { width: 100%; min-height: 74px; box-sizing: border-box; font-family: Consolas, monospace; font-size: 12px; margin-top: 8px; border: 1px solid #d6dee8; border-radius: 6px; padding: 8px; resize: vertical; }
  </style>
</head>
<body>
  <main id="stage">
    <canvas id="map"></canvas>
    <div id="toolbar">
      <button id="zoomOut" type="button">-</button>
      <button id="resetView" type="button">1:1</button>
      <button id="zoomIn" type="button">+</button>
      <button id="modeSelect" type="button">选择</button>
      <button id="modeLink" type="button">端点修补</button>
      <button id="modeBan" type="button">禁行框</button>
      <button id="confirmLink" class="confirm" type="button" disabled>&#x786E;&#x8BA4;&#x8FDE;&#x63A5;</button>
      <button id="cancelLink" class="cancel" type="button" disabled>&#x53D6;&#x6D88;&#x8FDE;&#x63A5;</button>
      <button id="confirmReference" class="include" type="button" disabled>&#x786E;&#x8BA4;&#x7EB3;&#x5165;</button>
      <button id="cancelReference" class="cancel" type="button" disabled>&#x53D6;&#x6D88;&#x5019;&#x9009;</button>
      <button id="applyIndex" class="apply" type="button">&#x5E94;&#x7528;&#x5230;Index</button>
      <span class="meta" id="zoomLabel" style="margin:0 0 0 4px;"></span>
    </div>
    <div id="tooltip"></div>
  </main>
  <aside>
    <h1>拓扑断点检查</h1>
    <div class="meta" id="summary"></div>
    <div class="legend">
      <span><i class="swatch current"></i>当前闵行图实线</span>
      <span><i class="swatch missing"></i>上海 PBF 未纳入暗线</span>
      <span><i class="swatch partial"></i>边界局部重叠</span>
      <span><i class="swatch boundary"></i>真实闵行边界</span>
      <span><i class="swatch candidate"></i>候选片段</span>
      <span><i class="swatch included"></i>确认纳入实线</span>
      <span><i class="swatch gap"></i>断点</span>
    </div>
    <div class="detail" id="details"></div>
    <div>
      <button id="clear">清空选择</button>
      <textarea id="selection" readonly></textarea>
    </div>
    <h2>断点</h2>
    <div id="gaps"></div>
    <h2>候选片段</h2>
    <div id="candidates"></div>
  </aside>
  <script>
    const DATA_URL = 'topology-gap-debug.json';
    document.getElementById('summary').textContent = '正在加载 topology-gap-debug.json ...';
    fetch(DATA_URL)
      .then((response) => {
        if (!response.ok) throw new Error('Cannot load ' + DATA_URL + ': ' + response.status);
        return response.json();
      })
      .then(init)
      .catch((error) => {
        document.getElementById('summary').textContent = '数据加载失败：' + error.message;
        document.getElementById('details').textContent = '请通过本地 HTTP 打开，例如 http://127.0.0.1:5500/test-results/topology-gap-debug.html';
        console.error(error);
      });

    function init(data) {
    const canvas = document.getElementById('map');
    const ctx = canvas.getContext('2d');
    const stage = document.getElementById('stage');
    const tooltip = document.getElementById('tooltip');
    const details = document.getElementById('details');
    const zoomLabel = document.getElementById('zoomLabel');
    const need = new Set();
    const no = new Set();
    const includeMissing = new Set();
    const manualLinks = [];
    const banAreas = [];
    const contextRoads = data.contextRoads.slice().sort((a, b) => a.rank - b.rank);
    const referenceRoads = data.referenceRoads || [];
    const boundaryRing = data.boundaryRing || [];
    const allSegments = contextRoads.concat(referenceRoads);
    const annotationStorageKey = 'topology-gap-debug:annotations:' + (data.pbf || 'default');
    let applyInFlight = false;
    let selected = null;
    let hover = null;
    let mode = 'select';
    let pendingReference = null;
    let pendingEndpoint = null;
    let draftLink = null;
    let linkPreviewPoint = null;
    let draftBan = null;
    let baseScale = 1;
    let dpr = 1;
    const bounds = data.view.bounds;
    const view = { scale: 1, x: 0, y: 0 };
    const drag = { active: false, moved: false, x: 0, y: 0 };
    const referenceAudit = data.summary.referenceAudit || {};
    document.getElementById('summary').textContent =
      'GAP ' + data.summary.focusGaps + ' / CAND ' + data.summary.candidates +
      ' / SH ' + data.summary.referenceRoads +
      ' / partial ' + (referenceAudit.keptPartialOverlap || 0) +
      ' / boundary ' + (referenceAudit.keptBoundaryCovered || 0) +
      ' / covered-skip ' + (referenceAudit.skippedAlreadyRendered || 0) +
      ' / 当前实线 ' + data.summary.contextRoads +
      ' / ' + data.pbf;

    function card(container, item, type) {
      const div = document.createElement('div');
      div.className = 'item';
      div.id = 'card-' + item.code;
      const title = document.createElement('div');
      title.innerHTML = '<span class="code">' + item.code + '</span> ' + (item.name || (item.names || []).join(' / ') || '');
      const info = document.createElement('div');
      info.className = 'small';
      info.textContent = type === 'gap'
        ? 'edges=' + item.edgeCount + ' / ' + (item.highways || []).join(', ')
        : item.highway + ' rank=' + item.rank + ' status=' + item.status + ' / ' + item.reason;
      div.appendChild(title);
      div.appendChild(info);
      if (type === 'candidate') {
        const needButton = document.createElement('button');
        needButton.className = 'need';
        needButton.textContent = '需要';
        needButton.onclick = () => mark(item.code, 'need');
        const noButton = document.createElement('button');
        noButton.className = 'no';
        noButton.textContent = '不要';
        noButton.onclick = () => mark(item.code, 'no');
        div.appendChild(needButton);
        div.appendChild(noButton);
      }
      div.onclick = (event) => {
        if (event.target.tagName !== 'BUTTON') selectItem({ type, item });
      };
      container.appendChild(div);
    }

    data.gaps.forEach((item) => card(document.getElementById('gaps'), item, 'gap'));
    data.candidates.forEach((item) => card(document.getElementById('candidates'), item, 'candidate'));
    document.getElementById('clear').onclick = () => {
      need.clear();
      no.clear();
      includeMissing.clear();
      manualLinks.length = 0;
      banAreas.length = 0;
      pendingReference = null;
      pendingEndpoint = null;
      draftLink = null;
      linkPreviewPoint = null;
      draftBan = null;
      clearSavedAnnotations();
      updateReferenceButtons();
      updateLinkButtons();
      updateSelection();
    };
    document.getElementById('zoomIn').onclick = () => zoomAtCenter(1.35);
    document.getElementById('zoomOut').onclick = () => zoomAtCenter(1 / 1.35);
    document.getElementById('resetView').onclick = fitView;
    document.getElementById('modeSelect').onclick = () => setMode('select');
    document.getElementById('modeLink').onclick = () => setMode('link');
    document.getElementById('modeBan').onclick = () => setMode('ban');
    document.getElementById('confirmLink').onclick = confirmDraftLink;
    document.getElementById('cancelLink').onclick = cancelDraftLink;
    document.getElementById('confirmReference').onclick = confirmReferenceCandidate;
    document.getElementById('cancelReference').onclick = cancelReferenceCandidate;
    document.getElementById('applyIndex').onclick = applyAnnotationsToIndex;
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', resize);
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    canvas.addEventListener('pointerdown', handlePointerDown);
    canvas.addEventListener('pointermove', handlePointerMove);
    canvas.addEventListener('pointerup', handlePointerUp);
    canvas.addEventListener('pointerleave', () => {
      hover = null;
      if (!draftLink) linkPreviewPoint = null;
      hideTooltip();
      draw();
    });

    function setMode(nextMode) {
      mode = nextMode;
      pendingReference = null;
      pendingEndpoint = null;
      draftLink = null;
      linkPreviewPoint = null;
      draftBan = null;
      document.getElementById('modeSelect').classList.toggle('active', mode === 'select');
      document.getElementById('modeLink').classList.toggle('active', mode === 'link');
      document.getElementById('modeBan').classList.toggle('active', mode === 'ban');
      updateReferenceButtons();
      updateLinkButtons();
      details.textContent = mode === 'link'
        ? '\u7aef\u70b9\u4fee\u8865\uff1a\u5148\u70b9\u7b2c\u4e00\u4e2a\u7aef\u70b9\uff0c\u518d\u79fb\u52a8\u6216\u70b9\u51fb\u7b2c\u4e8c\u4e2a\u7aef\u70b9\u9884\u89c8\u8fde\u7ebf\uff1b\u786e\u8ba4\u540e\u624d\u4f1a\u5199\u5165 MANUAL_LINKS\u3002'
        : mode === 'ban'
          ? '禁行框：在地图上拖出矩形，车辆禁入区域会写入标注结果。'
          : '\u70b9\u51fb\u672a\u7eb3\u5165\u6697\u7ebf\u4f1a\u5148\u8fdb\u5165\u5b9e\u7ebf\u5019\u9009\uff1b\u70b9\u201c\u786e\u8ba4\u7eb3\u5165\u201d\u540e\u624d\u5199\u5165 INCLUDE_MISSING\u3002hover \u53ef\u770b\u8def\u540d\u3002';
      draw();
    }

    function updateLinkButtons() {
      const hasDraft = Boolean(draftLink);
      const hasPending = Boolean(pendingEndpoint);
      document.getElementById('confirmLink').disabled = !hasDraft;
      document.getElementById('cancelLink').disabled = !(hasDraft || hasPending);
    }

    function updateReferenceButtons() {
      document.getElementById('confirmReference').disabled = !pendingReference;
      document.getElementById('cancelReference').disabled = !pendingReference;
    }

    function saveAnnotations() {
      try {
        localStorage.setItem(annotationStorageKey, JSON.stringify(annotationPayload()));
      } catch (error) {
        console.warn('Cannot save topology annotations', error);
      }
    }

    function annotationPayload() {
      const includeItems = Array.from(includeMissing).map((item) => {
        const road = referenceRoads.find((candidate) => candidate.code === item);
        return road
          ? { code: item, osmId: String(road.osmId), segmentIndex: road.segmentIndex }
          : { code: item };
      });
      return {
        version: 2,
        savedAt: new Date().toISOString(),
        pbf: data.pbf,
        includeMissing: includeItems,
        candidateAdd: Array.from(need),
        candidateNo: Array.from(no),
        manualLinks: manualLinks.slice(),
        banAreas: banAreas.slice()
      };
    }

    function loadSavedAnnotations() {
      try {
        const raw = localStorage.getItem(annotationStorageKey);
        if (!raw) return;
        const saved = JSON.parse(raw);
        (saved.candidateAdd || []).forEach((item) => {
          if (data.candidates.some((candidate) => candidate.code === item)) need.add(item);
        });
        (saved.candidateNo || []).forEach((item) => {
          if (data.candidates.some((candidate) => candidate.code === item)) no.add(item);
        });
        (saved.includeMissing || []).forEach((item) => {
          const resolved = resolveReferenceCode(item);
          if (resolved) includeMissing.add(resolved);
        });
        (saved.manualLinks || []).forEach((link) => {
          if (link?.from && link?.to && Number.isFinite(link.from.x) && Number.isFinite(link.to.x)) {
            manualLinks.push({ code: link.code || code('LINK', manualLinks.length), from: link.from, to: link.to });
          }
        });
        (saved.banAreas || []).forEach((area) => {
          if ([area?.minX, area?.minY, area?.maxX, area?.maxY].every(Number.isFinite)) {
            banAreas.push({ code: area.code || code('BAN', banAreas.length), minX: area.minX, minY: area.minY, maxX: area.maxX, maxY: area.maxY });
          }
        });
      } catch (error) {
        console.warn('Cannot restore topology annotations', error);
      }
    }

    function resolveReferenceCode(saved) {
      if (!saved) return '';
      if (typeof saved === 'string') {
        return referenceRoads.some((road) => road.code === saved) ? saved : '';
      }
      const byCode = referenceRoads.find((road) => road.code === saved.code);
      if (byCode) return byCode.code;
      const byOsmSegment = referenceRoads.find((road) => (
        String(road.osmId) === String(saved.osmId) && Number(road.segmentIndex) === Number(saved.segmentIndex)
      ));
      return byOsmSegment?.code || '';
    }

    function clearSavedAnnotations() {
      try {
        localStorage.removeItem(annotationStorageKey);
      } catch (error) {
        console.warn('Cannot clear topology annotations', error);
      }
    }

    async function applyAnnotationsToIndex() {
      if (applyInFlight) return;
      const button = document.getElementById('applyIndex');
      const previousText = button.textContent;
      applyInFlight = true;
      button.disabled = true;
      button.textContent = '\u6b63\u5728\u5e94\u7528...';
      saveAnnotations();
      try {
        const payload = annotationPayload();
        const response = await postAnnotations(payload);
        details.textContent = '\u5df2\u5e94\u7528\u5230 Index\uff1a\u5199\u5165 ' + response.includeMissing + ' \u6bb5\u7eb3\u5165\u8def\uff0c' + response.manualLinks + ' \u6761\u624b\u52a8\u8fde\u63a5\uff1b\u603b roads=' + response.roads + '\u3002\u5237\u65b0 index.html \u53ef\u770b\u5230\u65b0\u8def\u7f51\u3002';
      } catch (error) {
        details.textContent = '\u5e94\u7528\u5230 Index \u5931\u8d25\uff1a' + error.message + '\u3002\u8bf7\u7528 node tools/topology-gap-annotation-server.mjs \u6253\u5f00\u5e26\u5199\u5165\u80fd\u529b\u7684\u672c\u5730\u670d\u52a1\u3002';
        console.error(error);
      } finally {
        applyInFlight = false;
        button.disabled = false;
        button.textContent = previousText;
      }
    }

    async function postAnnotations(payload) {
      const endpoints = [
        '/api/topology-annotations/apply',
        'http://127.0.0.1:5510/api/topology-annotations/apply'
      ];
      let lastError = null;
      for (const endpoint of endpoints) {
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          if (!response.ok) throw new Error(endpoint + ' HTTP ' + response.status);
          const result = await response.json();
          if (!result.ok) throw new Error(result.error || 'apply failed');
          return result.result;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error('cannot reach apply API');
    }

    function mark(code, kind) {
      if (kind === 'need') {
        no.delete(code);
        need.has(code) ? need.delete(code) : need.add(code);
      } else {
        need.delete(code);
        no.has(code) ? no.delete(code) : no.add(code);
      }
      updateSelection();
      const item = data.candidates.find((candidate) => candidate.code === code);
      if (item) selectItem({ type: 'candidate', item });
    }
    function updateSelection() {
      const includeLines = Array.from(includeMissing)
        .map((item) => {
          const road = referenceRoads.find((candidate) => candidate.code === item);
          return road ? item + ' osm=' + road.osmId + ' seg=' + road.segmentIndex + ' name=' + displayName(road) : item;
        });
      const linkLines = manualLinks.map((link) => (
        link.code + ' ' + link.from.code + ':' + link.from.end + ' -> ' + link.to.code + ':' + link.to.end +
        ' [' + round(link.from.x, 2) + ',' + round(link.from.y, 2) + '] -> [' + round(link.to.x, 2) + ',' + round(link.to.y, 2) + ']'
      ));
      const banLines = banAreas.map((area) => (
        area.code + ' minX=' + round(area.minX, 2) + ' minY=' + round(area.minY, 2) +
        ' maxX=' + round(area.maxX, 2) + ' maxY=' + round(area.maxY, 2)
      ));
      document.getElementById('selection').value =
        'INCLUDE_MISSING:\\n' + (includeLines.join('\\n') || '-') + '\\n\\n' +
        'CANDIDATE_ADD: ' + (Array.from(need).join(' ') || '-') + '\\n' +
        'CANDIDATE_NO: ' + (Array.from(no).join(' ') || '-') + '\\n\\n' +
        'MANUAL_LINKS:\\n' + (linkLines.join('\\n') || '-') + '\\n\\n' +
        'BAN_AREAS:\\n' + (banLines.join('\\n') || '-');
      saveAnnotations();
      draw();
    }

    function selectItem(target, options = {}) {
      selected = target;
      if (target.type === 'reference' && options.prepareReference !== false) {
        pendingReference = includeMissing.has(target.item.code) ? null : target.item.code;
        updateReferenceButtons();
      } else if (target.type !== 'reference') {
        pendingReference = null;
        updateReferenceButtons();
      }
      document.querySelectorAll('.item.active').forEach((node) => node.classList.remove('active'));
      const code = target.item.code;
      document.getElementById('card-' + code)?.classList.add('active');
      document.getElementById('card-' + code)?.scrollIntoView({ block: 'nearest' });
      showDetails(target);
      draw();
    }

    function showDetails(target) {
      const item = target.item;
      details.textContent = '';
      const lines = [];
      if (target.type === 'gap') {
        lines.push(item.code + '  ' + (item.names || []).join(' / '));
        lines.push('highway: ' + (item.highways || []).join(', ') + ' / endpoints: ' + item.edgeCount);
        lines.push('xy: ' + item.x + ', ' + item.y);
      } else if (target.type === 'endpoint') {
        lines.push(item.code + ':' + target.end + '  ' + displayName(item));
        lines.push('endpoint xy: ' + round(target.x, 2) + ', ' + round(target.y, 2));
        lines.push('OSM way: ' + item.osmId + ' / seg ' + item.segmentIndex + ' / ' + item.highway + ' / ' + item.status);
        if (draftLink) {
          lines.push('\u8fde\u63a5\u9884\u89c8\u5df2\u751f\u6210\uff1a\u70b9\u201c\u786e\u8ba4\u8fde\u63a5\u201d\u5199\u5165 MANUAL_LINKS\uff0c\u6216\u70b9\u201c\u53d6\u6d88\u8fde\u63a5\u201d\u91cd\u9009\u3002');
        } else if (pendingEndpoint) {
          lines.push('\u5df2\u9009\u7b2c\u4e00\u4e2a\u7aef\u70b9\uff1a\u79fb\u52a8\u5230\u7b2c\u4e8c\u4e2a\u7aef\u70b9\u4f1a\u9884\u89c8\u8fde\u7ebf\uff0c\u70b9\u51fb\u540e\u518d\u786e\u8ba4\u3002');
        } else {
          lines.push('\u70b9\u51fb\u8fd9\u4e2a\u7aef\u70b9\u4f5c\u4e3a\u8d77\u70b9\uff0c\u7136\u540e\u9009\u7b2c\u4e8c\u4e2a\u7aef\u70b9\u9884\u89c8\u4fee\u8865\u8fde\u63a5\u3002');
        }
      } else {
        lines.push(item.code + '  ' + displayName(item));
        lines.push('OSM way: ' + item.osmId + ' / seg ' + (item.segmentIndex ?? '-') + ' / ' + item.highway + ' / rank ' + item.rank + ' / ' + item.status);
        if (item.coverageRatio !== undefined) {
          lines.push('coverage in current: ' + Math.round(item.coverageRatio * 100) + '% / endpoints ' + (item.endpointCoverage ?? 0) + '/2');
        }
        if (target.type === 'reference') {
          if (includeMissing.has(item.code)) {
            lines.push('\u5df2\u786e\u8ba4\u7eb3\u5165\uff1a\u8be5\u6bb5\u4ee5\u5b9e\u7ebf\u6837\u5f0f\u663e\u793a\uff0c\u5e76\u5199\u5165 INCLUDE_MISSING\u3002');
          } else if (pendingReference === item.code) {
            lines.push('\u5df2\u8fdb\u5165\u5b9e\u7ebf\u5019\u9009\uff1a\u70b9\u201c\u786e\u8ba4\u7eb3\u5165\u201d\u540e\u624d\u4f1a\u5199\u5165 INCLUDE_MISSING\uff0c\u70b9\u201c\u53d6\u6d88\u5019\u9009\u201d\u53ef\u64a4\u56de\u3002');
          } else {
            lines.push('\u672a\u7eb3\u5165\u6697\u7ebf\uff1a\u70b9\u51fb\u540e\u5148\u8fdb\u5165\u5b9e\u7ebf\u5019\u9009\uff0c\u9700\u518d\u786e\u8ba4\u624d\u4f1a\u5199\u5165 INCLUDE_MISSING\u3002');
          }
        }
        if (item.layer || item.bridge || item.tunnel) lines.push('layer: ' + item.layer + ' / bridge: ' + (item.bridge || '-') + ' / tunnel: ' + (item.tunnel || '-'));
        if (item.nearGaps?.length) lines.push('near: ' + item.nearGaps.join(', '));
        if (item.nodeIds?.length) lines.push('nodes: ' + item.nodeIds.join(' -> '));
      }
      lines.forEach((line) => {
        const div = document.createElement('div');
        div.textContent = line;
        details.appendChild(div);
      });
    }

    function fitView() {
      const rect = canvas.getBoundingClientRect();
      const pad = 26;
      const width = Math.max(1, bounds.maxX - bounds.minX);
      const height = Math.max(1, bounds.maxY - bounds.minY);
      baseScale = Math.min((rect.width - pad * 2) / width, (rect.height - pad * 2) / height);
      if (!Number.isFinite(baseScale) || baseScale <= 0) baseScale = 1;
      view.scale = baseScale;
      view.x = pad - bounds.minX * view.scale + (rect.width - pad * 2 - width * view.scale) / 2;
      view.y = pad - bounds.minY * view.scale + (rect.height - pad * 2 - height * view.scale) / 2;
      draw();
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.max(1, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      fitView();
    }

    function draw() {
      if (!canvas.width || !canvas.height) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y);

      const visible = visibleWorldBounds();
      drawGrid(visible);
      drawBoundaryRing();
      contextRoads.forEach((road) => {
        if (boundsOverlap(road.bbox, visible)) drawContextRoad(road);
      });
      referenceRoads.forEach((road) => {
        if (boundsOverlap(road.bbox, visible)) drawReferenceRoad(road);
      });
      data.candidates.forEach(drawCandidate);
      drawManualLinks();
      drawDraftLink();
      drawBanAreas();
      if (mode === 'link' && view.scale / baseScale >= 2.2) drawEndpoints(visible);
      if (draftBan) drawBanRect(draftBan, true);
      data.gaps.forEach(drawGap);
      if (hover) drawTarget(hover, '#0ea5e9', 4.6, false);
      if (selected) drawTarget(selected, '#f59e0b', 5.8, true);

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      zoomLabel.textContent = Math.round(view.scale / baseScale * 100) + '%';
    }

    function drawGrid(visible) {
      const step = 100;
      ctx.strokeStyle = 'rgba(148,163,184,.18)';
      ctx.lineWidth = 1 / view.scale;
      ctx.setLineDash([]);
      ctx.beginPath();
      for (let x = Math.floor(visible.minX / step) * step; x <= visible.maxX; x += step) {
        ctx.moveTo(x, visible.minY);
        ctx.lineTo(x, visible.maxY);
      }
      for (let y = Math.floor(visible.minY / step) * step; y <= visible.maxY; y += step) {
        ctx.moveTo(visible.minX, y);
        ctx.lineTo(visible.maxX, y);
      }
      ctx.stroke();
    }

    function drawBoundaryRing() {
      if (boundaryRing.length < 2) return;
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(220,38,38,.36)';
      ctx.lineWidth = 1.25 / view.scale;
      strokePolyline(boundaryRing);
    }

    function drawContextRoad(road) {
      const width = road.rank >= 8 ? 2.35 : road.rank >= 6 ? 1.75 : 1.12;
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(255,255,255,.78)';
      ctx.lineWidth = (width + 1.6) / view.scale;
      strokePolyline(road.points);
      ctx.strokeStyle = road.supplemental
        ? 'rgba(14,116,144,.72)'
        : road.rank >= 7 ? 'rgba(13,148,136,.86)' : 'rgba(37,99,235,.66)';
      ctx.lineWidth = width / view.scale;
      strokePolyline(road.points);
    }

    function drawReferenceRoad(road) {
      const included = includeMissing.has(road.code);
      const pending = pendingReference === road.code;
      ctx.strokeStyle = included
        ? 'rgba(22,128,84,.86)'
        : pending ? 'rgba(217,119,6,.92)'
          : road.status === 'same-osm-way-partial-overlap' ? 'rgba(88,28,135,.36)'
          : road.status === 'same-osm-way-boundary-covered' ? 'rgba(88,28,135,.24)'
          : road.status === 'same-osm-way-missing-part' ? 'rgba(15,23,42,.30)' : 'rgba(15,23,42,.16)';
      ctx.lineWidth = (included ? 3 : pending ? 3.2 : road.status === 'same-osm-way-partial-overlap' ? 1.55 : road.status === 'same-osm-way-boundary-covered' ? 1.2 : road.rank >= 7 ? 1.35 : .82) / view.scale;
      ctx.setLineDash([]);
      strokePolyline(road.points);
    }

    function drawCandidate(candidate) {
      ctx.strokeStyle = no.has(candidate.code) ? 'rgba(185,28,28,.9)' : need.has(candidate.code) ? 'rgba(22,128,84,.92)' : 'rgba(217,119,6,.82)';
      ctx.lineWidth = (need.has(candidate.code) || no.has(candidate.code) ? 3.5 : 2.6) / view.scale;
      ctx.setLineDash([]);
      strokePolyline(candidate.points);
      drawLabel(candidate.code, candidate.points[Math.floor(candidate.points.length / 2)], '#78350f');
    }

    function drawGap(gap) {
      ctx.setLineDash([]);
      ctx.fillStyle = '#dc2626';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2 / view.scale;
      ctx.beginPath();
      ctx.arc(gap.x, gap.y, 5.7 / view.scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      drawLabel(gap.code, [gap.x + 7 / view.scale, gap.y - 7 / view.scale], '#7f1d1d');
    }

    function drawManualLinks() {
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(126,34,206,.9)';
      ctx.lineWidth = 3 / view.scale;
      manualLinks.forEach((link) => {
        ctx.beginPath();
        ctx.moveTo(link.from.x, link.from.y);
        ctx.lineTo(link.to.x, link.to.y);
        ctx.stroke();
        drawLabel(link.code, [(link.from.x + link.to.x) / 2, (link.from.y + link.to.y) / 2], '#581c87');
      });
    }

    function drawDraftLink() {
      if (!pendingEndpoint && !draftLink) return;
      const from = draftLink ? draftLink.from : pendingEndpoint;
      const to = draftLink ? draftLink.to : linkPreviewPoint;
      if (!from || !to) return;
      ctx.setLineDash([]);
      ctx.strokeStyle = draftLink ? 'rgba(126,34,206,.92)' : 'rgba(126,34,206,.48)';
      ctx.lineWidth = (draftLink ? 3.6 : 2.2) / view.scale;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();

      ctx.fillStyle = '#7e22ce';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.6 / view.scale;
      ctx.beginPath();
      ctx.arc(from.x, from.y, 5.4 / view.scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = draftLink ? '#f59e0b' : 'rgba(245,158,11,.72)';
      ctx.beginPath();
      ctx.arc(to.x, to.y, 5.4 / view.scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (draftLink) drawLabel('PREVIEW', [(from.x + to.x) / 2, (from.y + to.y) / 2], '#581c87');
    }

    function drawBanAreas() {
      banAreas.forEach((area) => drawBanRect(area, false));
    }

    function drawBanRect(area, draft) {
      ctx.setLineDash([]);
      ctx.fillStyle = draft ? 'rgba(220,38,38,.08)' : 'rgba(220,38,38,.13)';
      ctx.strokeStyle = draft ? 'rgba(220,38,38,.75)' : 'rgba(185,28,28,.9)';
      ctx.lineWidth = 2 / view.scale;
      const x = Math.min(area.minX, area.maxX);
      const y = Math.min(area.minY, area.maxY);
      const w = Math.abs(area.maxX - area.minX);
      const h = Math.abs(area.maxY - area.minY);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      if (area.code) drawLabel(area.code, [x + 4 / view.scale, y - 4 / view.scale], '#7f1d1d');
    }

    function drawEndpoints(visible) {
      ctx.setLineDash([]);
      allSegments.forEach((segment) => {
        if (!boundsOverlap(segment.bbox, visible)) return;
        segment.points.forEach((point) => {
          ctx.fillStyle = segment.source === 'shanghai-pbf-missing' ? 'rgba(15,23,42,.45)' : 'rgba(37,99,235,.5)';
          ctx.beginPath();
          ctx.arc(point[0], point[1], 2.4 / view.scale, 0, Math.PI * 2);
          ctx.fill();
        });
      });
      if (pendingEndpoint) {
        ctx.strokeStyle = '#7e22ce';
        ctx.lineWidth = 2 / view.scale;
        ctx.beginPath();
        ctx.arc(pendingEndpoint.x, pendingEndpoint.y, 7 / view.scale, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    function drawTarget(target, color, width, solid) {
      const item = target.item;
      ctx.strokeStyle = color;
      ctx.lineWidth = width / view.scale;
      ctx.setLineDash([]);
      if (target.type === 'gap') {
        ctx.beginPath();
        ctx.arc(item.x, item.y, 10 / view.scale, 0, Math.PI * 2);
        ctx.stroke();
      } else if (target.type === 'endpoint') {
        ctx.beginPath();
        ctx.arc(target.x, target.y, 7 / view.scale, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        strokePolyline(item.points);
      }
    }

    function drawLabel(text, point, color) {
      ctx.save();
      ctx.setLineDash([]);
      ctx.font = (12 / view.scale) + 'px Consolas, Microsoft YaHei, sans-serif';
      ctx.lineWidth = 4 / view.scale;
      ctx.strokeStyle = 'rgba(255,255,255,.92)';
      ctx.fillStyle = color;
      ctx.strokeText(text, point[0] + 5 / view.scale, point[1] - 5 / view.scale);
      ctx.fillText(text, point[0] + 5 / view.scale, point[1] - 5 / view.scale);
      ctx.restore();
    }

    function strokePolyline(points) {
      if (!points || points.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (let index = 1; index < points.length; index += 1) {
        ctx.lineTo(points[index][0], points[index][1]);
      }
      ctx.stroke();
    }

    function handleWheel(event) {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const factor = Math.exp(-event.deltaY * 0.0012);
      zoomAt(screen, factor);
    }

    function zoomAtCenter(factor) {
      const rect = canvas.getBoundingClientRect();
      zoomAt({ x: rect.width / 2, y: rect.height / 2 }, factor);
    }

    function zoomAt(screen, factor) {
      const before = screenToWorld(screen);
      const minScale = baseScale * 0.25;
      const maxScale = baseScale * 45;
      view.scale = Math.max(minScale, Math.min(maxScale, view.scale * factor));
      view.x = screen.x - before.x * view.scale;
      view.y = screen.y - before.y * view.scale;
      draw();
    }

    function handlePointerDown(event) {
      canvas.setPointerCapture(event.pointerId);
      const screen = eventToScreen(event);
      const world = screenToWorld(screen);
      if (mode === 'ban') {
        draftBan = { minX: world.x, minY: world.y, maxX: world.x, maxY: world.y };
        drag.active = true;
        drag.moved = false;
        drag.x = event.clientX;
        drag.y = event.clientY;
        return;
      }
      if (mode === 'link') {
        drag.active = true;
        drag.moved = false;
        drag.x = event.clientX;
        drag.y = event.clientY;
        return;
      }
      drag.active = true;
      drag.moved = false;
      drag.x = event.clientX;
      drag.y = event.clientY;
      canvas.classList.add('dragging');
    }

    function handlePointerMove(event) {
      const screen = eventToScreen(event);
      const world = screenToWorld(screen);
      if (mode === 'ban') {
        if (drag.active && draftBan) {
          draftBan.maxX = world.x;
          draftBan.maxY = world.y;
          drag.moved = true;
        }
        hover = null;
        hideTooltip();
        draw();
        return;
      }
      if (mode === 'link') {
        hover = hitTestEndpoint(world) || hitTest(world);
        if (pendingEndpoint && !draftLink) {
          linkPreviewPoint = hover?.type === 'endpoint'
            ? endpointSummary(hover)
            : { x: world.x, y: world.y };
        }
        showTooltip(hover, screen);
        draw();
        return;
      }
      if (drag.active) {
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 1) drag.moved = true;
        view.x += dx;
        view.y += dy;
        drag.x = event.clientX;
        drag.y = event.clientY;
        draw();
        return;
      }
      hover = hitTest(world);
      showTooltip(hover, screen);
      draw();
    }

    function handlePointerUp(event) {
      canvas.releasePointerCapture(event.pointerId);
      canvas.classList.remove('dragging');
      const wasDrag = drag.moved;
      drag.active = false;
      const screen = eventToScreen(event);
      const world = screenToWorld(screen);
      if (mode === 'ban') {
        if (draftBan) {
          draftBan.maxX = world.x;
          draftBan.maxY = world.y;
          const area = normalizeArea(draftBan);
          if (Math.abs(area.maxX - area.minX) > 3 && Math.abs(area.maxY - area.minY) > 3) {
            banAreas.push({ code: code('BAN', banAreas.length), ...area });
            updateSelection();
          }
        }
        draftBan = null;
        draw();
        return;
      }
      if (mode === 'link') {
        const endpoint = hitTestEndpoint(world);
        if (endpoint) selectEndpoint(endpoint);
        return;
      }
      if (!wasDrag) {
        hover = hitTest(world);
        if (hover) selectItem(hover, { prepareReference: hover.type === 'reference' });
      }
    }

    function selectEndpoint(endpoint) {
      selected = endpoint;
      if (!pendingEndpoint) {
        pendingEndpoint = endpoint;
        draftLink = null;
        linkPreviewPoint = endpointSummary(endpoint);
        updateLinkButtons();
        showDetails(endpoint);
        draw();
        return;
      }
      const sameEndpoint = pendingEndpoint.item.code === endpoint.item.code && pendingEndpoint.end === endpoint.end;
      if (sameEndpoint) {
        cancelDraftLink();
        return;
      }
      draftLink = {
        from: endpointSummary(pendingEndpoint),
        to: endpointSummary(endpoint)
      };
      linkPreviewPoint = draftLink.to;
      updateLinkButtons();
      showDraftLinkDetails();
      draw();
    }

    function confirmDraftLink() {
      if (!draftLink) return;
      manualLinks.push({
        code: code('LINK', manualLinks.length),
        from: draftLink.from,
        to: draftLink.to
      });
      const added = manualLinks[manualLinks.length - 1];
      pendingEndpoint = null;
      draftLink = null;
      linkPreviewPoint = null;
      updateLinkButtons();
      updateSelection();
      details.textContent = '\u5df2\u5199\u5165 MANUAL_LINKS\uff1a' + added.code + ' ' + added.from.code + ':' + added.from.end + ' -> ' + added.to.code + ':' + added.to.end;
      draw();
    }

    function cancelDraftLink() {
      pendingEndpoint = null;
      draftLink = null;
      linkPreviewPoint = null;
      selected = null;
      updateLinkButtons();
      details.textContent = '\u5df2\u53d6\u6d88\u7aef\u70b9\u4fee\u8865\uff0c\u53ef\u91cd\u65b0\u9009\u62e9\u7b2c\u4e00\u4e2a\u7aef\u70b9\u3002';
      draw();
    }

    function confirmReferenceCandidate() {
      if (!pendingReference) return;
      includeMissing.add(pendingReference);
      const road = referenceRoads.find((item) => item.code === pendingReference);
      pendingReference = null;
      updateReferenceButtons();
      updateSelection();
      if (road) {
        selected = { type: 'reference', item: road };
        showDetails(selected);
      }
      draw();
    }

    function cancelReferenceCandidate() {
      pendingReference = null;
      updateReferenceButtons();
      if (selected?.type === 'reference') showDetails(selected);
      draw();
    }

    function showDraftLinkDetails() {
      details.textContent = '';
      [
        '\u8fde\u63a5\u9884\u89c8',
        draftLink.from.code + ':' + draftLink.from.end + ' -> ' + draftLink.to.code + ':' + draftLink.to.end,
        '[' + round(draftLink.from.x, 2) + ',' + round(draftLink.from.y, 2) + '] -> [' + round(draftLink.to.x, 2) + ',' + round(draftLink.to.y, 2) + ']',
        '\u70b9\u201c\u786e\u8ba4\u8fde\u63a5\u201d\u540e\u624d\u4f1a\u5199\u5165 MANUAL_LINKS\u3002'
      ].forEach((line) => {
        const div = document.createElement('div');
        div.textContent = line;
        details.appendChild(div);
      });
    }

    function handleKeyDown(event) {
      if (event.key === 'Enter' && pendingReference) {
        event.preventDefault();
        confirmReferenceCandidate();
        return;
      }
      if (event.key === 'Escape' && pendingReference) {
        event.preventDefault();
        cancelReferenceCandidate();
        return;
      }
      if (mode !== 'link') return;
      if (event.key === 'Enter' && draftLink) {
        event.preventDefault();
        confirmDraftLink();
      } else if (event.key === 'Escape' && (draftLink || pendingEndpoint)) {
        event.preventDefault();
        cancelDraftLink();
      }
    }

    function endpointSummary(endpoint) {
      return {
        code: endpoint.item.code,
        source: endpoint.item.source,
        osmId: endpoint.item.osmId,
        segmentIndex: endpoint.item.segmentIndex,
        end: endpoint.end,
        nodeId: endpoint.nodeId || '',
        highway: endpoint.item.highway || '',
        rank: endpoint.item.rank || 0,
        layer: endpoint.item.layer || 0,
        bridge: endpoint.item.bridge || '',
        tunnel: endpoint.item.tunnel || '',
        x: endpoint.x,
        y: endpoint.y
      };
    }

    function hitTest(point) {
      const threshold = 7 / view.scale;
      let best = null;
      function consider(type, item, distance) {
        if (distance > threshold) return;
        if (!best || distance < best.distance) best = { type, item, distance };
      }
      data.gaps.forEach((gap) => consider('gap', gap, distancePoint(point, [gap.x, gap.y])));
      data.candidates.forEach((item) => {
        if (pointNearBounds(point, item.bbox, threshold)) consider('candidate', item, distanceToPolyline(point, item.points));
      });
      referenceRoads.forEach((item) => {
        if (pointNearBounds(point, item.bbox, threshold)) consider('reference', item, distanceToPolyline(point, item.points));
      });
      if (!best) {
        contextRoads.forEach((item) => {
          if (pointNearBounds(point, item.bbox, threshold)) consider('context', item, distanceToPolyline(point, item.points));
        });
      }
      return best;
    }

    function hitTestEndpoint(point) {
      const threshold = 8 / view.scale;
      let best = null;
      allSegments.forEach((item) => {
        if (!pointNearBounds(point, item.bbox, threshold)) return;
        item.points.forEach((endpoint, index) => {
          const distance = distancePoint(point, endpoint);
          if (distance > threshold) return;
          if (!best || distance < best.distance) {
            best = {
              type: 'endpoint',
              item,
              end: index === 0 ? 'A' : 'B',
              nodeId: item.nodeIds?.[index] || '',
              x: endpoint[0],
              y: endpoint[1],
              distance
            };
          }
        });
      });
      return best;
    }

    function showTooltip(target, screen) {
      if (!target) {
        hideTooltip();
        return;
      }
      const item = target.item;
      const label = target.type === 'gap'
        ? item.code + ' ' + (item.names || []).join(' / ')
        : target.type === 'endpoint'
          ? item.code + ':' + target.end + ' ' + displayName(item)
        : item.code + ' ' + displayName(item);
      const extra = target.type === 'gap'
        ? (item.highways || []).join(', ') + ' / endpoints ' + item.edgeCount
        : target.type === 'endpoint'
          ? 'endpoint ' + round(target.x, 2) + ', ' + round(target.y, 2)
        : item.highway + ' rank ' + item.rank + ' / ' + item.status;
      tooltip.innerHTML = '<strong>' + escapeText(label) + '</strong><br>' + escapeText(extra);
      tooltip.style.transform = 'translate(' + Math.round(screen.x + 14) + 'px, ' + Math.round(screen.y + 14) + 'px)';
    }

    function hideTooltip() {
      tooltip.style.transform = 'translate(-9999px, -9999px)';
    }

    function screenToWorld(point) {
      return {
        x: (point.x - view.x) / view.scale,
        y: (point.y - view.y) / view.scale
      };
    }

    function eventToScreen(event) {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    function visibleWorldBounds() {
      const rect = canvas.getBoundingClientRect();
      const topLeft = screenToWorld({ x: 0, y: 0 });
      const bottomRight = screenToWorld({ x: rect.width, y: rect.height });
      return {
        minX: Math.min(topLeft.x, bottomRight.x),
        minY: Math.min(topLeft.y, bottomRight.y),
        maxX: Math.max(topLeft.x, bottomRight.x),
        maxY: Math.max(topLeft.y, bottomRight.y)
      };
    }

    function normalizeArea(area) {
      return {
        minX: Math.min(area.minX, area.maxX),
        minY: Math.min(area.minY, area.maxY),
        maxX: Math.max(area.minX, area.maxX),
        maxY: Math.max(area.minY, area.maxY)
      };
    }

    function pointNearBounds(point, bbox, pad) {
      if (!bbox) return true;
      return point.x >= bbox.minX - pad
        && point.x <= bbox.maxX + pad
        && point.y >= bbox.minY - pad
        && point.y <= bbox.maxY + pad;
    }

    function boundsOverlap(first, second) {
      return first.minX <= second.maxX
        && first.maxX >= second.minX
        && first.minY <= second.maxY
        && first.maxY >= second.minY;
    }

    function round(value, digits = 2) {
      const factor = Math.pow(10, digits);
      return Math.round(value * factor) / factor;
    }

    function displayName(item) {
      return item.name || '(未命名道路)';
    }

    function distanceToPolyline(point, points) {
      if (!points || points.length < 2) return Infinity;
      let best = Infinity;
      for (let index = 0; index < points.length - 1; index += 1) {
        best = Math.min(best, pointToSegmentDistance(point, points[index], points[index + 1]));
      }
      return best;
    }

    function pointToSegmentDistance(point, start, end) {
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const lengthSq = dx * dx + dy * dy;
      if (!lengthSq) return distancePoint(point, start);
      const t = Math.max(0, Math.min(1, ((point.x - start[0]) * dx + (point.y - start[1]) * dy) / lengthSq));
      return distancePoint(point, [start[0] + dx * t, start[1] + dy * t]);
    }

    function distancePoint(first, second) {
      const x = Array.isArray(first) ? first[0] : first.x;
      const y = Array.isArray(first) ? first[1] : first.y;
      return Math.hypot(x - second[0], y - second[1]);
    }

    function escapeText(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[char]);
    }

    loadSavedAnnotations();
    setMode('select');
    updateSelection();
    resize();
    }
  </script>
</body>
</html>
`;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--pbf") parsed.pbf = args[++index];
    else if (arg === "--out") parsed.out = args[++index];
    else if (arg === "--html") parsed.html = args[++index];
    else if (arg === "--focus") parsed.focus = args[++index];
    else if (arg === "--candidates") parsed.candidates = args[++index];
    else if (arg === "--radius") parsed.radius = args[++index];
    else if (arg === "--max-candidates") parsed.maxCandidates = args[++index];
    else if (arg === "--max-reference-roads") parsed.maxReferenceRoads = args[++index];
    else if (arg === "--map-bounds") parsed.mapBounds = args[++index];
    else if (arg === "--focus-bounds") parsed.focusBounds = true;
    else if (arg === "--view-pad") parsed.viewPad = args[++index];
    else if (arg === "--reference-pad") parsed.referencePad = args[++index];
    else if (arg === "--boundary-recheck-pad") parsed.boundaryRecheckPad = args[++index];
  }
  return parsed;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

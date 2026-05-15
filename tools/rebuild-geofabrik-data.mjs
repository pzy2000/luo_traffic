import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const parseOsmPbf = require("osm-pbf-parser");

const DATA_PATH = new URL("../data/app-data.js", import.meta.url);
const CACHE_DIR = new URL("./cache/", import.meta.url);
const PBF_PATH = new URL("./cache/shanghai-latest.osm.pbf", import.meta.url);
const PBF_URL = "https://download.geofabrik.de/asia/china/shanghai-latest.osm.pbf";
const inputPbfPath = process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])) : PBF_PATH;
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

async function main() {
  if (process.argv[2]) {
    console.log(`Using provided PBF ${inputPbfPath.pathname}`);
  } else {
    await ensurePbf();
  }

  const dataJs = await fs.readFile(DATA_PATH, "utf8");
  const metadata = JSON.parse(extractDataAssignment(dataJs, "MAP_METADATA"));
  const appData = JSON.parse(extractDataAssignment(dataJs, "appData"));

  console.log("Scanning Minhang boundary relation...");
  const boundaryMemberIds = await readBoundaryMemberIds(inputPbfPath);
  if (!boundaryMemberIds.size) {
    throw new Error(`Could not find boundary relation ${RELATION_ID} in ${inputPbfPath.pathname}`);
  }

  console.log("Parsing Shanghai PBF roads and boundary ways...");
  const raw = await readRoadData(inputPbfPath, boundaryMemberIds);
  const boundaryRings = buildBoundaryRings(raw.boundaryWays, raw.nodes);
  const boundaryRing = boundaryRings.sort((a, b) => b.length - a.length)[0] || null;
  if (!boundaryRing) {
    throw new Error(`Could not reconstruct boundary relation ${RELATION_ID}`);
  }

  const ways = buildWayGeometries(raw.highwayWays, raw.nodes, metadata.originalBbox, boundaryRing);
  const roads = buildRoads(ways, metadata.originalBbox, metadata.projectedBounds, boundaryRing);
  const namedRoadCount = roads.filter((road) => road.name).length;
  const classDistribution = {};
  roads.forEach((road) => {
    classDistribution[road.highway] = (classDistribution[road.highway] || 0) + 1;
  });

  const nextMetadata = {
    ...metadata,
    source: "Geofabrik Shanghai OpenStreetMap PBF",
    licence: "Data © OpenStreetMap contributors, ODbL 1.0",
    geofabrikUrl: PBF_URL,
    osmTimestamp: raw.osmTimestamp || metadata.osmTimestamp,
    areaTimestamp: null,
    sourceWayCount: raw.highwayWays.length,
    processedRoadCount: roads.length,
    namedRoadCount,
    classDistribution,
    boundaryRelationId: RELATION_ID,
    boundaryRingPointCount: boundaryRing.length,
    sourceQuery: null
  };
  const nextAppData = {
    ...appData,
    roads
  };

  const nextDataJs = replaceDataAssignment(
    replaceDataAssignment(dataJs, "MAP_METADATA", nextMetadata),
    "appData",
    nextAppData
  );
  await fs.writeFile(DATA_PATH, nextDataJs, "utf8");

  console.log(JSON.stringify({
    source: nextMetadata.source,
    highwayWays: raw.highwayWays.length,
    boundaryMemberWays: boundaryMemberIds.size,
    boundaryRings: boundaryRings.length,
    boundaryRingPointCount: boundaryRing.length,
    roads: roads.length,
    namedRoads: namedRoadCount,
    routableRoads: roads.filter((road) => road.routable).length,
    osmTimestamp: nextMetadata.osmTimestamp
  }, null, 2));
}

async function ensurePbf() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const expectedSize = await fetchContentLength(PBF_URL);
  try {
    const stat = await fs.stat(PBF_PATH);
    if (stat.size > 0 && (!expectedSize || stat.size === expectedSize)) {
      console.log(`Using cached ${PBF_PATH.pathname} (${Math.round(stat.size / 1024 / 1024)} MB)`);
      return;
    }
    console.log(`Removing partial cached PBF (${stat.size} bytes, expected ${expectedSize || "unknown"})`);
    await fs.rm(PBF_PATH, { force: true });
  } catch {
    // Download below.
  }

  console.log(`Downloading ${PBF_URL}`);
  const response = await fetch(PBF_URL, {
    headers: { "user-agent": "luo-traffic-routing-debug/1.0 (local Geofabrik importer)" }
  });
  if (!response.ok) {
    throw new Error(`Failed to download PBF: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(PBF_PATH, buffer);
  console.log(`Downloaded ${Math.round(buffer.length / 1024 / 1024)} MB`);
}

async function fetchContentLength(url) {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      headers: { "user-agent": "luo-traffic-routing-debug/1.0 (local Geofabrik importer)" }
    });
    const length = Number.parseInt(response.headers.get("content-length") || "", 10);
    return Number.isFinite(length) ? length : 0;
  } catch {
    return 0;
  }
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

function readRoadData(fileUrl, boundaryMemberIds) {
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
            nodes.set(item.id, { lat: item.lat, lon: item.lon });
            return;
          }
          if (item.type !== "way") return;
          if (boundaryMemberIds.has(item.id)) {
            boundaryWays.push({ id: item.id, refs: item.refs || [] });
          }
          const highway = item.tags?.highway;
          if (highway && HIGHWAY_PATTERN.test(highway) && item.refs?.length > 1) {
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
    .map((way) => ({
      id: way.id,
      refs: way.refs.filter((ref) => nodes.has(ref))
    }))
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
        if (ringEnd === candidateStart) {
          ringRefs = ringRefs.concat(candidate.refs.slice(1));
        } else if (ringEnd === candidateEnd) {
          ringRefs = ringRefs.concat([...candidate.refs].reverse().slice(1));
        } else if (ringStart === candidateEnd) {
          ringRefs = candidate.refs.slice(0, -1).concat(ringRefs);
        } else if (ringStart === candidateStart) {
          ringRefs = [...candidate.refs].reverse().slice(0, -1).concat(ringRefs);
        } else {
          continue;
        }
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

function buildWayGeometries(highwayWays, nodes, bbox, boundaryRing) {
  return highwayWays
    .map((way) => {
      const geometry = way.nodes.map((nodeId) => nodes.get(nodeId) || null);
      return { ...way, geometry };
    })
    .filter((way) => {
      for (let index = 0; index < way.geometry.length - 1; index += 1) {
        const start = way.geometry[index];
        const end = way.geometry[index + 1];
        if (!start || !end) continue;
        if (!segmentTouchesBbox(start, end, bbox)) continue;
        if (segmentTouchesBoundary(start, end, boundaryRing)) return true;
      }
      return false;
    });
}

function buildRoads(ways, bbox, bounds, boundaryRing) {
  const roads = [];
  ways.forEach((way) => {
    const tags = way.tags || {};
    const highway = tags.highway;
    const rank = HIGHWAY_RANK[highway] || 2;
    const clippedParts = clipWayGeometry(way, bbox, boundaryRing);
    clippedParts.forEach((part, partIndex) => {
      if (part.points.length < 2) return;
      const projected = part.points.map((point) => projectPoint(point, bbox, bounds));
      const length = polylineLength(projected);
      if (length < 2.5) return;
      const roadId = clippedParts.length > 1 ? `${way.id}-${partIndex}` : String(way.id);
      const keptTags = {};
      ROAD_TAGS_TO_KEEP.forEach((key) => {
        if (tags[key] !== undefined) keptTags[key] = tags[key];
      });
      roads.push({
        id: roadId,
        osmId: way.id,
        name: tags.name || "",
        highway,
        rank,
        width: WIDTH_BY_RANK[rank] || 2,
        length: round(length, 1),
        points: projected.map((point) => [round(point.x, 1), round(point.y, 1)]),
        nodeIds: part.nodeIds,
        oneway: normalizedOneway(tags, highway),
        layer: Number.parseInt(tags.layer || "0", 10) || 0,
        bridge: tags.bridge === "yes",
        tunnel: tags.tunnel === "yes",
        access: tags.access || "",
        service: tags.service || "",
        routable: isRoutable(tags),
        tags: keptTags
      });
    });
  });
  roads.sort((a, b) => a.rank - b.rank || a.length - b.length || String(a.id).localeCompare(String(b.id)));
  return roads;
}

function clipWayGeometry(way, bbox, boundaryRing) {
  const parts = [];
  let current = null;
  for (let index = 0; index < way.geometry.length - 1; index += 1) {
    const start = way.geometry[index];
    const end = way.geometry[index + 1];
    if (!start || !end || !segmentTouchesBoundary(start, end, boundaryRing)) {
      flush();
      continue;
    }
    const clipped = clipSegment(start, end, bbox);
    if (!clipped) {
      flush();
      continue;
    }
    const startNode = clipped.t0 <= 1e-8 ? way.nodes[index] ?? null : `clip:${way.id}:${index}:a:${round(clipped.t0, 5)}`;
    const endNode = clipped.t1 >= 1 - 1e-8 ? way.nodes[index + 1] ?? null : `clip:${way.id}:${index}:b:${round(clipped.t1, 5)}`;
    const startPoint = { lat: clipped.lat1, lon: clipped.lon1 };
    const endPoint = { lat: clipped.lat2, lon: clipped.lon2 };
    if (!current) {
      current = { points: [startPoint], nodeIds: [startNode] };
    } else {
      const last = current.points[current.points.length - 1];
      if (Math.abs(last.lat - startPoint.lat) > 1e-9 || Math.abs(last.lon - startPoint.lon) > 1e-9) {
        flush();
        current = { points: [startPoint], nodeIds: [startNode] };
      }
    }
    current.points.push(endPoint);
    current.nodeIds.push(endNode);
  }
  flush();
  return parts;

  function flush() {
    if (current && current.points.length > 1) parts.push(current);
    current = null;
  }
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

function segmentTouchesBbox(start, end, bbox) {
  return Boolean(clipSegment(start, end, bbox));
}

function clipSegment(start, end, bbox) {
  let t0 = 0;
  let t1 = 1;
  const dx = end.lon - start.lon;
  const dy = end.lat - start.lat;
  if (!clipTest(-dx, start.lon - bbox.minlon)) return null;
  if (!clipTest(dx, bbox.maxlon - start.lon)) return null;
  if (!clipTest(-dy, start.lat - bbox.minlat)) return null;
  if (!clipTest(dy, bbox.maxlat - start.lat)) return null;
  return {
    t0,
    t1,
    lon1: start.lon + dx * t0,
    lat1: start.lat + dy * t0,
    lon2: start.lon + dx * t1,
    lat2: start.lat + dy * t1
  };

  function clipTest(p, q) {
    if (Math.abs(p) < 1e-12) return q >= 0;
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
  if (!highway) return false;
  if (tags.area === "yes") return false;
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

function polylineLength(points) {
  let total = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    total += Math.hypot(points[index + 1].x - points[index].x, points[index + 1].y - points[index].y);
  }
  return total;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
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
    if (char === ";" && depth === 0) {
      return source.slice(expressionStart, index).trim();
    }
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
      const json = JSON.stringify(value);
      return source.slice(0, start + marker.length) + json + source.slice(index);
    }
  }
  throw new Error(`Unterminated data assignment ${name}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

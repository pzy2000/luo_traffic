import fs from "node:fs/promises";

const DATA_PATH = new URL("../data/app-data.js", import.meta.url);
const RELATION_ID = 1278189;
const HIGHWAY_PATTERN = "^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$";
const OVERPASS_ENDPOINTS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass-api.de/api/interpreter"
];

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

const query = `[out:json][timeout:240];
rel(${RELATION_ID})->.boundary;
.boundary map_to_area -> .searchArea;
(
  way["highway"~"${HIGHWAY_PATTERN}"](area.searchArea);
);
out body geom;`;

async function main() {
  const dataJs = await fs.readFile(DATA_PATH, "utf8");
  const metadata = JSON.parse(extractDataAssignment(dataJs, "MAP_METADATA"));
  const appData = JSON.parse(extractDataAssignment(dataJs, "appData"));
  const osm = await fetchOverpass(query);
  const ways = osm.elements.filter((element) => element.type === "way" && element.tags?.highway && element.geometry?.length > 1);
  const roads = buildRoads(ways, metadata.originalBbox, metadata.projectedBounds);
  const namedRoadCount = roads.filter((road) => road.name).length;
  const classDistribution = {};
  roads.forEach((road) => {
    classDistribution[road.highway] = (classDistribution[road.highway] || 0) + 1;
  });

  const nextMetadata = {
    ...metadata,
    source: "OpenStreetMap Overpass API",
    licence: "Data © OpenStreetMap contributors, ODbL 1.0",
    overpassGenerator: osm.generator || metadata.overpassGenerator,
    osmTimestamp: osm.osm3s?.timestamp_osm_base || metadata.osmTimestamp,
    areaTimestamp: osm.osm3s?.timestamp_areas_base || metadata.areaTimestamp,
    sourceWayCount: ways.length,
    processedRoadCount: roads.length,
    namedRoadCount,
    classDistribution,
    sourceQuery: query
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
    ways: ways.length,
    roads: roads.length,
    namedRoads: namedRoadCount,
    routableRoads: roads.filter((road) => road.routable).length,
    osmTimestamp: nextMetadata.osmTimestamp
  }, null, 2));
}

async function fetchOverpass(overpassQuery) {
  let lastError = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      console.log(`Fetching OSM data from ${endpoint}`);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          "accept": "application/json",
          "user-agent": "luo-traffic-routing-debug/1.0 (local rebuild script)"
        },
        body: new URLSearchParams({ data: overpassQuery })
      });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      console.warn(`Overpass endpoint failed: ${endpoint}: ${error.message}`);
    }
  }
  throw lastError || new Error("Overpass request failed");
}

function buildRoads(ways, bbox, bounds) {
  const roads = [];
  ways.forEach((way) => {
    const tags = way.tags || {};
    const highway = tags.highway;
    const rank = HIGHWAY_RANK[highway] || 2;
    const clippedParts = clipWayGeometry(way, bbox);
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

function clipWayGeometry(way, bbox) {
  const parts = [];
  let current = null;
  const nodes = way.nodes || [];
  for (let index = 0; index < way.geometry.length - 1; index += 1) {
    const start = way.geometry[index];
    const end = way.geometry[index + 1];
    const clipped = clipSegment(start, end, bbox);
    if (!clipped) {
      flush();
      continue;
    }
    const startNode = clipped.t0 <= 1e-8 ? nodes[index] ?? null : `clip:${way.id}:${index}:a:${round(clipped.t0, 5)}`;
    const endNode = clipped.t1 >= 1 - 1e-8 ? nodes[index + 1] ?? null : `clip:${way.id}:${index}:b:${round(clipped.t1, 5)}`;
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

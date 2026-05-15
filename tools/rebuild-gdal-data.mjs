import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const DATA_PATH = new URL("../data/app-data.js", import.meta.url);
const CACHE_DIR = new URL("./cache/", import.meta.url);
const DEFAULT_PBF = new URL("./cache/shanghai-latest.osm.pbf", import.meta.url);
const DEFAULT_GEOJSON = new URL("./cache/minhang-roads-gdal-boundary.geojson", import.meta.url);
const DEFAULT_BOUNDARY = new URL("./cache/minhang-boundary.geojson", import.meta.url);
const RELATION_ID = 1278189;
const HIGHWAY_VALUES = [
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "unclassified",
  "residential",
  "living_street",
  "service",
  "pedestrian",
  "motorway_link",
  "trunk_link",
  "primary_link",
  "secondary_link",
  "tertiary_link"
];
const DEFAULT_MIN_OUTPUT_RANK = 1;

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
  const pbfPath = path.resolve(args.pbf || fileURLToPathname(DEFAULT_PBF));
  const geojsonPath = path.resolve(args.geojson || fileURLToPathname(DEFAULT_GEOJSON));
  const boundaryPath = path.resolve(args.boundary || fileURLToPathname(DEFAULT_BOUNDARY));
  const dataJs = await fs.readFile(DATA_PATH, "utf8");
  const metadata = JSON.parse(extractDataAssignment(dataJs, "MAP_METADATA"));
  const appData = JSON.parse(extractDataAssignment(dataJs, "appData"));
  const bbox = metadata.originalBbox;
  const minOutputRank = Number.parseInt(args.minRank || String(DEFAULT_MIN_OUTPUT_RANK), 10);

  await fs.mkdir(CACHE_DIR, { recursive: true });
  if (!args.skipOgr) {
    await fs.rm(boundaryPath, { force: true });
    await exportBoundaryGeoJson(pbfPath, boundaryPath);
    await fs.rm(geojsonPath, { force: true });
    await exportRoadGeoJson(pbfPath, geojsonPath, boundaryPath, bbox);
  }

  const geojson = JSON.parse(await fs.readFile(geojsonPath, "utf8"));
  const roads = buildRoadsFromGeoJson(geojson, bbox, metadata.projectedBounds, minOutputRank);
  const namedRoadCount = roads.filter((road) => road.name).length;
  const classDistribution = {};
  roads.forEach((road) => {
    classDistribution[road.highway] = (classDistribution[road.highway] || 0) + 1;
  });

  const nextMetadata = {
    ...metadata,
    source: "GDAL OSM driver from Geofabrik Shanghai PBF",
    licence: "Data © OpenStreetMap contributors, ODbL 1.0",
    geofabrikUrl: "https://download.geofabrik.de/asia/china/shanghai-latest.osm.pbf",
    sourceWayCount: geojson.features.length,
    processedRoadCount: roads.length,
    namedRoadCount,
    classDistribution,
    boundaryRelationId: RELATION_ID,
    extraction: {
      tool: "ogr2ogr",
      layer: "lines",
      clip: "minhang relation polygon",
      minOutputRank,
      boundaryPath: path.relative(process.cwd(), boundaryPath),
      geojsonPath: path.relative(process.cwd(), geojsonPath)
    }
  };
  const nextAppData = { ...appData, roads };
  const nextDataJs = replaceDataAssignment(
    replaceDataAssignment(dataJs, "MAP_METADATA", nextMetadata),
    "appData",
    nextAppData
  );
  await fs.writeFile(DATA_PATH, nextDataJs, "utf8");

  console.log(JSON.stringify({
    source: nextMetadata.source,
    geojsonFeatures: geojson.features.length,
    roads: roads.length,
    namedRoads: namedRoadCount,
    routableRoads: roads.filter((road) => road.routable).length,
    classDistribution
  }, null, 2));
}

function exportBoundaryGeoJson(pbfPath, boundaryPath) {
  const args = [
    "run",
    "-n",
    "luo-osm-tools",
    "ogr2ogr",
    "-oo",
    "INTERLEAVED_READING=YES",
    "-f",
    "GeoJSON",
    boundaryPath,
    pbfPath,
    "multipolygons",
    "-where",
    `osm_id='${RELATION_ID}'`,
    "-lco",
    "RFC7946=YES",
    "-overwrite"
  ];
  return run("conda", args);
}

function exportRoadGeoJson(pbfPath, geojsonPath, boundaryPath, bbox) {
  const where = `highway IN (${HIGHWAY_VALUES.map((value) => `'${value}'`).join(",")})`;
  const args = [
    "run",
    "-n",
    "luo-osm-tools",
    "ogr2ogr",
    "-f",
    "GeoJSON",
    geojsonPath,
    pbfPath,
    "lines",
    "-spat",
    String(bbox.minlon),
    String(bbox.minlat),
    String(bbox.maxlon),
    String(bbox.maxlat),
    "-clipsrc",
    boundaryPath,
    "-where",
    where,
    "-lco",
    "RFC7946=YES",
    "-overwrite"
  ];
  return run("conda", args);
}

function buildRoadsFromGeoJson(geojson, bbox, bounds, minOutputRank) {
  const roads = [];
  geojson.features.forEach((feature, index) => {
    const properties = feature.properties || {};
    const highway = properties.highway;
    const rank = HIGHWAY_RANK[highway];
    const coordinates = flattenLineCoordinates(feature.geometry);
    if (!rank || coordinates.length < 2) return;
    if (rank < minOutputRank) return;
    const otherTags = parseOtherTags(properties.other_tags);
    const points = coordinates.map((coordinate) => projectPoint(coordinate, bbox, bounds));
    const length = polylineLength(points);
    if (length < 2.5) return;
    roads.push({
      id: `gdal:${properties.osm_id || index}:${index}`,
      osmId: properties.osm_id || "",
      name: properties.name || "",
      highway,
      rank,
      width: WIDTH_BY_RANK[rank] || 2,
      length: round(length, 1),
      points: points.map((point) => [round(point.x, 1), round(point.y, 1)]),
      oneway: normalizedOneway(properties, otherTags),
      layer: Number.parseInt(otherTags.layer || "0", 10) || 0,
      bridge: otherTags.bridge === "yes",
      tunnel: otherTags.tunnel === "yes",
      access: otherTags.access || "",
      service: otherTags.service || "",
      routable: isRoutable(properties, otherTags),
      tags: { ...otherTags, highway, name: properties.name || "" }
    });
  });
  roads.sort((a, b) => a.rank - b.rank || a.length - b.length || String(a.id).localeCompare(String(b.id)));
  return roads;
}

function flattenLineCoordinates(geometry) {
  if (!geometry) return [];
  if (geometry.type === "LineString") return geometry.coordinates || [];
  if (geometry.type === "MultiLineString") return (geometry.coordinates || []).flat();
  return [];
}

function parseOtherTags(value) {
  const tags = {};
  for (const match of String(value || "").matchAll(/"([^"]+)"=>"([^"]*)"/g)) {
    tags[match[1]] = match[2];
  }
  return tags;
}

function normalizedOneway(properties, tags) {
  if (tags.oneway === "-1") return "reverse";
  if (["yes", "true", "1"].includes(tags.oneway) || tags.junction === "roundabout" || properties.highway === "motorway") return "yes";
  return "no";
}

function isRoutable(properties, tags) {
  if (tags.area === "yes") return false;
  if (["no", "private"].includes(tags.access)) return false;
  if (["no", "private"].includes(tags.vehicle)) return false;
  if (["no", "private"].includes(tags.motor_vehicle)) return false;
  if (["no", "private"].includes(tags.motorcar)) return false;
  if (properties.highway === "pedestrian" && tags.motor_vehicle !== "yes" && tags.motorcar !== "yes") return false;
  return true;
}

function projectPoint(coordinate, bbox, bounds) {
  const lon = coordinate[0];
  const lat = coordinate[1];
  const xRatio = (lon - bbox.minlon) / (bbox.maxlon - bbox.minlon);
  const yRatio = (bbox.maxlat - lat) / (bbox.maxlat - bbox.minlat);
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

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const executable = command === "conda" && process.env.CONDA_EXE ? process.env.CONDA_EXE : command;
    const child = spawn(executable, args, { stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--pbf") parsed.pbf = args[++index];
    else if (arg === "--geojson") parsed.geojson = args[++index];
    else if (arg === "--boundary") parsed.boundary = args[++index];
    else if (arg === "--min-rank") parsed.minRank = args[++index];
    else if (arg === "--skip-ogr") parsed.skipOgr = true;
  }
  return parsed;
}

function fileURLToPathname(url) {
  return decodeURIComponent(url.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
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
      return source.slice(0, start + marker.length) + JSON.stringify(value) + source.slice(index);
    }
  }
  throw new Error(`Unterminated data assignment ${name}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

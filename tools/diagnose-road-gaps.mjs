import fs from "node:fs/promises";

const DATA_PATH = new URL("../data/app-data.js", import.meta.url);

async function main() {
  const dataSrc = await fs.readFile(DATA_PATH, "utf8");
  const window = {};
  new Function("window", dataSrc)(window);
  const roads = window.appData.roads;
  const endpoints = [];
  roads.forEach((road) => {
    if (road.routable === false || road.points.length < 2) return;
    endpoints.push(endpointRecord(road, 0));
    endpoints.push(endpointRecord(road, road.points.length - 1));
  });
  const buckets = new Map();
  const cellSize = 3;
  endpoints.forEach((endpoint) => {
    const key = bucketKey(endpoint.x, endpoint.y, cellSize);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(endpoint);
  });

  const candidates = [];
  endpoints.forEach((endpoint) => {
    const cellX = Math.floor(endpoint.x / cellSize);
    const cellY = Math.floor(endpoint.y / cellSize);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const bucket = buckets.get(`${cellX + dx}:${cellY + dy}`) || [];
        bucket.forEach((other) => {
          if (endpoint.key >= other.key) return;
          if (endpoint.roadId === other.roadId) return;
          const gap = Math.hypot(endpoint.x - other.x, endpoint.y - other.y);
          if (gap > 2.5) return;
          candidates.push({
            gap: round(gap, 2),
            first: summarize(endpoint),
            second: summarize(other)
          });
        });
      }
    }
  });
  candidates.sort((a, b) => a.gap - b.gap);
  const byGap = {
    le04: candidates.filter((item) => item.gap <= 0.4).length,
    le10: candidates.filter((item) => item.gap <= 1).length,
    le25: candidates.length
  };
  console.log(JSON.stringify({
    source: window.MAP_METADATA.source,
    clip: window.MAP_METADATA.extraction?.clip,
    roads: roads.length,
    endpoints: endpoints.length,
    nearbyUnmergedEndpointPairs: byGap,
    examples: candidates.slice(0, 20)
  }, null, 2));
}

function endpointRecord(road, pointIndex) {
  const point = road.points[pointIndex];
  return {
    key: `${road.id}:${pointIndex}`,
    roadId: road.id,
    osmId: road.osmId,
    name: road.name || "",
    highway: road.highway,
    rank: road.rank,
    x: point[0],
    y: point[1]
  };
}

function summarize(endpoint) {
  return {
    roadId: endpoint.roadId,
    osmId: endpoint.osmId,
    name: endpoint.name,
    highway: endpoint.highway,
    x: endpoint.x,
    y: endpoint.y
  };
}

function bucketKey(x, y, cellSize) {
  return `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}`;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

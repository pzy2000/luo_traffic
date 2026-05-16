import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_PORT = 5510;
const ANNOTATIONS_PATH = path.join(ROOT, "test-results", "topology-gap-annotations.json");
const DEBUG_JSON_PATH = path.join(ROOT, "test-results", "topology-gap-debug.json");
const APPLY_SCRIPT = path.join(ROOT, "tools", "apply-topology-gap-annotations.mjs");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml; charset=utf-8"
};

const port = Number.parseInt(process.env.PORT || process.argv[2] || String(DEFAULT_PORT), 10);

const server = http.createServer(async (request, response) => {
  setCors(response);
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }
  try {
    if (request.method === "POST" && request.url === "/api/topology-annotations/apply") {
      await handleApply(request, response);
      return;
    }
    if (request.method === "GET") {
      await serveStatic(request, response);
      return;
    }
    sendJson(response, 405, { ok: false, error: "Method not allowed" });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error.message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log("Topology annotation server:");
  console.log("  http://127.0.0.1:" + port + "/test-results/topology-gap-debug.html");
  console.log("  http://127.0.0.1:" + port + "/index.html");
});

async function handleApply(request, response) {
  const body = await readRequestBody(request);
  const annotations = JSON.parse(body || "{}");
  await fs.mkdir(path.dirname(ANNOTATIONS_PATH), { recursive: true });
  await fs.writeFile(ANNOTATIONS_PATH, JSON.stringify(annotations, null, 2), "utf8");
  const result = await runNode(APPLY_SCRIPT, [
    "--annotations", ANNOTATIONS_PATH,
    "--debug-json", DEBUG_JSON_PATH
  ]);
  sendJson(response, 200, { ok: true, annotations: ANNOTATIONS_PATH, result });
}

async function serveStatic(request, response) {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const pathname = decodeURIComponent(url.pathname);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(ROOT, relative);
  if (!target.startsWith(ROOT + path.sep) && target !== ROOT) {
    sendText(response, 403, "Forbidden");
    return;
  }
  const stat = await fs.stat(target).catch(() => null);
  if (!stat || !stat.isFile()) {
    sendText(response, 404, "Not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": "no-store"
  });
  createReadStream(target).pipe(response);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 20_000_000) {
        reject(new Error("Request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function runNode(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || "apply script failed with code " + code));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ stdout: stdout.trim() });
      }
    });
  });
}

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function sendText(response, status, value) {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(value);
}

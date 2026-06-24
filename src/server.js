import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeNotificationWindow, openPostWindow, runScan } from "./scanner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);
const scans = new Map();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "POST" && url.pathname === "/api/open-notifications") {
      const body = await readJson(req);
      const events = [];
      const result = await openPostWindow(
        {
          targetPostUrl: body.targetPostUrl
        },
        (event) => events.push(event)
      );
      return sendJson(res, 200, { result, events });
    }

    if (req.method === "POST" && url.pathname === "/api/close-notifications") {
      await closeNotificationWindow();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/scan") {
      const body = await readJson(req);
      const scanId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const state = {
        id: scanId,
        status: "running",
        events: [],
        result: null,
        error: null
      };
      scans.set(scanId, state);

      runScan(
        {
          targetPostUrl: body.targetPostUrl,
          notificationUrl: body.notificationUrl,
          seconds: body.seconds,
          scrollRounds: body.scrollRounds,
          maxSeconds: body.maxSeconds,
          maxScrollRounds: body.maxScrollRounds,
          maxPages: body.maxPages,
          idleRounds: body.idleRounds
        },
        (event) => {
          state.events.push(event);
          if (state.events.length > 200) state.events.shift();
        }
      )
        .then((result) => {
          state.status = "done";
          state.result = result;
        })
        .catch((error) => {
          state.status = "error";
          state.error = error.message;
          state.events.push({ at: new Date().toISOString(), message: "记录失败", data: { error: error.message } });
        });

      return sendJson(res, 202, { scanId });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/scan/")) {
      const id = decodeURIComponent(url.pathname.split("/").pop());
      const state = scans.get(id);
      if (!state) return sendJson(res, 404, { error: "scan not found" });
      return sendJson(res, 200, {
        id: state.id,
        status: state.status,
        events: state.events,
        result: state.result,
        error: state.error
      });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/download/")) {
      const [, , , id, type] = url.pathname.split("/");
      const state = scans.get(id);
      if (!state || !state.result) return sendJson(res, 404, { error: "file not ready" });
      const file = type === "csv" ? state.result.files.csvPath : state.result.files.jsonPath;
      const contentType = type === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8";
      const data = await fs.readFile(file);
      res.writeHead(200, {
        "content-type": contentType,
        "content-disposition": `attachment; filename="${type === "csv" ? "candidates.csv" : "result.json"}"`
      });
      return res.end(data);
    }

    if (req.method === "GET") {
      return serveStatic(res, url.pathname);
    }

    sendJson(res, 405, { error: "method not allowed" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Binance Square Repost Finder running at http://${HOST}:${PORT}`);
});

async function serveStatic(res, pathname) {
  const clean = pathname === "/" ? "/index.html" : pathname;
  const fullPath = path.resolve(PUBLIC_DIR, `.${clean}`);
  if (!fullPath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "forbidden" });
  try {
    const data = await fs.readFile(fullPath);
    res.writeHead(200, { "content-type": contentType(fullPath) });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "not found" });
  }
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

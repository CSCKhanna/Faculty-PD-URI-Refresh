import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { updateFeeds } from "./update-feeds.mjs";

const __filename = fileURLToPath(import.meta.url);
const root = path.dirname(__filename);
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/api/status" && req.method === "GET") {
      return sendJson(res, {
        ok: true,
        message: "Updater server connected.",
        updateEndpoint: "/api/update"
      });
    }

    if (req.url === "/api/update" && req.method === "POST") {
      const result = await updateFeeds();
      return sendJson(res, { ok: true, ...result });
    }

    const file = await resolveStaticFile(req.url);
    if (!file) return notFound(res);

    const ext = path.extname(file);
    const content = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(content);
  } catch (error) {
    sendJson(res, { ok: false, error: error.message }, 500);
  }
});

server.listen(port, host, () => {
  console.log(`URI faculty training webpage running at http://${host}:${port}`);
});

async function resolveStaticFile(url) {
  const cleanUrl = new URL(url || "/", `http://localhost:${port}`);
  let pathname = decodeURIComponent(cleanUrl.pathname);
  if (pathname === "/") pathname = "/index.html";

  const file = path.normalize(path.join(root, pathname));
  if (!file.startsWith(root)) return null;

  const stats = await fs.stat(file).catch(() => null);
  if (!stats || !stats.isFile()) return null;
  return file;
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function notFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

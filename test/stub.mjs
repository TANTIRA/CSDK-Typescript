// A local HTTP server that answers from a route table and records every request.
import http from "node:http";

export const ok = (body, status = 200, headers = {}) => ({ status, body, headers });

/** routes: "METHOD /path" (path without the query) -> answer, or (req) => answer. */
export async function stub(routes) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const type = req.headers["content-type"] || "";
      const url = new URL(req.url, "http://x");
      const rec = {
        method: req.method, path: url.pathname, query: url.search, headers: req.headers, raw,
        body: type.startsWith("application/json") ? JSON.parse(raw.toString()) : undefined,
      };
      seen.push(rec);
      let a = routes[`${req.method} ${url.pathname}`] ?? ok({ errorCode: "NOT_FOUND", errorName: "NotFound" }, 404);
      if (typeof a === "function") a = a(rec);
      const isBytes = a.body instanceof Uint8Array || typeof a.body === "string";
      res.writeHead(a.status, { "Content-Type": isBytes ? "application/octet-stream" : "application/json", ...a.headers });
      res.end(a.body === undefined ? "" : isBytes ? a.body : JSON.stringify(a.body));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  return { base, seen, close: () => new Promise((r) => server.close(r)) };
}

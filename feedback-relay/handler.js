// The relay's Node side: turns a Node request into the Fetch `Request` the worker takes, and the
// worker's `Response` back. server.mjs serves it on Fly; the tests serve it on a local port.
import worker from "./worker.js";

/** More than any note can be: the worker's 5 MB screenshot cap is about 6.7 MB as base64, plus the text. */
const MAX_BODY = 8 * 1024 * 1024;

export function nodeHandler(env) {
  return async (req, res) => {
    if (req.method === "GET" && (req.url === "/healthz" || req.url === "/")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else if (value) {
        headers.set(key, value);
      }
    }

    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        // Whoever sends this much is not the app; hanging up keeps it from filling the machine's memory.
        if (size > MAX_BODY) return void req.destroy();
        chunks.push(chunk);
      }
    } catch {
      // The client hung up mid-upload. Left to reject, this loop would end the whole process.
      return;
    }
    const body = chunks.length ? Buffer.concat(chunks) : null;

    const request = new Request(url, {
      method: req.method,
      headers,
      body: body && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
    });

    try {
      const response = await worker.fetch(request, env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        for await (const chunk of response.body) res.write(chunk);
      }
      res.end();
    } catch (err) {
      console.error("Worker error:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal server error");
    }
  };
}

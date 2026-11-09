// The relay's Node side: turns a Node request into the Fetch `Request` the worker takes, and the
// worker's `Response` back. server.mjs serves it on Fly; the tests serve it on a local port.
import worker from "./worker.js";

/** More than any note can be: the worker's 5 MB screenshot cap is about 6.7 MB as base64, plus the text. */
const MAX_BODY = 8 * 1024 * 1024;

// Each note costs a GitHub call on the token's owner, an Actions run and a Claude triage, so notes are
// counted before the body is read. A person sends one or two; a script sends thousands.
const NOTE_WINDOW_MS = 60 * 60_000;
const NOTES_PER_CALLER = 5;
const NOTES_IN_ALL = 30;

/**
 * `behindFly`: trust the Fly-Client-IP header, which Fly's proxy sets on every request it forwards.
 * Off Fly a caller could write that header itself, so the socket's address is used instead.
 */
export function nodeHandler(env, { behindFly = false, limiter = noteLimiter() } = {}) {
  return async (req, res) => {
    if (req.method === "GET" && (req.url === "/healthz" || req.url === "/")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
      return;
    }

    // The worker files any POST outside /updates as a note; those are what's counted.
    if (req.method === "POST" && !req.url.startsWith("/updates")) {
      const wait = limiter(addressKey(callerAddress(req, behindFly)));
      if (wait) {
        const minutes = Math.ceil(wait / 60);
        res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8", "Retry-After": String(wait), Connection: "close" });
        res.end(`Too many notes in the last hour. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
        return;
      }
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

/** X-Forwarded-For is never read: a caller can put any address in it. */
function callerAddress(req, behindFly) {
  const fly = behindFly ? req.headers["fly-client-ip"] : undefined;
  return (typeof fly === "string" && fly.trim()) || req.socket.remoteAddress || "";
}

/**
 * Counts notes per caller and for everyone together, in fixed windows kept in memory. Returns 0 and
 * counts the note when both have room, or the seconds until the fuller one does.
 * ponytail: one machine's memory, so each Fly machine counts on its own and a restart forgets; a shared
 * store (or the Cloudflare rule in README.md) is the upgrade if the relay ever runs on several machines.
 */
export function noteLimiter({ perIp = NOTES_PER_CALLER, total = NOTES_IN_ALL, windowMs = NOTE_WINDOW_MS, now = Date.now } = {}) {
  const windows = new Map();
  const ALL = "*";
  const windowFor = (key, t) => {
    let w = windows.get(key);
    if (!w || t - w.start >= windowMs) windows.set(key, (w = { start: t, count: 0 }));
    return w;
  };
  return (key) => {
    const t = now();
    if (windows.size > 10_000) for (const [k, w] of windows) if (t - w.start >= windowMs) windows.delete(k);
    const mine = windowFor(key, t);
    const all = windowFor(ALL, t);
    const full = [mine.count >= perIp && mine, all.count >= total && all].filter(Boolean);
    if (full.length) return Math.max(...full.map((w) => Math.ceil((w.start + windowMs - t) / 1000)));
    mine.count++;
    all.count++;
    return 0;
  };
}

/**
 * The address a caller is counted under. An IPv6 address counts by its /64, since one customer is
 * usually handed a whole /64 and could otherwise send each note from a new address.
 */
export function addressKey(ip) {
  const address = ip.split("%")[0].toLowerCase();
  if (!address.includes(":")) return address;
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/.test(address)) return address.slice(7);
  const [head, tail] = address.split("::");
  const groups = head ? head.split(":") : [];
  if (tail !== undefined) {
    const rest = tail ? tail.split(":") : [];
    groups.push(...Array(Math.max(0, 8 - groups.length - rest.length)).fill("0"), ...rest);
  }
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

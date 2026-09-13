// Feedback relay: a Cloudflare Worker (or, through server.mjs, a Fly machine) that takes a note
// from the Send feedback box in Nested and files it as a GitHub issue on this repo. It also serves
// the app's updates from the repo's releases (updates.js). The app never holds a GitHub token;
// only this relay does.
//
// Deploy with `wrangler deploy` from this folder, then `wrangler secret put GITHUB_TOKEN` with a
// fine-grained token that has Issues: read and write and Contents: read on the repo. See README.md.

import { handleUpdates } from "./updates.js";

const MAX_MESSAGE = 5000;
const MAX_EMAIL = 200;
const MAX_TITLE = 72;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/updates")) return handleUpdates(request, env, url);
    if (request.method !== "POST") return text(405, "POST only");
    if (!env.GITHUB_TOKEN) return text(500, "The relay has no GITHUB_TOKEN set");
    if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPO || "")) return text(500, "The relay has no GITHUB_REPO set");

    let body;
    try {
      body = await request.json();
    } catch {
      return text(400, "Send JSON");
    }
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    if (!message) return text(400, "The note is empty");
    if (message.length > MAX_MESSAGE) return text(413, `Keep the note under ${MAX_MESSAGE} characters`);
    const email = typeof body?.email === "string" ? body.email.trim() : "";
    if (email && (email.length > MAX_EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return text(400, "That email address doesn't look right");
    const app = detail(body?.app);

    const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "nested-feedback-relay",
      },
      body: JSON.stringify({ title: titleFor(message), body: issueBody(message, email, app), labels: [env.LABEL || "feedback"] }),
    });
    if (!res.ok) {
      const why = await res.text().catch(() => "");
      console.error("GitHub refused the issue", res.status, why.slice(0, 300));
      return text(502, "GitHub didn't accept the note");
    }
    const issue = await res.json();
    return new Response(JSON.stringify({ number: issue.number, url: issue.html_url }), { status: 201, headers: { "Content-Type": "application/json" } });
  },
};

/** The first line of the note, trimmed to fit an issue title. */
export function titleFor(message) {
  const first = message.split("\n").find((l) => l.trim()) ?? "";
  const clean = first.trim().replace(/\s+/g, " ");
  return clean.length > MAX_TITLE ? clean.slice(0, MAX_TITLE - 1).trimEnd() + "…" : clean;
}

/** What the app said about itself, kept to short plain strings. */
export function detail(app) {
  const out = {};
  if (app && typeof app === "object") {
    for (const k of ["version", "os", "arch"]) if (typeof app[k] === "string" && app[k].length <= 40) out[k] = app[k];
  }
  return out;
}

export function issueBody(message, email, app) {
  const quoted = message.split("\n").map((l) => `> ${l}`).join("\n");
  const lines = ["Sent from the app with **Send feedback**.", "", quoted, ""];
  lines.push(`**Contact:** ${email ? email : "none given"}`);
  const parts = [app.version && `Nested ${app.version}`, app.os && `${app.os}${app.arch ? ` ${app.arch}` : ""}`].filter(Boolean);
  if (parts.length) lines.push(`**App:** ${parts.join(", ")}`);
  return lines.join("\n");
}

function text(status, message) {
  return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

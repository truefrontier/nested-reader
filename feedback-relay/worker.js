// Feedback relay: a Cloudflare Worker (or, through server.mjs, a Fly machine) that takes a note
// from the Send feedback box in Nested and files it as a GitHub issue on this repo. It also serves
// the app's updates from the repo's releases (updates.js). The app never holds a GitHub token;
// only this relay does.
//
// Deploy with `wrangler deploy` from this folder, then `wrangler secret put GITHUB_TOKEN` with a
// fine-grained token that has Issues: read and write and Contents: read and write on the repo (write
// lets a feedback screenshot be committed to its own branch; see uploadAttachment). See README.md.

import { handleUpdates } from "./updates.js";

const MAX_MESSAGE = 5000;
const MAX_EMAIL = 200;
const MAX_TITLE = 72;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const ATTACHMENT_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const ATTACHMENTS_BRANCH = "feedback-attachments";

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

    let attachmentUrl;
    if (body?.attachment !== undefined) {
      const attachment = validAttachment(body.attachment);
      if (!attachment) return text(400, "That screenshot didn't look right");
      try {
        attachmentUrl = await uploadAttachment(env, attachment);
      } catch (e) {
        // The note matters more than the picture: file it anyway rather than losing the feedback.
        console.error("Couldn't upload the screenshot", e);
      }
    }

    const res = await gh(env, `/repos/${env.GITHUB_REPO}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: titleFor(message), body: issueBody(message, email, app, attachmentUrl), labels: [env.LABEL || "feedback"] }),
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

/** The screenshot as the frontend sent it, or null when it isn't a small, supported image. */
export function validAttachment(a) {
  if (!a || typeof a !== "object") return null;
  const ext = ATTACHMENT_EXT[a.mime];
  if (!ext) return null;
  const data = typeof a.data === "string" ? a.data : "";
  // Base64 runs about 4/3 the size of the bytes it holds; this bounds it without decoding first.
  if (!data || data.length > (MAX_ATTACHMENT_BYTES * 4) / 3 + 4) return null;
  const name = typeof a.name === "string" && a.name.trim() ? a.name.trim().slice(0, 100) : `screenshot.${ext}`;
  return { mime: a.mime, ext, name, data };
}

/**
 * Commits the screenshot to a branch of its own, away from the app's history, and returns a raw URL an
 * issue body can embed. GitHub has no plain "upload an asset" endpoint for a token, so the Contents API
 * stands in for one; the branch is created from the repo's default branch the first time this runs.
 */
async function uploadAttachment(env, attachment) {
  const branch = env.ATTACHMENTS_BRANCH || ATTACHMENTS_BRANCH;
  await ensureBranch(env, branch);
  const path = `attachments/${Date.now()}-${crypto.randomUUID()}.${attachment.ext}`;
  const res = await gh(env, `/repos/${env.GITHUB_REPO}/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({ message: `Feedback screenshot: ${attachment.name}`, content: attachment.data, branch }),
  });
  if (!res.ok) throw new Error(`GitHub refused the screenshot upload (${res.status})`);
  return `https://raw.githubusercontent.com/${env.GITHUB_REPO}/${branch}/${path}`;
}

/** Creates the attachments branch, at the tip of the default branch, the first time it's needed. */
async function ensureBranch(env, branch) {
  if ((await gh(env, `/repos/${env.GITHUB_REPO}/git/ref/heads/${branch}`)).ok) return;
  const repoRes = await gh(env, `/repos/${env.GITHUB_REPO}`);
  if (!repoRes.ok) throw new Error("Couldn't read the repo");
  const { default_branch } = await repoRes.json();
  const baseRef = await gh(env, `/repos/${env.GITHUB_REPO}/git/ref/heads/${default_branch}`);
  if (!baseRef.ok) throw new Error("Couldn't read the default branch");
  const { object } = await baseRef.json();
  const created = await gh(env, `/repos/${env.GITHUB_REPO}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: object.sha }) });
  // A 422 here means another request just created the same branch; either way it now exists.
  if (!created.ok && created.status !== 422) throw new Error("Couldn't create the attachments branch");
}

function gh(env, path, init) {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "nested-feedback-relay",
      ...init?.headers,
    },
  });
}

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

export function issueBody(message, email, app, attachmentUrl) {
  const quoted = message.split("\n").map((l) => `> ${l}`).join("\n");
  const lines = ["Sent from the app with **Send feedback**.", "", quoted, ""];
  if (attachmentUrl) lines.push(`![Screenshot](${attachmentUrl})`, "");
  lines.push(`**Contact:** ${email ? email : "none given"}`);
  const parts = [app.version && `Nested ${app.version}`, app.os && `${app.os}${app.arch ? ` ${app.arch}` : ""}`].filter(Boolean);
  if (parts.length) lines.push(`**App:** ${parts.join(", ")}`);
  return lines.join("\n");
}

function text(status, message) {
  return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

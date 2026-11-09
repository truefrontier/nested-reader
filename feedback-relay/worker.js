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
// Every screenshot is committed to the repo for good, so it stays small. Base64 runs about 4/3 the size of
// the bytes it holds, which bounds the string without decoding it first.
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const MAX_ATTACHMENT_BASE64 = (MAX_ATTACHMENT_BYTES * 4) / 3 + 4;
const ATTACHMENT_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const ATTACHMENTS_BRANCH = "feedback-attachments";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/updates")) return handleUpdates(request, env, url);
    if (request.method !== "POST") return text(405, "POST only");
    // A web page can have its visitors' browsers post plain text to any URL without asking first. JSON
    // makes a browser ask (a CORS preflight), and the relay never answers yes. The app sends JSON.
    if (!/^application\/json\s*(;|$)/i.test(request.headers.get("content-type") || "")) return text(415, "Send the note as JSON");
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
    let email = typeof body?.email === "string" ? body.email.trim() : "";
    if (email && (email.length > MAX_EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return text(400, "That email address doesn't look right");
    const app = detail(body?.app);
    let attachment = null;
    if (body?.attachment !== undefined) {
      // An older app lets 5 MB through, so say why rather than calling the picture malformed.
      if (body.attachment?.data?.length > MAX_ATTACHMENT_BASE64) return text(413, "Keep the screenshot under 2 MB.");
      attachment = validAttachment(body.attachment);
      if (!attachment) return text(400, "That screenshot didn't look right");
    }

    // Anyone who can read the repo can read the issue and the screenshot's branch, so an email or a
    // screenshot goes only to a repo GitHub says is private. Public, or no answer, files the note without them.
    let withheld = [];
    if ((email || attachment) && !(await repoIsPrivate(env))) {
      withheld = [email && "email", attachment && "screenshot"].filter(Boolean);
      email = "";
      attachment = null;
    }

    let attachmentUrl;
    if (attachment) {
      try {
        attachmentUrl = await uploadAttachment(env, attachment);
      } catch (e) {
        // The note matters more than the picture: file it anyway rather than losing the feedback.
        console.error("Couldn't upload the screenshot", e);
      }
    }

    const res = await gh(env, `/repos/${env.GITHUB_REPO}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: unmention(titleFor(message)), body: unmention(issueBody(message, email, app, attachmentUrl, withheld)), labels: [env.LABEL || "feedback"] }),
    });
    if (!res.ok) {
      const why = await res.text().catch(() => "");
      console.error("GitHub refused the issue", res.status, why.slice(0, 300));
      return text(502, "GitHub didn't accept the note");
    }
    const issue = await res.json();
    const answer = { number: issue.number, url: issue.html_url };
    if (withheld.length) answer.withheld = withheld;
    return new Response(JSON.stringify(answer), { status: 201, headers: { "Content-Type": "application/json" } });
  },
};

/**
 * Whether GitHub says GITHUB_REPO is private, asked afresh for each note that carries an email or a
 * screenshot, just before either is posted: a remembered "private" would keep posting them for as long as
 * it was kept after the repo went public. A failed lookup counts as public.
 */
async function repoIsPrivate(env) {
  try {
    const res = await gh(env, `/repos/${env.GITHUB_REPO}`);
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    return (await res.json())?.private === true;
  } catch (e) {
    console.error("Couldn't tell whether the repo is private, so the email and screenshot are held back", e);
    return false;
  }
}

/**
 * The screenshot as the frontend sent it, or null when it isn't a small, supported image. Its first bytes,
 * not the type it was sent with, decide which kind it is: the Contents API commits whatever it is given.
 */
export function validAttachment(a) {
  if (!a || typeof a !== "object" || !ATTACHMENT_EXT[a.mime]) return null;
  const data = typeof a.data === "string" ? a.data : "";
  if (!data || data.length > MAX_ATTACHMENT_BASE64) return null;
  const mime = imageType(data);
  if (!mime) return null;
  // `name` is ignored: the file is stored under a name the relay makes up (see uploadAttachment).
  return { mime, ext: ATTACHMENT_EXT[mime], data };
}

/** PNG, JPEG, GIF or WebP, read from the first 12 bytes of the base64; undefined for anything else. */
function imageType(base64) {
  let head;
  try {
    head = atob(base64.slice(0, 16));
  } catch {
    return undefined;
  }
  if (head.startsWith("\x89PNG\r\n\x1a\n")) return "image/png";
  if (head.startsWith("\xff\xd8\xff")) return "image/jpeg";
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  return undefined;
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
    body: JSON.stringify({ message: "Feedback screenshot", content: attachment.data, branch }),
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

/** What the app said about itself, kept to short words like "0.2.25", "macos" and "aarch64". */
export function detail(app) {
  const out = {};
  if (app && typeof app === "object") {
    for (const k of ["version", "os", "arch"]) if (typeof app[k] === "string" && /^[\w.+-]{1,40}$/.test(app[k])) out[k] = app[k];
  }
  return out;
}

/**
 * Breaks each @mention with a zero-width space after the @, so the text reads as typed but pings no one,
 * and each #123, owner/repo#123 and GH-123 reference the same way, so a note can't leave "mentioned this"
 * marks on this repo's issues or anyone else's. A # inside a word or a link (page#2) is left alone. A
 * pasted issue URL still links, and so still marks that issue.
 * The issue is filed as the token's owner, so a mention would come from that account, and an "@claude"
 * in an issue its owner opened starts .github/workflows/claude.yml. An @ after a letter or digit, as in
 * an email address, is no mention to GitHub and is left alone.
 */
export function unmention(s) {
  return s
    .replace(/(^|[^A-Za-z0-9_])@(?=[A-Za-z0-9])/g, "$1@\u200b")
    .replace(/(^|[^\w/#&.-])#(?=\d)/g, "$1#\u200b")
    // owner/repo#123 after anything but a letter, ".", ":", "/" or "-", so a URL's path#2 is left alone.
    .replace(/(^|[^\w.:/-])([\w.-]+\/[\w.-]+)#(?=\d)/g, "$1$2#\u200b")
    .replace(/(^|\W)GH-(?=\d)/g, "$1GH-\u200b");
}

export function issueBody(message, email, app, attachmentUrl, withheld = []) {
  // Nothing in the note may hide text from a person reading the issue, since Claude, reading the raw text,
  // would still follow it: a "<" shows as written (no HTML comment), and so does a line that would be a
  // markdown link definition ("[x]: url", which renders as nothing).
  const quoted = message
    .split("\n")
    .map((l) => `> ${l.replaceAll("<", "&lt;").replace(/^(\s{0,3})\[/, "$1\\[")}`)
    .join("\n");
  const lines = ["Sent from the app with **Send feedback**.", "", quoted, ""];
  if (attachmentUrl) lines.push(`![Screenshot](${attachmentUrl})`, "");
  const held = "withheld, because the relay couldn't confirm this repository is private";
  lines.push(`**Contact:** ${email ? email : withheld.includes("email") ? held : "none given"}`);
  if (withheld.includes("screenshot")) lines.push(`**Screenshot:** ${held}`);
  const parts = [app.version && `Nested ${app.version}`, app.os && `${app.os}${app.arch ? ` ${app.arch}` : ""}`].filter(Boolean);
  if (parts.length) lines.push(`**App:** ${parts.join(", ")}`);
  return lines.join("\n");
}

function text(status, message) {
  return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

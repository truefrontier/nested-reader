// App updates: the repository is private, so the app cannot read its releases directly. These
// routes read them with the relay's token and hand the app what the Tauri updater expects.
//
//   GET /updates/latest.json            the newest release's updater manifest, download links
//                                       pointed back at this relay (204 when nothing is published)
//   GET /updates/download/<id>/<name>   302 to a short-lived GitHub link for that release asset
//   GET /updates/dmg                    302 to the newest release's .dmg, for a first install
//
// The token needs Contents: read on the repository (Issues: write for feedback is not enough).

const CACHE_MS = 60_000;
const MANIFEST = "latest.json";

/** The latest release, remembered for a minute so a wave of launches costs one GitHub call. */
let cached = { at: 0, repo: "", release: null };

export async function handleUpdates(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return text(405, "GET only");
  if (!env.GITHUB_TOKEN) return text(500, "The relay has no GITHUB_TOKEN set");
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPO || "")) return text(500, "The relay has no GITHUB_REPO set");

  const path = url.pathname.replace(/\/+$/, "");
  const origin = publicOrigin(request, url);

  if (path === "/updates/latest.json") {
    const release = await latestRelease(env);
    const asset = release?.assets.find((a) => a.name === MANIFEST);
    if (!asset) return new Response(null, { status: 204 });
    const res = await githubAsset(env, asset.id);
    if (!res.ok) return text(502, "GitHub didn't hand over the update manifest");
    let manifest;
    try {
      manifest = await res.json();
    } catch {
      return text(502, "The update manifest isn't JSON");
    }
    return new Response(JSON.stringify(rewriteManifest(manifest, release.assets, origin)), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  const download = path.match(/^\/updates\/download\/(\d+)\/[^/]+$/);
  if (download) {
    const res = await githubAsset(env, download[1], "manual");
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) return Response.redirect(location, 302);
    if (res.status === 404) return text(404, "No such release asset");
    return text(502, "GitHub didn't hand over the download");
  }

  if (path === "/updates/dmg") {
    const release = await latestRelease(env);
    const dmg = release?.assets.find((a) => a.name.endsWith(".dmg"));
    if (!dmg) return text(404, "Nothing has been released yet");
    return Response.redirect(downloadUrl(origin, dmg), 302);
  }

  return text(404, "Not found");
}

/** The newest published release (drafts and pre-releases left out), or null when there is none. */
async function latestRelease(env) {
  const now = Date.now();
  if (cached.release !== null && cached.repo === env.GITHUB_REPO && now - cached.at < CACHE_MS) return cached.release || null;
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/releases/latest`, { headers: githubHeaders(env, "application/vnd.github+json") });
  let release = null;
  if (res.ok) {
    const body = await res.json();
    release = { tag: body.tag_name, assets: (body.assets || []).map((a) => ({ id: a.id, name: a.name })) };
  } else if (res.status !== 404) {
    console.error("GitHub refused the release lookup", res.status);
    return null;
  }
  cached = { at: now, repo: env.GITHUB_REPO, release: release ?? false };
  return release;
}

/** Fetches a release asset's bytes; with `redirect: "manual"` just the 302 to GitHub's signed link. */
function githubAsset(env, id, redirect = "follow") {
  return fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/releases/assets/${id}`, { headers: githubHeaders(env, "application/octet-stream"), redirect });
}

function githubHeaders(env, accept) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "nested-feedback-relay",
  };
}

/** Points each platform's download at this relay, by matching the asset name at the end of the URL. */
export function rewriteManifest(manifest, assets, origin) {
  const platforms = {};
  for (const [key, entry] of Object.entries(manifest.platforms || {})) {
    const name = assetName(entry.url);
    const asset = assets.find((a) => a.name === name);
    platforms[key] = asset ? { ...entry, url: downloadUrl(origin, asset) } : entry;
  }
  return { ...manifest, platforms };
}

export function assetName(url) {
  try {
    const last = new URL(url).pathname.split("/").pop() ?? "";
    return decodeURIComponent(last);
  } catch {
    return "";
  }
}

export function downloadUrl(origin, asset) {
  return `${origin}/updates/download/${asset.id}/${encodeURIComponent(asset.name)}`;
}

/** The origin the app reached us on; behind Fly's proxy the scheme arrives in a header. */
export function publicOrigin(request, url) {
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim() || url.protocol.replace(":", "");
  return `${proto}://${url.host}`;
}

/** Forgets the remembered release; tests use it. */
export function forgetLatest() {
  cached = { at: 0, repo: "", release: null };
}

function text(status, message) {
  return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

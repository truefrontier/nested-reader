# Feedback relay

The **Send feedback** link at the bottom of the app's sidebar posts a note to this worker, and the worker files it as an issue on `truefrontier/nested-reader` labelled `feedback`. The worker also serves the app's updates: the repository is private, so installed copies ask it, not GitHub, for the newest release. The app itself never holds a GitHub token; only the worker does, as a secret.

It is two files with no dependencies (`worker.js` for feedback, `updates.js` for updates), written for Cloudflare Workers; `server.mjs` runs the same code on Fly, through `handler.js`, which turns Node requests into the Fetch requests the worker takes.

## Deploy

### Cloudflare Workers

```bash
cd feedback-relay
npx wrangler login
npx wrangler deploy
npx wrangler secret put GITHUB_TOKEN
```

The token is a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) scoped to this one repository with **Issues: Read and write** and **Contents: Read and write** (releases count as contents; write lets a feedback screenshot be committed to its own `feedback-attachments` branch). Nothing else. Issues are filed under the account that made the token.

`wrangler deploy` prints the worker's URL. Put it in `src-tauri/.cargo/config.toml` as `NESTED_FEEDBACK_URL` and rebuild the app; until then the box in the app says feedback is not set up in this build.

### Fly.io (no Cloudflare account required)

```bash
cd feedback-relay
fly launch --no-deploy  # Creates the app; say no to postgres/redis
fly secrets set GITHUB_TOKEN=ghp_your_token_here
fly deploy
```

The app scales to zero when idle and wakes on the first request. `fly deploy` prints the app's URL (typically `https://nested-feedback.fly.dev`). Put it in `src-tauri/.cargo/config.toml` as `NESTED_FEEDBACK_URL` and rebuild the app.

## Updates

Three `GET` routes read the newest published release (drafts and pre-releases left out) with the token:

| Route | Answer |
| --- | --- |
| `/updates/latest.json` | The release's `latest.json` (the manifest `tauri-action` attaches), with each download `url` pointed at this relay. `204` when nothing is published yet, which the app reads as "up to date". |
| `/updates/download/<asset id>/<name>` | `302` to GitHub's short-lived signed link for that asset, so the bytes never pass through the relay. |
| `/updates/dmg` | `302` to the newest `.dmg`, a stable link for a first install. |

The release lookup and its `latest.json` are remembered for a minute, so a wave of launches costs two GitHub calls a minute at most. A lookup GitHub refuses (a lapsed token, a spent rate limit) is remembered for 10 seconds, so the launches don't keep the limit spent by asking again each time. A download link is handed out only for an asset of that release; any other asset id gets a `404` without a call to GitHub. The app's updater endpoint is `plugins.updater.endpoints` in `src-tauri/tauri.conf.json`; it passes `version`, `target` and `arch`, which the relay ignores (the updater compares versions itself and verifies the bundle's signature against the public key in the same file).

The links in `latest.json` and the `/updates/dmg` redirect start with `PUBLIC_ORIGIN` when it is set: the scheme and host the app uses, such as `https://nested-feedback.fly.dev`, with no path. When it is unset or empty, they start with the request's own `Host` and, on Fly, its `X-Forwarded-Proto`. The caller writes both, but the answer goes back only to that caller, and the updater checks the bundle's signature anyway, so this is a pin, not a fix for an open hole. To set it, put it under `[env]` in `fly.toml` or `[vars]` in `wrangler.toml` and deploy.

Try it:

```bash
curl -i "$NESTED_FEEDBACK_URL/updates/latest.json"
curl -I "$NESTED_FEEDBACK_URL/updates/dmg"
```

## What feedback accepts

`POST` with a JSON body:

```json
{
  "message": "The tree loses my place when…",
  "email": "me@example.com",
  "attachment": { "name": "shot.png", "mime": "image/png", "data": "<base64>" },
  "app": { "version": "0.1.0", "os": "macos", "arch": "aarch64" }
}
```

`email`, `attachment` and `app` are optional. The note becomes the issue body (quoted), the first line its title, and the contact line carries the email when one was given, so a reply can go back to the person. Every `@mention`, and every `#123`, `owner/repo#123` and `GH-123` reference, in the title and body gets a zero-width space after its `@`, `#` or `-`, so it reads as typed but pings no one and marks no issue. An email address and a `#` inside a word or a link (`page#2`) are left alone, and a pasted issue URL still links. A `<` in the note shows as written, and so does a line that would be a markdown link definition (`[x]: url`), so neither an `<!-- comment -->` nor a definition can hide text from a person reading the issue. The `app` fields are kept only when each is one short word such as `0.2.25`, `macos` or `aarch64`. Notes over 5000 characters, screenshots over 2 MB, malformed emails, and a body not sent as `Content-Type: application/json` are refused with a plain-text reason the app shows as is.

An email or a screenshot goes only to a private repository. Before it uses either one, the relay asks GitHub whether `GITHUB_REPO` is private (`GET /repos/{repo}`, which any token that can file issues may read). It asks for every note that carries either, right before posting it, so a repository made public is caught on the very next note; a note with neither never asks. If the repository is public, or GitHub doesn't answer, the note is still filed, without the email and without the screenshot. The issue notes that they were withheld, and the relay's answer lists them:

```json
{ "number": 42, "url": "https://github.com/…/issues/42", "withheld": ["email", "screenshot"] }
```

`truefrontier/nested-reader` is public, so for now every email and screenshot is held back. Pointing `GITHUB_REPO` at a private repository, with a token scoped to it, brings them back.

In a private repository, a screenshot (`attachment`, PNG/JPEG/GIF/WebP, up to 2 MB, base64 in `data` without a `data:` prefix; its first bytes must be one of those four, and they, not `mime`, decide which) is committed to a `feedback-attachments` branch of its own, created from the default branch the first time one is needed, under a file name the relay makes up and the commit message `Feedback screenshot` (the `name` sent with it is ignored), and embedded in the issue by its raw URL. Uploading it costs a few extra GitHub API calls; if that upload fails, the note is still filed, just without the picture.

Try it:

```bash
curl -X POST "$NESTED_FEEDBACK_URL" -H 'Content-Type: application/json' -d '{"message":"Test from curl"}'
```

## Test

```bash
node --test
```

## Limits

Anyone who finds the URL can file issues or download the app. Each note is filed under the token owner's account, costs a GitHub API call (a few more for a screenshot in a private repository), and starts the Feedback Triage workflow, which runs Claude on the `CLAUDE_CODE_OAUTH_TOKEN` subscription. So the relay holds back what it can:

- **On Fly** (`server.mjs` through `handler.js`), one address may send 5 notes an hour, and everyone together 30. Past that the relay answers `429` with a `Retry-After`, before it reads the body. The address is `Fly-Client-IP`, which Fly's proxy sets on every request; `X-Forwarded-For` is never read, since a caller can write anything there. Off Fly (`FLY_APP_NAME` unset) the socket's address is used. An IPv6 address counts by its /64. The counts live in the machine's memory: each machine counts on its own, and a restart starts over.
- A note must say it is JSON, so a web page can't have its visitors' browsers post notes for it.
- A mention in a note can't ping anyone, and `claude.yml` skips issues labelled `feedback`, so a note can't start Claude with write access.
- Update checks cost two GitHub calls a minute at most (see [Updates](#updates)).

### On Cloudflare: add a rate limiting rule (Kevin)

`worker.js` alone has no note limit: each request may land on a different isolate, so there is no memory to count in. Cloudflare's [rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/) cover that, with no code change, but only for a zone you own. They don't apply on `*.workers.dev`, which is Cloudflare's zone.

1. Serve the worker on a custom domain or route in your zone (the worker's **Settings** › **Domains & Routes**), and point `NESTED_FEEDBACK_URL` at it.
2. In the zone, open **Security rules** and select **Create rule** › **Rate limiting rules**.
3. Match **URI Path** equals `/`. That is the feedback `POST`; `/updates/…` stays unlimited.
4. Count by **IP**. On the Free plan the only choice is 10 seconds: about 3 requests per 10 seconds, blocked for 10 seconds. On Pro, use 5 requests per minute, blocked for an hour, and a custom text response such as "Too many notes. Try again in an hour." (the app shows plain text as is).
5. Set the action to **Block**, then select **Deploy**.

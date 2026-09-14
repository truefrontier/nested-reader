# Feedback relay

The **Send feedback** link at the bottom of the app's sidebar posts a note to this worker, and the worker files it as an issue on `truefrontier/nested-reader` labelled `feedback`. The worker also serves the app's updates: the repository is private, so installed copies ask it, not GitHub, for the newest release. The app itself never holds a GitHub token; only the worker does, as a secret.

It is two files with no dependencies (`worker.js` for feedback, `updates.js` for updates), written for Cloudflare Workers; `server.mjs` runs the same code on Fly.

## Deploy

### Cloudflare Workers

```bash
cd feedback-relay
npx wrangler login
npx wrangler deploy
npx wrangler secret put GITHUB_TOKEN
```

The token is a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) scoped to this one repository with **Issues: Read and write** and **Contents: Read** (releases count as contents). Nothing else. Issues are filed under the account that made the token.

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

The release lookup is remembered for a minute, so a wave of launches costs one GitHub call. The app's updater endpoint is `plugins.updater.endpoints` in `src-tauri/tauri.conf.json`; it passes `version`, `target` and `arch`, which the relay ignores (the updater compares versions itself and verifies the bundle's signature against the public key in the same file).

Try it:

```bash
curl -i "$NESTED_FEEDBACK_URL/updates/latest.json"
curl -I "$NESTED_FEEDBACK_URL/updates/dmg"
```

## What feedback accepts

`POST` with a JSON body:

```json
{ "message": "The tree loses my place when…", "email": "me@example.com", "app": { "version": "0.1.0", "os": "macos", "arch": "aarch64" } }
```

`email` and `app` are optional. The note becomes the issue body (quoted), the first line its title, and the contact line carries the email when one was given, so a reply can go back to the person. The repository is private, so the email is seen only by its collaborators. Notes over 5000 characters and malformed emails are refused with a plain-text reason the app shows as is.

Try it:

```bash
curl -X POST "$NESTED_FEEDBACK_URL" -H 'Content-Type: application/json' -d '{"message":"Test from curl"}'
```

## Test

```bash
node --test
```

## Limits

Anyone who finds the URL can file issues or download the app. The worker refuses anything but a small JSON note, and each note (and each update check, at most one a minute) costs a GitHub API call against the token's rate limit. If that becomes a problem, add a [rate limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) on the worker's route in the Cloudflare dashboard, which needs no code change.

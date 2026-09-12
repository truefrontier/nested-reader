# Feedback relay

The **Send feedback** link at the bottom of the app's sidebar posts a note to this worker, and the worker files it as an issue on `truefrontier/nested-reader` labelled `feedback`. The app itself never holds a GitHub token; only the worker does, as a secret.

It is one file with no dependencies, written for Cloudflare Workers.

## Deploy

```bash
cd feedback-relay
npx wrangler login
npx wrangler deploy
npx wrangler secret put GITHUB_TOKEN
```

The token is a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) scoped to this one repository with **Issues: Read and write**. Nothing else. Issues are filed under the account that made the token.

`wrangler deploy` prints the worker's URL. Put it in `src-tauri/.cargo/config.toml` as `NESTED_FEEDBACK_URL` and rebuild the app; until then the box in the app says feedback is not set up in this build.

## What it accepts

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

Anyone who finds the URL can file issues. The worker refuses anything but a small JSON note, and each note costs a GitHub API call against the token's rate limit. If that becomes a problem, add a [rate limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) on the worker's route in the Cloudflare dashboard, which needs no code change.

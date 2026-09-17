# Deployment and distribution

## Local artifacts ready to publish

Run `npm run package:mac`. Upload the contents of `release/website/` to a static host configured for `nestedreader.app`. The marketing homepage is prerendered HTML with locally bundled fonts and assets; JavaScript enables the illustrative questions, navigation, and privacy disclosure. The folder also contains `downloads/Nested-arm64.zip` and an `/app/index.html` entry.

Serve `/app` as `/app/index.html` (or enable directory indexes). That route explains that the reader requires a local service and offers the desktop download on a static host. It is not a hosted personal workspace. Never proxy the private local API to the public website.

Use HTTPS. Serve `.zip` with `application/zip`, cache hashed assets immutably, and keep HTML and downloads on a shorter cache policy. Canonical URL, sitemap, and robots metadata target `https://nestedreader.app`. The API, settings, and personal books are not part of the static deployment.

## External configuration still needed

- A hosting account/deployment destination and its credentials.
- DNS configuration for `nestedreader.app`, then HTTPS verification.
- An OpenAI API key with `gpt-6-astra` access to validate real AI output, latency, refusals, and account billing behavior.
- Developer ID credentials and notarization for normal public Mac distribution. The local preview is ad-hoc signed only. No Gatekeeper distribution claim has been made.

No domain records, external hosting account, Product Hunt draft, messages, payment service, or other repository was modified.

## Packaging design

Electron starts a loopback Express service on an ephemeral port and loads its bundled reader. The renderer has no Node integration, uses context isolation and sandboxing, and receives only a narrow reveal-library IPC capability. External windows are denied and HTTPS links open in the system browser only when clicked by the user. Download save dialogs default to the portable data folder. AI keys remain in the local service.

`NESTED_SMOKE=1` validates packaged imports, the bundled assets, bootstrap model, sample corpus, and reader HTTP route without creating a BrowserWindow. This verifies executable startup and service integration, not visual rendering.

## Icon source

The icon is derived only from `public/mark.svg`, authored for this implementation. Reusable source, rounded preview, PNG, SVG layers, origin evidence, spec, and verification reports are under `desktop/icon/`. The native static ICNS is `desktop/Nested.icns`, assembled with macOS `sips` and `iconutil`. No Icon Composer or automatic light/dark variant is claimed.

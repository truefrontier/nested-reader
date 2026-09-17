# Verification report

Validated 2026-09-16 CT in `/Users/kk/Projects/PROJ-nested-reader/astra-version`. All code, dependencies, fixtures, runtime data, caches, and build artifacts stayed within this workspace. No other project was inspected or used. No Computer Use or browser was used for this verification pass.

| Requirement | Current evidence | Result |
| --- | --- | --- |
| Fresh reader from the supplied briefs | `PRODUCT.md`, `src/Reader.tsx`, `server/`, sample corpus | Implemented |
| Imports, pasted documents, selection, questions, navigation | `tests/ui.test.tsx`, real API integration tests | Passed in jsdom + HTTP |
| Quick Answer, New Page, Deep Dive, Refine, Research | Per-mode API tests with injected provider responses | Passed orchestration and persistence tests |
| Multi-step research with linked chapters | Research test asserts planning request, 3 source reads, 2 linked `.md` children, quote-check stage | Passed |
| Persistence, edits, revisions, restoration, source-change review | `tests/store.test.mjs`, API and DOM workflow tests | Passed |
| Notes, source citations, export and reimport | Store/API tests and DOM note test | Passed |
| Literal untrusted front matter, missing keys, cancellation, race handling | Store, API, and transport tests | Passed |
| GPT-6 Astra only | `server/ai.mjs`, transport assertion and no-fallback test | `gpt-6-astra` pinned |
| Responsive marketing implementation and content | CSS breakpoints, prerendered `release/website/index.html`, DOM interaction test | Built; visual browser rendering not checked |
| TypeScript and production build | `npm run build`, also executed by package script | Passed |
| Automated suite | `npm test`, 33 tests | 33 passed, 0 failed |
| Mac package | `npm run package:mac`; `artifacts/package.log` | Passed |
| Packaged executable startup | `npm run smoke:desktop`; `artifacts/desktop-smoke.log` | Passed, no BrowserWindow created |
| Signature | `codesign --verify --deep --strict release/mac-arm64/Nested.app` | Passed ad-hoc signature check |
| Download integrity | `cd release && shasum -a 256 -c SHA256SUMS` | Passed |
| Development server and Vite proxy | `npm run dev`; curl GET `/` and `/app`; `artifacts/dev-smoke.json` | Passed |
| Production routes and protected API | `npm run smoke`; `artifacts/production-smoke.json` | Passed |
| Mac download link | HTTP HEAD `/downloads/Nested-arm64.zip` through dev proxy and production service | 200 |
| Icon | Reusable project-local SVG/PNG, 1024px and 64px inspection, skill verifier, ICNS decode | Passed; static ICNS only |

## Produced artifacts

- `release/mac-arm64/Nested.app`, Apple silicon macOS preview.
- `release/Nested-arm64.zip`, the downloadable preview.
- `release/website/`, the deployable static marketing site with download and `/app` entry page.
- `release/SHA256SUMS`, ZIP checksum.
- `desktop/Nested.icns` and reusable icon source/preview/layers/reports under `desktop/icon/`.
- `artifacts/tests.log`, `package.log`, `desktop-smoke.log`, `dev-smoke.json`, and `production-smoke.json`.

## Explicitly not verified or deployed

No `OPENAI_API_KEY` was present. Every AI-mode test uses an injected deterministic provider fixture, not an alternative AI model. Live GPT-6 access, generated-answer quality, latency, account quotas, and billing behavior remain unverified. The missing-key workflow was tested and produces a setup message without saving fake explanations.

No visual browser check was performed, per the user's no-browser instruction. DOM tests establish interaction and persistence behavior, not pixel layout or browser rendering. CSS includes mobile/tablet/desktop layouts and reduced-motion handling; these are not represented as a completed visual audit.

The package is ad-hoc signed only. Developer ID signing, notarization, Gatekeeper behavior on another machine, and Intel compatibility remain outside the verified preview. The packaged service smoke validates actual executable/module startup and HTTP assets, not a GUI window.

No hosting, DNS, TLS, Product Hunt launch, analytics, subscriptions, or billing service has been configured. The local Express service is personal and loopback-only; deploy the static website separately.

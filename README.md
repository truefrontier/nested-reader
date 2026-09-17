# Nested

A fresh local Markdown reader and marketing website for `nestedreader.app`, built from `nested-startup-pitch.md` and `nested-astra-ph-brief.md` in this folder. No other Nested implementation is used.

Open the plan your AI wrote, select a passage, and follow your questions into connected explanations. All AI features use **`gpt-6-astra`** through OpenAI's Responses API. There is no alternate model or canned-answer mode.

## Run locally

Requires Node 22.12+ and npm. Dependencies and caches stay in this project.

```sh
npm ci
npm run dev
```

- Marketing: <http://127.0.0.1:5173/>
- Reader: <http://127.0.0.1:5173/app>
- Local service: <http://127.0.0.1:4317/>

A sample book about background jobs is created on first launch. Reading, importing, editing, notes, search, revision history, the book map, and export work without credentials.

For AI, open **Settings → OpenAI API key**. A key entered there lives only in the running service's memory. Alternatively copy `.env.example` to `.env` and configure `OPENAI_API_KEY`. Use **Check access** to verify your API project's access to GPT-6 Astra. API billing is separate from any ChatGPT subscription.

```sh
npm run build       # Typecheck, bundle, prerender the marketing page
npm start           # Serve the production website and reader on loopback
npm run desktop     # Launch the Electron reader after building
npm run package:mac # Build an Apple silicon .app, ZIP, and static website
```

`package:mac` installs the pinned Electron binary into `node_modules/electron/dist` when needed. Its download/build caches and temporary files are under `.cache/`. The command requires macOS, network access on first use, and the standard `codesign`, `ditto`, and `iconutil` utilities (the icon is already packaged).

## Mac preview and marketing output

- `release/mac-arm64/Nested.app`
- `release/Nested-arm64.zip`
- `release/SHA256SUMS`
- `release/website/` contains the standalone marketing site, `/app` local-service explanation, and ZIP download.

The Mac preview is **ad-hoc signed**, not Developer ID signed or notarized. It is an Apple silicon build. Distribution through Gatekeeper, an Intel build, automatic updates, signing, and notarization are not claimed.

The portable desktop build stores its library/profile beside the `.app` in `Nested Data`. Run it from a writable folder. Development uses `.local/desktop`; the browser service uses `.local/books`. `NESTED_DATA_DIR` overrides the location. All validation here uses paths inside this project. Moving the `.app` alone does not move its adjacent library: keep the data directory with it or export a book first.

## Reader workflows

1. **Open a new book** imports `.md`, `.markdown`, or `.txt` files, a folder, a pasted response, or a Nested ZIP backup. Imports copy files into the managed local library and leave originals untouched.
2. Select a passage to attach a question, or ask about the whole page without selection.
3. **Quick Answer** keeps the answer beside the source. **New Page** and **Deep Dive** save connected explanation pages. Unopened generated pages are marked unread.
4. **Research** asks Astra for a plan and relevant page IDs, reads those pages from the current book, then asks Astra to produce 2–4 linked chapters. Actual plan/read/write/check stages are displayed. This is corpus research, not autonomous web browsing.
5. **Refine** revises the current document and keeps its previous version. **History** compares changes and restores a version without discarding the replaced version.
6. **My notes** separates open questions, your conclusions, and requested changes. **Test understanding** and **Check my explanation** provide optional exercises and feedback. **Review brief** uses the current book and your notes to produce a linked handoff.
7. **Book map** follows source/child relationships. Search matches titles, questions, and document content.
8. **Export book** creates Markdown files with source/model/question metadata, a linked index and review notes, and a JSON backup preserving notes and revisions. Reimport the ZIP to restore the book.

Quotations are checked against the supplied files before pages are saved. A matching quote proves what a document says, not whether its claim is true. Generated explanations are labeled; unresolved evidence is listed. Editing a source marks dependent explanations for review. Refresh detects edits made directly to managed `.md` files. Malicious front matter is treated as text, never executed.

Limits are explicit: 100 files per import, 500,000 characters per file, 20,000 per selected passage, 250,000 characters per AI answer context, and one active AI investigation at a time. Cancel interrupts the request. Source changes during generation reject stale output. No API keys are exported.

## Verification

```sh
npm test              # Unit, real HTTP integration, and jsdom interaction tests
npm run test:e2e      # HTTP integration workflows with an injected provider fixture
npm run smoke         # Isolated production-service checks using fetch
npm run smoke:desktop # Start the packaged executable without creating a window
npm run check         # Build + complete test suite + service smoke
node scripts/smoke.mjs http://127.0.0.1:5173 # Check the running dev server/proxy
```

`tests/` covers import/persistence, literal untrusted front matter, revision recovery, source invalidation, notes, Markdown export/restore, token/origin guards, every AI mode, multi-step research, source quote matching, missing credentials, source races, cancellation, model pinning, React passage selection, book-map navigation, and marketing interactions. AI responses in tests are injected fixtures; no test substitutes a different model or claims to validate live model quality. jsdom is a simulated DOM, not a browser-rendering test.

Current evidence and limitations: [docs/verification.md](docs/verification.md). Hosting instructions: [docs/deployment.md](docs/deployment.md). Scope interpretation: [PRODUCT.md](PRODUCT.md).

## Model provenance and boundaries

The exact model ID was verified against [OpenAI's official model guidance](https://developers.openai.com/api/docs/guides/latest-model). `server/ai.mjs` is the sole generation transport. Requests specify `model: 'gpt-6-astra'`, `store: false`, medium reasoning, and strict structured output. Model-access errors are reported; no fallback is allowed.

Documents stay local until an AI action sends context to OpenAI. Research can send selected pages in the current book; review briefs send the current book. OpenAI's API data policies still apply despite response storage being disabled. The server binds only to `127.0.0.1`; do not expose it as a public multiuser service.

The $15/month plan, teams, public sharing, editor/agent integrations, validation cohorts, and Product Hunt launch are proposals from the founding documents, not implemented commercial offers. There is no subscription billing, telemetry, cloud sync, or public account system in this build.

## Distribution

- Public site download CTA: `/downloads/Nested-arm64.zip` on nestedreader.app (static host).
- CI publishes the same zip to GitHub Releases as tag `astra-v*` on branch `astra` for Server Ops to pull (repo is private — do not expect anonymous GH asset downloads).
- Do not commit the zip into git; attach via release / host upload.

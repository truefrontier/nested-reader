# Nested × GPT-6 Astra Product Hunt brief

**Owner:** Mac Apps (advise) · **Product loop:** Nested Reader unless Kevin routes build here  
**Date:** 2026-09-16 CT · **Status:** draft for Kevin / Nested — not a roadmap commit  
**Canonical intent path:** `/Users/kk/Projects/PROJ-nested-reader/astra-version/nested-astra-ph-brief.md` (Codefi). This box could not SSH to Codefi. Mirrors: `/workspace/PROJ-nested-reader/astra-version/nested-astra-ph-brief.md`; Drive https://drive.google.com/file/d/1Asl9ILLCgWpDLX-N6VSrNk_v8SeiTPRW/view

---

## TLDR for Kevin (≈60s)

1. **Challenge:** OpenAI + Product Hunt “GPT-6 Astra Challenge.” Build something that **uses GPT-6 Astra**, then **launch on Product Hunt on Fri Sep 18, 2026** (contest window **00:00–23:59 PT** = about **2:00a CT Fri → 1:59a CT Sat**). Top **five** launches each get **$10K OpenAI API credits**, **1 year ChatGPT Pro (≤2 team members)**, and **OpenAI promotion**.
2. **Why Nested fits:** Nested already is a calm Mac research reader over a folder of Markdown — select → Quick Answer / New Page / Deep Dive / Refine; session map; folder tools; BYOK + ChatGPT/Claude **plan** modes (including `codex exec`). Astra’s pitch is complex multi-step research/judgment work; Nested’s loop is exactly “stay in the notes, grow the corpus.”
3. **Clock:** ~2 days. Honest path is **ship a sharp Astra-powered demo slice + PH launch**, not a rewrite. Nested owns product; Mac Apps only advises.
4. **Top bets (draft proposals):** (a) first-class **Astra** model path (API + maybe Codex plan), (b) one **research agent** verb that plans→reads folder→writes linked pages with sources, (c) PH-ready **story + demo corpus + Gatekeeper-honest install**.
5. **Decide next (Nested/Kevin):** Enter or skip? Who launches the PH draft? Minimum shippable Astra proof? Public listing vs private repo friction? Notarization / DMG story for hunters?

---

## 1. Challenge rules — gist

### Confirmed (public sources)

| Item | Detail |
| --- | --- |
| Name | **GPT-6 Astra Challenge** — Product Hunt contest, sponsor OpenAI (`theme: openai_day`) |
| Page | https://www.producthunt.com/contests/gpt-6-astra-challenge |
| What to do | **Build with GPT-6 Astra** and **launch the product on Product Hunt** on the contest day — not an idea pitch for OpenAI to build |
| Launch day | **Friday, September 18, 2026** — PH contest `startsAt`/`endsAt` **2026-09-18T00:00:00-07:00 → 23:59:59-07:00** |
| Prizes | **Five** winners: **$10K API credits each**, **1 year ChatGPT Pro for up to two team members**, **OpenAI promotion** |
| Positioning copy | Astra is for “complex, multi-step work—from software engineering and **research** to workflows that require judgment and follow-through” |
| Entry mechanic | Schedule/submit launch via the contest page (PH login). Draft scheduling copy: “Schedule this draft for September 18…” |
| OpenAI community | https://community.openai.com/t/gpt-6-astra-challenge-on-product-hunt/1396727 (announced ~Sep 11) |
| Model | API id **`gpt-6-astra`** — Responses/Chat Completions; strong on research, coding, computer use, docs; tools include web search, file search, computer use, MCP, etc. Pricing ~$10/$50 per 1M in/out (standard) |

### Not found / uncertain (say so)

- **No public official-rules PDF** with formal eligibility, geo restrictions, or detailed **judging criteria** found without a logged-in PH entry form.
- Community thread notes the entry form needs login; **contest-specific IP / AI-training terms** beyond PH’s general license were **not verified**.
- PH general terms (as summarized in community discussion): you keep ownership of the submission, but grant PH a broad worldwide perpetual license to posted material.
- **“Astra provenance / proof”** of using GPT-6 Astra is implied by “build with Astra” but **no published checklist** (model id in settings screenshot? API logs? Codex?) was found.
- Truncated “Launch Guide” shortlink from OpenAI’s PH product page (`producthunt.s.gy/forum-a…`) **resolved to “Link not found”** when fetched; full guide not recovered.
- **Codex “astra 6” CLI challenge docs:** `codex` **not installed on this box**; Codefi SSH timed out — could not run `which codex` / help on machine `c2fd3892-…`. Web research treats Astra as the **model** available in ChatGPT Work, Codex, and API — not a separate Codex subcommand named “astra 6.”

### What we searched

- WebSearch: Product Hunt / OpenAI GPT-6 Astra challenge, Codex “astra 6,” judging/eligibility  
- WebFetch/curl: PH contest page, OpenAI community thread, openai.com Astra work post, developers.openai.com model page, PH newsletter archive  
- Nested GitHub (private, via Nested PAT): README, `docs/architecture.md`, `PROGRESS.md`, code search for astra / Product Hunt → **no local challenge notes**  
- Codefi paths `/Users/kk/Sites/truefrontier/nested-reader/` and `TRUE-mac-apps/notes/` → **unreachable from this box** (SSH timeout)

---

## 2. Nested context (read-only skim)

**What Nested is:** A calm **macOS research reader** (Tauri 2 + React + Rust) for a folder of Markdown. Core loop: open folder/file → select text → **Quick Answer** (inline) / **New Page** (split) / **Deep Dive** (background unread) / **Refine** (tinted undo + versions). Session map; multi-root sessions; plain `.md` on disk with front matter (`source`, `question`, `mode`).

**AI today:** OpenAI / Anthropic / Ollama / Custom BYOK; **ChatGPT plan** via `codex exec`, **Claude plan** via `claude -p`; optional read-only folder tools (`list_pages` / `read_page` / `search_pages`). “Built in” provider UI exists but **not wired**.

**Product problem Kevin named:** Want AI to prep specs/plans without the hassle of reading, rewriting, and bouncing back to chat — **one interface**.

**Ship state (from Nested agent/README):** Early Mac builds (0.1.x), feedback relay + updater path on Fly, Aptabase lean analytics, **ad-hoc / not notarized** historically (Gatekeeper friction for hunters). Domain `nestedreader.app`; marketing site stub. **Nested agent owns product loop.**

---

## 3. Draft feature bets for this challenge

> **Label:** proposals for Nested/Kevin — **not** committed roadmap. Mac Apps does not ship Nested PRs unless Kevin routes.

### Must-show for Astra/PH (high leverage)

1. **Astra as a first-class brain** — Settings › AI: OpenAI models include **`gpt-6-astra`** (and plan/Codex path if Astra is the plan default). Hunter can see “powered by GPT-6 Astra” in one click. *Assumed:* API access available on Kevin’s OpenAI account.
2. **One “Research” multi-step verb** — e.g. from a highlight or ⌘N brief: Astra **plans → tool-reads the folder → writes 1–N linked New Pages / Deep Dives** with front-matter sources and a short map blurb. This is the “complex research + judgment” story PH/OpenAI are selling — Nested already has the corpus substrate.
3. **Demo corpus + 90-second PH video** — ship `examples/…` (or a public sample) that makes the Research verb pop: highlight a claim → watch the tree grow with cited children. Hunter doesn’t need their own notes.

### Strong if time (still Nested-shaped)

4. **Citation / “show your work” strip** — for Quick Answer and Research: which pages were read (tool lines already exist); optional footnote block into the new `.md`.
5. **Session “Astra brief” export** — one Markdown handoff (outline + open questions + links) for posting under the PH launch or hunter follow-ups.
6. **Honest install path for PH day** — stable `/updates/dmg` + Gatekeeper “Open Anyway” card in the hunter post; notarization only if Kevin already has Developer ID ready (don’t block the launch on it).

### Explicit non-goals for this sprint

- Rewriting Nested’s controlling idea or becoming a generic chatbot / Notion clone  
- Computer-use desktop agents outside the notes folder  
- Mac Apps taking Nested’s product loop or shipping PRs unprompted  
- Waiting on full notarization / universal polish if it burns the Sep 18 window  

---

## 4. Controlling-idea spike (light sitting — not a Nested CONTROLLING-IDEA overwrite)

Pattern shape borrowed from controlling-idea-2; **this is a challenge spike only.**

### § One line
**Nested for Astra week:** the Mac research reader that grows a Markdown corpus with GPT-6 Astra — select, ask, and get linked pages you still own as files.

### § What has to be true (worth entering)
- Hunters can **install and complete one research loop in under five minutes** on a sample folder.  
- The loop clearly **uses GPT-6 Astra** (model visible; ambitious multi-step, not a thin wrapper).  
- Output stays **plain Markdown in a folder** — Nested’s wrong-reading of “chat app” stays wrong.  
- Launch lands **on Sep 18 PT** under the contest, with a story that matches Astra’s research positioning.

### § Wrong readings
- “Another ChatGPT wrapper with a prettier pane.”  
- “PKM / second brain / Notion AI.”  
- “Agent that takes over your Mac” (out of scope for this spike).  
- “Mac Apps owns Nested now.”

### § Feels-like bar + tangible anchors
| Bar | Anchor (falsifier) |
| --- | --- |
| Calm, not noisy | No modal spam on first open; one quiet update/feedback affordance max in the hunter path |
| Research, not chat | After one Research verb, the **tree gains ≥2 linked `.md` children** with `source` front matter — not only an inline bubble |
| Own your notes | Hunter can open the folder in Finder/Obsidian and see the same pages |
| Astra-shaped ambition | Demo shows **multi-step folder reads** (tool lines / citations), not a single completion |

### § Shape good-enough for Sep 18
- **Core reader** as today (select → four verbs) — already shippable.  
- **Astra wiring** — good enough when default OpenAI research path is Astra and the PH copy names it.  
- **One new multi-step Research path** — good enough as a thin orchestration over existing New Page / Deep Dive / tools, even if imperfect.  
- **PH listing** — good enough with video, DMG link, Gatekeeper honesty, “built with GPT-6 Astra.”

### § Open questions (Kevin / Nested)
1. **Enter?** Yes / soft-launch only / skip and keep private beta.  
2. **Minimum Astra proof** PH/OpenAI will accept (model picker screenshot vs Codex plan vs API logs)?  
3. **Who files the PH draft** and hunts (Kevin solo, Nested agent copy, friends list)?  
4. **Public artifact:** keep repo private + DMG relay only, or temporary public demo repo/site on `nestedreader.app`?  
5. **Scope cut:** Research verb in two days vs “Astra model in Settings + killer demo of existing verbs” only?  
6. **Credits/plan:** Kevin’s OpenAI org ready for Astra API spend on launch day?

### § Non-goals for next Nested pass
Full controlling-idea rewrite; TF Mac template merge; notarization-as-blocker; Meemo/Mac Apps shipping Nested features without Nested owning the loop.

---

## 5. Suggested next moves (Nested decides)

**If entering (recommended if OpenAI access is ready):**
1. Today CT: Kevin locks enter/skip + PH maker account + Astra API access check.  
2. Nested: wire `gpt-6-astra` + pick one Research orchestration slice **or** double down on existing Deep Dive/tools with Astra default.  
3. Parallel: PH draft (tagline, first comment, 90s Loom), sample corpus, DMG link + Gatekeeper note.  
4. Schedule launch for **Sep 18** on the contest page; rally testers (Jonathan, Jody, Craig, Joel, Zach already on the list).  
5. Mac Apps: stay advisory — install/updater/Gatekeeper copy review if asked; **no Nested PRs** unless routed.

**If skipping:** Still useful to keep Astra in the model menu for later; no PH burn.

---

## Sources & access notes

- PH contest page JSON/HTML (curl): name, starts/ends, prize copy, sponsor OpenAI  
- OpenAI Dev Community thread + PH newsletter (“Build with Astra, win big prizes”)  
- https://openai.com/index/gpt-6-astra-next-generation-work/ · https://developers.openai.com/api/docs/models/gpt-6-astra  
- Nested: `truefrontier/nested-reader` README + `docs/architecture.md` (GitHub API)  
- **Codefi checkout / Codex CLI / TRUE-mac-apps notes dir:** not reachable from this executor box (SSH to Codefi timed out; `codex` absent locally). Nested agent can copy this file into Nested or onto Codefi when convenient.

---


**Drive mirror:** https://drive.google.com/file/d/1Asl9ILLCgWpDLX-N6VSrNk_v8SeiTPRW/view (TRUE-mac-apps/notes)
*Draft by Mac Apps executor · 2026-09-16 CT · advise Nested; Nested keeps the product loop.*

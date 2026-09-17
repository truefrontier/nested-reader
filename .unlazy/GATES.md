# Nested Reader Astra — Gate ledger

Run from repo root:
`node ~/.claude/skills/unlazy/scripts/gate-check.mjs .unlazy/GATES.md .unlazy/gates/*.md`

Leaf proofs: `.unlazy/gates/`. Prefer `grep -E`.

- [x] L1: AppTranslocation fixed
  CHECK: grep -En "getPath\\('userData'\\)" desktop/main.cjs && if grep -Eq "Nested Data|dirname\\(.*execPath" desktop/main.cjs; then echo FAIL; else echo PASS_NO_APP_SIDE_DATA; fi
  EXPECT: /PASS_NO_APP_SIDE_DATA/
  EVIDENCE: 13:      ? app.getPath('userData') | PASS_NO_APP_SIDE_DATA

- [x] L2: Public /app is install guidance
  CHECK: grep -En "Mac app|install-screen|Download for Mac" src/Reader.tsx && grep -En 'href="#download"' src/Marketing.tsx
  EXPECT: /#download/
  EVIDENCE: 4:function ProductSpecimen(){const [example,setExample]=useState(0);const questions=['What does idempotent mean here?','Do we need a separate queue?','What still needs evidence?'];const answers=[<>Thi

- [x] L3: Gatekeeper docs + screenshot
  CHECK: test -f public/images/macos-open-anyway.svg && grep -En "Open Anyway|Applications|macos-open-anyway" src/Marketing.tsx
  EXPECT: /Open Anyway/
  EVIDENCE: 17:<figcaption>Illustrative: System Settings → Privacy &amp; Security → Open Anyway</figcaption> | 27:['Can I use it on my Mac?','Yes. Download the Apple silicon app, move it into Applications, and op

- [x] L4: Auth options without faking ChatGPT API
  CHECK: grep -En "settings/codex|Use local Codex|ChatGPT subscription" server/app.mjs server/codex.mjs src/Reader.tsx src/Marketing.tsx
  EXPECT: /settings\/codex/
  EVIDENCE: src/Marketing.tsx:13:<li><strong>Connect AI.</strong> Paste an OpenAI API key, or use <em>Use local Codex API key</em> when Codex on this Mac already has an API key. A ChatGPT subscription login alone

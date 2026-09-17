# L3 — Gatekeeper docs

- [x] L3: install steps mention Applications and Open Anyway
  CHECK: grep -En "Applications|Open Anyway|Privacy" src/Marketing.tsx
  EXPECT: /Open Anyway/
  EVIDENCE: 27:['Can I use it on my Mac?','Yes. Download the Apple silicon app, move it into Applications, and open it. If macOS blocks the first launch, use System Settings → Privacy & Security → Open Anyway. Th

- [x] L3: screenshot asset exists and is referenced
  CHECK: test -f public/images/macos-open-anyway.svg && grep -En "macos-open-anyway" src/Marketing.tsx
  EXPECT: /macos-open-anyway/
  EVIDENCE: 16:<img src="/images/macos-open-anyway.svg" width="640" height="400" alt="Illustrative macOS Privacy &amp; Security panel showing an Open Anyway button for Nested"/>

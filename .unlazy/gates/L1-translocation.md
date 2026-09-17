# L1 — AppTranslocation

- [x] L1: packaged data uses Electron userData
  CHECK: grep -En "getPath\\('userData'\\)" desktop/main.cjs
  EXPECT: /getPath\('userData'\)/
  EVIDENCE: 13:      ? app.getPath('userData')

- [x] L1: does not place Nested Data beside the .app via execPath
  CHECK: grep -ERn "Nested Data|dirname\\(.*execPath" desktop/main.cjs; if grep -Eq "Nested Data|dirname\\(.*execPath" desktop/main.cjs; then echo FAIL; else echo PASS_NO_APP_SIDE_DATA; fi
  EXPECT: /PASS_NO_APP_SIDE_DATA/
  EVIDENCE: PASS_NO_APP_SIDE_DATA

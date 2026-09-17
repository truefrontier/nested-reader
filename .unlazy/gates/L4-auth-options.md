# L4 — Auth options

- [x] L4: Codex import route exists and refuses ChatGPT-only sessions honestly
  CHECK: grep -En "settings/codex|ChatGPT subscription|canImport|extractCodexApiKey" server/app.mjs server/codex.mjs
  EXPECT: /settings\/codex/
  EVIDENCE: server/codex.mjs:70:  const key = extractCodexApiKey(auth); | server/codex.mjs:76:  return { key, message: 'Imported API key from local Codex for this session. ChatGPT subscription login was not used 

- [x] L4: UI offers paste key and local Codex import
  CHECK: grep -En "Paste an API key|Use local Codex|importCodex" src/Reader.tsx
  EXPECT: /Use local Codex/
  EVIDENCE: 34:async function importCodex(){setSettingsBusy(true);setKeyMessage('');try{const status=await api<{connected:boolean;message:string}>('/settings/codex','POST');setBoot(b=>b?{...b,connected:status.con

- [x] L4: no committed OpenAI sk- secrets in app sources
  CHECK: if grep -ERn "(^|[^A-Za-z0-9])sk-(proj-|svc-)?[A-Za-z0-9]{20,}" --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.cjs' --include='*.json' src server desktop public; then echo FAIL_SECRET; else echo PASS_NO_SK_SECRET; fi
  EXPECT: /PASS_NO_SK_SECRET/
  EVIDENCE: PASS_NO_SK_SECRET

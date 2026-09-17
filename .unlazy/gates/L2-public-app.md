# L2 — Public /app

- [x] L2: fatal/public path presents Mac install guidance
  CHECK: grep -En "Mac app|install-screen|Download for Mac" src/Reader.tsx
  EXPECT: /Mac app|install-screen/
  EVIDENCE: 38: if(fatal)return <main className="connection-screen install-screen"><Brand/><h1>Nested is a Mac app.</h1><p className="install-lede">The public website cannot run the reader in your browser. Downlo

- [x] L2: marketing primary CTAs prefer download, not a fake web reader
  CHECK: grep -En 'href="#download"|href="/downloads/Nested-arm64.zip"|href="/app"' src/Marketing.tsx
  EXPECT: /#download/
  EVIDENCE: 5:export function Marketing(){const [menu,setMenu]=useState(false),[policy,setPolicy]=useState(false);return <div className="marketing"><a href="#main" className="skip-link">Skip to content</a><header

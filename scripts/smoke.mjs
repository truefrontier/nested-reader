import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let runtime;
let base=process.argv[2];
if(!base){const {startServer}=await import('../server/index.mjs');runtime=await startServer({port:0,dataDir:path.join(root,'.local','smoke')});base=runtime.url;}
const checks=[];
try {
  for(const route of ['/','/app','/mark.svg','/robots.txt','/sitemap.xml']){
    const response=await fetch(base+route);assert.equal(response.status,200,route);checks.push({route,status:response.status});
  }
  const boot=await (await fetch(base+'/api/bootstrap')).json();assert.equal(boot.model,'gpt-6-astra');assert.ok(boot.books.length);
  const headers={'X-Nested-Token':boot.token,'Content-Type':'application/json'};
  const book=await (await fetch(`${base}/api/books/${boot.books[0].id}`,{headers})).json();assert.ok(book.pages.length>=3);
  const exportResponse=await fetch(`${base}/api/books/${book.id}/export`,{headers});assert.equal(exportResponse.status,200);assert.equal(exportResponse.headers.get('content-type'),'application/zip');assert.ok((await exportResponse.arrayBuffer()).byteLength>500);
  checks.push({route:'/api/bootstrap',model:boot.model,connected:boot.connected},{route:'/api/books/:id',pages:book.pages.length},{route:'/api/books/:id/export',status:200});
  if(!boot.connected){const response=await fetch(base+'/api/generate',{method:'POST',headers,body:JSON.stringify({bookId:book.id,pageId:book.pages[0].id,mode:'quick',question:'Explain this plan.'})});assert.equal(response.status,428);checks.push({route:'/api/generate',status:428,note:'Missing-key setup path verified; no live AI call made.'});}
  assert.equal((await fetch(base+'/api/books')).status,403);
  const download=await fetch(base+'/downloads/Nested-arm64.zip',{method:'HEAD'});checks.push({route:'/downloads/Nested-arm64.zip',status:download.status});
  if(fs.existsSync(path.join(root,'release','Nested-arm64.zip')))assert.equal(download.status,200);
  const report={date:new Date().toISOString(),base,checks,status:'passed'};
  fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});fs.writeFileSync(path.join(root,'artifacts','smoke.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}finally{runtime?.server.close();runtime?.server.closeAllConnections();}

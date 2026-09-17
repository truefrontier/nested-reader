import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
try{process.loadEnvFile(path.join(root,'.env'));}catch{}
export function startServer({port=Number(process.env.PORT||4317),dataDir=process.env.NESTED_DATA_DIR||path.join(root,'.local','books'),desktop=false}={}) {
  const runtime=createApp({dataDir,examplesDir:path.join(root,'examples'),distDir:path.join(root,'dist'),downloadPath:path.join(root,'release','Nested-arm64.zip'),desktop});
  return new Promise((resolve,reject)=>{const server=runtime.app.listen(port,'127.0.0.1',()=>{const address=server.address();console.log(`Nested is ready at http://127.0.0.1:${address.port}`);resolve({...runtime,server,url:`http://127.0.0.1:${address.port}`});});server.on('error',reject);});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await startServer();

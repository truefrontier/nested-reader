import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(process.platform!=='darwin')throw new Error('package:mac requires macOS. No cross-platform signing or packaging is configured.');
const env={...process.env,TMPDIR:path.join(root,'.cache','tmp'),ELECTRON_CACHE:path.join(root,'.cache','electron'),ELECTRON_BUILDER_CACHE:path.join(root,'.cache','electron-builder'),npm_config_cache:path.join(root,'.cache','npm'),CSC_IDENTITY_AUTO_DISCOVERY:'false'};
for(const dir of [env.TMPDIR,env.ELECTRON_CACHE,env.ELECTRON_BUILDER_CACHE])fs.mkdirSync(dir,{recursive:true});
function run(command,args){const result=spawnSync(command,args,{cwd:root,env,stdio:'inherit'});if(result.error)throw result.error;if(result.status!==0)throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);}
run('npm',['run','build']);
const electron=path.join(root,'node_modules','electron','dist');
if(!fs.existsSync(path.join(electron,'Electron.app')))run(process.execPath,['node_modules/electron/install.js']);
run(process.execPath,['node_modules/electron-builder/out/cli/cli.js','--mac','--arm64','--dir',`--config.electronDist=${electron}`]);
const app=path.join(root,'release','mac-arm64','Nested.app');
if(!fs.existsSync(path.join(app,'Contents','MacOS','Nested')))throw new Error('electron-builder did not produce Nested.app.');
// Ad-hoc signing makes the local Apple silicon preview executable. Not notarization.
run('/usr/bin/codesign',['--force','--deep','--sign','-',app]);
run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
const zip=path.join(root,'release','Nested-arm64.zip');
run('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',app,zip]);
const website=path.join(root,'release','website');
fs.mkdirSync(website,{recursive:true});
fs.cpSync(path.join(root,'dist'),website,{recursive:true});
fs.mkdirSync(path.join(website,'downloads'),{recursive:true});
fs.copyFileSync(zip,path.join(website,'downloads','Nested-arm64.zip'));
fs.writeFileSync(path.join(root,'release','SHA256SUMS'),`${createHash('sha256').update(fs.readFileSync(zip)).digest('hex')}  Nested-arm64.zip\n`);
console.log(`\nMac preview: ${app}\nDownload: ${zip}\nStatic website: ${website}\nAd-hoc signed only. Developer ID signing, notarization, hosting, and DNS are not configured.`);

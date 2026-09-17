import { spawn } from 'node:child_process';
const commands=[['node',['--watch','server/index.mjs']],['node',['node_modules/vite/bin/vite.js']]];
const children=commands.map(([cmd,args])=>spawn(cmd,args,{stdio:'inherit',env:process.env}));
let closing=false;function close(){if(closing)return;closing=true;children.forEach(c=>c.kill('SIGTERM'));}
process.on('SIGINT',close);process.on('SIGTERM',close);children.forEach(c=>c.on('exit',code=>{close();process.exitCode=code||0;}));

import fs from 'node:fs';
import React from 'react';
import {renderToString} from 'react-dom/server';
import {Marketing} from '../src/Marketing';
const template=fs.readFileSync('dist/index.html','utf8');
// The reader has its own entry page. Public hosting never needs access to the local API.
fs.mkdirSync('dist/app',{recursive:true});
fs.writeFileSync('dist/app/index.html',template.replace('<title>Nested — Finally understand what AI wrote.</title>','<title>Nested Reader</title>').replace('<meta name="description"','<meta name="robots" content="noindex"/><meta name="description"'));
fs.writeFileSync('dist/index.html',template.replace('<div id="root"></div>',`<div id="root">${renderToString(<Marketing/>)}</div>`));
console.log('Prerendered the marketing page and created the /app entry page.');

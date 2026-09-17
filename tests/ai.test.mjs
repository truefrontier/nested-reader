import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL,openaiRequest,validateEvidence,generate } from '../server/ai.mjs';

test('Responses transport always uses gpt-6-astra, disables storage, and sends a strict schema',async t=>{let captured;t.mock.method(globalThis,'fetch',async(url,options)=>{captured={url,...options};return new Response(JSON.stringify({status:'completed',id:'response-test',usage:{input_tokens:1},output:[{type:'message',content:[{type:'output_text',text:'{"answer":"yes"}'}]}]}));});const result=await openaiRequest({key:'fixture',instructions:'Explain',input:{text:'source'},schema:{type:'object'},name:'test'});assert.equal(MODEL,'gpt-6-astra');const body=JSON.parse(captured.body);assert.equal(body.model,MODEL);assert.equal(body.store,false);assert.equal(body.text.format.strict,true);assert.equal(body.reasoning.effort,'medium');assert.equal(captured.url,'https://api.openai.com/v1/responses');assert.equal(result.data.answer,'yes');assert.ok(!('temperature' in body));});

test('unavailable Astra reports the problem with no alternate-model retry',async t=>{let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('{}',{status:404});});await assert.rejects(openaiRequest({key:'fixture',input:{}}),/No other model was substituted/);assert.equal(calls,1);});

test('incomplete responses and refusals never become saved explanations',async t=>{t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({status:'incomplete',output:[]})));await assert.rejects(openaiRequest({key:'fixture',input:{}}),/did not complete/);});

test('evidence requires a nonempty quote from a page actually read',()=>{const pages=[{id:'one',title:'Source',content:'This is a\nreal passage.'}];assert.equal(validateEvidence([{pageId:'one',quote:'This is a real passage.',reason:'context'}],pages)[0].status,'matched');assert.throws(()=>validateEvidence([{pageId:'other',quote:'real'}],pages),/citation/);assert.throws(()=>validateEvidence([{pageId:'one',quote:''}],pages),/citation/);});

test('oversized research context stops before sending the answer request',async()=>{const p={id:'p',title:'Huge',content:'x'.repeat(250001),notes:[]};await assert.rejects(generate({book:{pages:[p]},page:p,mode:'quick',question:'Explain',selection:'',key:'fixture',emit:()=>{},request:()=>{throw new Error('should not send');}}),/context limit/);});

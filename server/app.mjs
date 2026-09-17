import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Store, hash } from './store.mjs';
import { generate, MODEL, MODEL_SOURCE } from './ai.mjs';
import { importCodexApiKey, probeCodex } from './codex.mjs';
const text=z.string().trim().min(1).max(200);
const content=z.string().min(1).max(500000);
const doc=z.object({title:text,content,filename:z.string().max(300).optional()});
const id=z.string().uuid();
const note=z.object({id,date:z.string(),text:z.string().max(10000),status:z.enum(['question','understood','change'])});
const source=z.object({pageId:id,quote:z.string().max(500000),reason:z.string().max(10000),title:z.string(),hash:z.string(),status:z.literal('matched')});
const savedPage=z.object({id,title:text,content,kind:z.enum(['source','generated']),parentId:id.nullable(),question:z.string(),selection:z.string(),mode:z.string().nullable(),model:z.string().nullable(),filename:z.string().nullable(),sources:z.array(source),uncertainties:z.array(z.string()),trace:z.array(z.object({kind:z.string(),text:z.string(),time:z.string()})),revisions:z.array(z.object({id,content,title:text,date:z.string()})),notes:z.array(note),stale:z.boolean(),unread:z.boolean(),createdAt:z.string(),updatedAt:z.string(),sourceHash:z.string().nullable()});
export function createApp({dataDir,examplesDir,distDir,key=process.env.OPENAI_API_KEY||'',request,desktop=false,downloadPath}={}) {
  const app=express(),store=new Store(dataDir,examplesDir),token=randomBytes(32).toString('hex');
  let apiKey=key,active=false;
  app.disable('x-powered-by');
  app.use((req,res,next)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if(req.path.startsWith('/api')){
      res.setHeader('Cache-Control','no-store');
      if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host||''))return res.status(403).json({error:'Only local access is allowed.'});
      const origin=req.headers.origin;
      if(origin&&!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin))return res.status(403).json({error:'This origin is not allowed.'});
      if(req.headers['sec-fetch-site']==='cross-site')return res.status(403).json({error:'Cross-site access is not allowed.'});
      if(req.path!=='/api/bootstrap'){
        const candidate=req.headers['x-nested-token'];
        if(typeof candidate!=='string'||candidate.length!==token.length||!timingSafeEqual(Buffer.from(candidate),Buffer.from(token)))return res.status(403).json({error:'This session expired. Reload Nested.'});
      }
    }
    next();
  });
  app.use(express.json({limit:'12mb'}));
  app.get('/api/bootstrap',(req,res)=>res.json({token,model:MODEL,modelSource:MODEL_SOURCE,connected:Boolean(apiKey),desktop,books:store.list(),dataDir:store.root}));
  app.get('/api/books',(req,res)=>res.json(store.list()));
  app.post('/api/books',(req,res)=>{const input=z.object({title:text,documents:z.array(doc).max(100).default([])}).parse(req.body);res.status(201).json(store.create(input.title,input.documents));});
  app.post('/api/sample',(req,res)=>res.status(201).json(store.sample()));
  app.get('/api/books/:bookId',(req,res)=>res.json(store.sync(req.params.bookId)));
  app.patch('/api/books/:bookId',(req,res)=>{const input=z.object({title:text}).parse(req.body);const book=store.book(req.params.bookId);book.title=input.title;store.save();res.json(book);});
  app.post('/api/books/:bookId/pages',(req,res)=>{const input=z.object({documents:z.array(doc).min(1).max(100)}).parse(req.body);const pages=input.documents.map(d=>store.addPage(req.params.bookId,{...d,kind:'source'}));res.status(201).json(pages);});
  app.patch('/api/books/:bookId/pages/:pageId',(req,res)=>{const input=z.object({title:text.optional(),content:content.optional(),unread:z.boolean().optional(),stale:z.boolean().optional()}).parse(req.body);res.json(store.update(req.params.bookId,req.params.pageId,input));});
  app.post('/api/books/:bookId/pages/:pageId/notes',(req,res)=>{const input=z.object({text:z.string().trim().min(1).max(10000),status:z.enum(['question','understood','change'])}).parse(req.body);res.json(store.note(req.params.bookId,req.params.pageId,input.text,input.status));});
  app.patch('/api/books/:bookId/pages/:pageId/notes/:noteId',(req,res)=>{const input=z.object({text:z.string().trim().min(1).max(10000).optional(),status:z.enum(['question','understood','change']).optional()}).parse(req.body);res.json(store.updateNote(req.params.bookId,req.params.pageId,req.params.noteId,input));});
  app.get('/api/books/:bookId/export',(req,res)=>{const out=store.archive(req.params.bookId);res.setHeader('Content-Type','application/zip');res.setHeader('Content-Disposition',`attachment; filename="${out.name}"`);res.send(out.buffer);});
  app.post('/api/restore',(req,res)=>{
    const {book}=z.object({version:z.literal(1),book:z.object({title:text,pages:z.array(savedPage).min(1).max(200)})}).parse(req.body);
    const ids=new Set(book.pages.map(p=>p.id));if(ids.size!==book.pages.length)throw new Error('The backup contains duplicate page IDs.');
    for(const p of book.pages){if(p.parentId&&!ids.has(p.parentId))throw new Error('The backup has a missing parent.');let ancestor=p;const seen=new Set([p.id]);while(ancestor.parentId){if(seen.has(ancestor.parentId))throw new Error('The backup has a circular page tree.');seen.add(ancestor.parentId);ancestor=book.pages.find(x=>x.id===ancestor.parentId);}}
    res.status(201).json(store.restore(book));
  });
  app.post('/api/settings/key',(req,res)=>{apiKey=z.object({key:z.string().trim().max(300)}).parse(req.body).key;res.json({connected:Boolean(apiKey)});});
  app.get('/api/settings/auth-options',(_req,res)=>res.json(probeCodex()));
  app.post('/api/settings/codex',(req,res,next)=>{
    try{
      const imported=importCodexApiKey();
      apiKey=imported.key;
      res.json({connected:true,message:imported.message,probe:probeCodex()});
    }catch(e){if(e&&e.status)return res.status(e.status).json({error:e.message});next(e);}
  });
  app.post('/api/settings/check',async(req,res,next)=>{
    try{if(!apiKey)return res.status(400).json({error:'Connect your OpenAI API key first.'});const check=await fetch(`https://api.openai.com/v1/models/${MODEL}`,{headers:{Authorization:`Bearer ${apiKey}`},signal:AbortSignal.timeout(20000)});if(!check.ok)return res.status(400).json({error:`GPT-6 Astra access could not be confirmed (${check.status}). Check your API key, project access, and billing.`});res.json({ok:true,model:MODEL});}catch(e){next(e);}
  });
  app.post('/api/generate',async(req,res,next)=>{
    let ownLock=false;
    try{
      const input=z.object({bookId:id,pageId:id,mode:z.enum(['quick','page','deep','research','refine','practice','feedback','brief']),question:z.string().trim().min(1).max(10000),selection:z.string().max(20000).default('')}).parse(req.body);
      if(!apiKey)return res.status(428).json({error:'Connect an OpenAI API key in Settings to ask GPT-6 Astra. Your reading and notes work without one.'});
      if(active)return res.status(409).json({error:'An investigation is already running. Let it finish or cancel it first.'});
      const book=store.sync(input.bookId),page=store.page(input.bookId,input.pageId);
      // Snapshot input so edits made during a request can never silently rewrite the source.
      const snapshot=structuredClone(book),originalHashes=new Map(book.pages.map(p=>[p.id,hash(p.content)]));
      active=true;ownLock=true;
      const abort=new AbortController(),timeout=setTimeout(()=>abort.abort(),180000);
      res.on('close',()=>abort.abort());
      res.setHeader('Content-Type','application/x-ndjson');res.setHeader('X-Accel-Buffering','no');res.flushHeaders();
      const send=data=>{if(!res.destroyed)res.write(`${JSON.stringify(data)}\n`);};
      try{
        const result=await generate({...input,book:snapshot,page:structuredClone(page),key:apiKey,signal:abort.signal,emit:event=>send({type:'progress',event}),request});
        if(abort.signal.aborted)throw new Error('The request was canceled or timed out. No changes were saved.');
        store.sync(input.bookId);
        if(book.pages.some(p=>originalHashes.has(p.id)&&hash(p.content)!==originalHashes.get(p.id)))throw new Error('A source changed during this investigation. Run it again against the updated text. No changes were saved.');
        let pages;
        if(input.mode==='refine'){
          const out=result.pages[0];const changed=store.update(input.bookId,page.id,{content:out.content,title:page.title});
          changed.refinement={model:MODEL,sources:out.sources,uncertainties:out.uncertainties,trace:result.trace};store.save();pages=[changed];
        }else{
          pages=result.pages.map(out=>store.addPage(input.bookId,{...out,kind:'generated',parentId:page.id,question:input.question,selection:input.selection,mode:input.mode,model:MODEL,trace:result.trace},false));
          // Link sibling research chapters with portable relative Markdown links.
          if(pages.length>1)for(const p of pages){p.content+=`\n\n## Continue this investigation\n\n${pages.filter(x=>x.id!==p.id).map(x=>`- [${x.title.replace(/[\[\]]/g,'')}](${x.id}.md)`).join('\n')}`;store.writePage(book,p);}
          store.save();
        }
        send({type:'complete',pages,summary:result.summary,model:MODEL,usage:result.usage,responseIds:result.responseIds});
      }catch(e){send({type:'error',error:abort.signal.aborted?'The request was canceled or timed out. No changes were saved.':e.message});}
      finally{clearTimeout(timeout);active=false;ownLock=false;res.end();}
    }catch(e){if(ownLock)active=false;next(e);}
  });
  app.use('/api',(req,res)=>res.status(404).json({error:'API route not found.'}));
  app.get('/downloads/Nested-arm64.zip',(req,res)=>{if(downloadPath&&fs.existsSync(downloadPath))return res.download(downloadPath);res.status(404).type('text').send('The Mac download has not been packaged on this machine. Run npm run package:mac.');});
  if(distDir&&fs.existsSync(distDir)){app.use(express.static(distDir));app.get('/{*path}',(req,res)=>res.sendFile(path.join(distDir,'index.html')));}
  app.use((error,req,res,next)=>{if(res.headersSent)return next(error);res.status(error instanceof z.ZodError?400:(error.status||500)).json({error:error instanceof z.ZodError?'The request contains missing, invalid, or oversized fields.':error.message||'Something went wrong. Please try again.'});});
  return {app,store,getKey:()=>apiKey};
}

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';

export const hash = text => createHash('sha256').update(text).digest('hex').slice(0,16);
const now = () => new Date().toISOString();
const slug = text => text.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g,'-').replace(/^-|-$/g,'').toLowerCase().slice(0,64) || 'untitled';
function atomic(file, data) { fs.mkdirSync(path.dirname(file),{recursive:true}); const temp = `${file}.${randomUUID()}.tmp`; fs.writeFileSync(temp,data); fs.renameSync(temp,file); }
export class Store {
  constructor(root, examples) {
    this.root = path.resolve(root); this.examples = examples;
    fs.mkdirSync(this.root,{recursive:true});
    this.file = path.join(this.root,'library.json');
    this.db = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file,'utf8')) : {books:[]};
    if (!fs.existsSync(this.file)) this.sample();
  }
  save() { atomic(this.file,JSON.stringify(this.db,null,2)); }
  list() { return this.db.books.map(({id,title,createdAt,pages})=>({id,title,createdAt,pageCount:pages.length})); }
  book(id) { const book=this.db.books.find(x=>x.id===id); if (!book) throw Object.assign(new Error('This book was not found.'),{status:404}); return book; }
  page(bookId,id) { const page=this.book(bookId).pages.find(x=>x.id===id); if (!page) throw Object.assign(new Error('This page was not found.'),{status:404}); return page; }
  directory(book) { return path.join(this.root,book.id); }
  serialize(page) {
    const header={nested_id:page.id,title:page.title,kind:page.kind,source:page.parentId ? `./${page.parentId}.md` : null,question:page.question||null,mode:page.mode||null,model:page.model||null,created:page.createdAt,updated:page.updatedAt,sources:page.sources,uncertainties:page.uncertainties};
    return `---\n${Object.entries(header).map(([key,value])=>`${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n${page.content}`;
  }
  writePage(book,page) { atomic(path.join(this.directory(book),`${page.id}.md`),this.serialize(page)); }
  create(title,documents=[]) {
    const book={id:randomUUID(),title,createdAt:now(),pages:[]};
    this.db.books.push(book);
    for (const doc of documents) this.addPage(book.id,{title:doc.title,content:doc.content,kind:'source',filename:doc.filename||null},false);
    this.save(); return book;
  }
  sample() {
    const docs=fs.readdirSync(this.examples).filter(x=>x.endsWith('.md')).sort().map(file=>{
      const content=fs.readFileSync(path.join(this.examples,file),'utf8');
      return {title:content.match(/^# (.+)/m)?.[1]||file,content,filename:file};
    });
    return this.create('Making background jobs make sense',docs);
  }
  addPage(bookId,input,persist=true) {
    const book=this.book(bookId);
    const page={id:randomUUID(),title:input.title,content:input.content,kind:input.kind||'source',parentId:input.parentId||null,question:input.question||'',selection:input.selection||'',mode:input.mode||null,model:input.model||null,filename:input.filename||null,sources:input.sources||[],uncertainties:input.uncertainties||[],trace:input.trace||[],revisions:[],notes:[],stale:false,unread:input.kind==='generated',createdAt:now(),updatedAt:now(),sourceHash:input.parentId?hash(this.page(bookId,input.parentId).content):null};
    book.pages.push(page); this.writePage(book,page); if(persist)this.save(); return page;
  }
  update(bookId,id,{content,title,unread,stale}) {
    const book=this.sync(bookId), page=this.page(bookId,id);
    if (content!==undefined && (content!==page.content || (title!==undefined && title!==page.title))) {
      page.revisions.unshift({id:randomUUID(),content:page.content,title:page.title,date:page.updatedAt});
      page.content=content; page.title=title??page.title; page.updatedAt=now();
      this.invalidate(book,id);
    } else if(title!==undefined) { page.title=title; page.updatedAt=now(); }
    if(unread!==undefined)page.unread=unread;
    if(stale!==undefined) {page.stale=stale; if(!stale&&page.parentId)page.sourceHash=hash(this.page(bookId,page.parentId).content);}
    this.writePage(book,page); this.save(); return page;
  }
  invalidate(book,id,visited=new Set()) {
    if(visited.has(id))return; visited.add(id);
    for(const p of book.pages) if(p.id!==id&&(p.parentId===id||p.sources.some(s=>s.pageId===id))) {p.stale=true;this.invalidate(book,p.id,visited);}
  }
  sync(bookId) {
    const book=this.book(bookId); let changed=false;
    for(const page of book.pages) {
      const file=path.join(this.directory(book),`${page.id}.md`);
      if(!fs.existsSync(file)){page.fileMissing=true; continue;}
      page.fileMissing=false;
      const raw=fs.readFileSync(file,'utf8');
      // Strip our own envelope without evaluating YAML/JavaScript engines.
      // Any front matter within the imported document remains literal Markdown.
      const content=raw.replace(/^---\r?\nnested_id:[^\n]*\n[\s\S]*?\r?\n---\r?\n/, '').trimEnd();
      if(content!==page.content.trimEnd()) {
        page.revisions.unshift({id:randomUUID(),content:page.content,title:page.title,date:page.updatedAt});
        page.content=content; page.updatedAt=now(); this.invalidate(book,page.id); changed=true;
      }
    }
    if(changed)this.save(); return book;
  }
  note(bookId,id,text,status='question') {const p=this.page(bookId,id);p.notes.push({id:randomUUID(),text,status,date:now()});this.save();return p;}
  updateNote(bookId,id,noteId,fields) {const p=this.page(bookId,id);const n=p.notes.find(x=>x.id===noteId);if(!n)throw Object.assign(new Error('Note not found.'),{status:404});Object.assign(n,fields);this.save();return p;}
  archive(bookId) {
    const book=this.sync(bookId),files={};
    for(const p of book.pages)files[`${p.id}.md`]=strToU8(this.serialize(p));
    files['nested-book.json']=strToU8(JSON.stringify({version:1,book},null,2));
    const outline=book.pages.map(p=>`- [${p.title.replace(/[\[\]]/g,'')}](${p.id}.md)${p.question?` · ${p.question}`:''}`).join('\n');
    const notes=book.pages.flatMap(p=>p.notes.map(n=>`- **${n.status}** · ${n.text} ([${p.title}](${p.id}.md))`)).join('\n');
    files['README.md']=strToU8(`# ${book.title}\n\nExported from Nested. Generated explanations are not independent evidence.\n\n## Pages\n\n${outline}\n\n## Your review notes\n\n${notes||'No review notes yet.'}\n`);
    return {name:`${slug(book.title)}.zip`,buffer:Buffer.from(zipSync(files))};
  }
  restore(snapshot) {
    const ids=new Map(snapshot.pages.map(p=>[p.id,randomUUID()]));
    const book={...snapshot,id:randomUUID(),title:`${snapshot.title} (restored)`,createdAt:now(),pages:snapshot.pages.map(p=>({...p,id:ids.get(p.id),parentId:ids.get(p.parentId)||null,sources:p.sources.map(s=>({...s,pageId:ids.get(s.pageId)||s.pageId})),content:p.content.replace(/([a-f0-9-]{36})\.md/g,(m,id)=>ids.has(id)?`${ids.get(id)}.md`:m)}))};
    this.db.books.push(book);for(const page of book.pages)this.writePage(book,page);this.save();return book;
  }
}

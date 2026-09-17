import { JSDOM } from 'jsdom';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://127.0.0.1/app',pretendToBeVisual:true});
for(const key of ['window','document','navigator','HTMLElement','HTMLDialogElement','Node','Event','MouseEvent','KeyboardEvent','MutationObserver','localStorage','getComputedStyle'])Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:key==='getComputedStyle'?dom.window.getComputedStyle.bind(dom.window):dom.window[key]});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
HTMLElement.prototype.scrollTo=function(){};
HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};

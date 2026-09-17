import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/manrope';
import './styles.css';
import {Marketing} from './Marketing';
const Reader=React.lazy(()=>import('./Reader'));
class ErrorBoundary extends React.Component<{children:React.ReactNode},{error:boolean}>{state={error:false};static getDerivedStateFromError(){return {error:true};}render(){return this.state.error?<main className="connection-screen"><h1>Let’s reopen this page.</h1><p>Something interrupted the reader. Your saved documents are still on disk.</p><button className="button primary" onClick={()=>location.reload()}>Reload Nested</button></main>:this.props.children;}}
const root=document.getElementById('root')!;
const tree=(<React.StrictMode><ErrorBoundary>{location.pathname.startsWith('/app')?<React.Suspense fallback={<div className="connection-screen">Opening your book…</div>}><Reader/></React.Suspense>:<Marketing/>}</ErrorBoundary></React.StrictMode>);
if(root.hasChildNodes()&&!location.pathname.startsWith('/app'))ReactDOM.hydrateRoot(root,tree);else ReactDOM.createRoot(root).render(tree);

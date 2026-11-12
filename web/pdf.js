import {composingEvent} from './input.js';
import * as pdfjs from 'pdfjs-dist';
import { EventBus, PDFViewer, PDFLinkService, PDFFindController } from 'pdfjs-dist/web/pdf_viewer.mjs';
import 'pdfjs-dist/web/pdf_viewer.css';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
export const pdfState=()=>({pdfPage:1,pdfPages:0,pdfScale:100,pdfFindOpen:false,pdfQuery:'',pdfCase:false,pdfWhole:false,pdfFindCount:0,pdfFindStatus:'',pdfError:''});
let reader,loaded,pending,generation=0,onState=()=>{},onError=console.error,onNavigate=()=>{};
export function configurePdf(options){onState=options.onState;onError=options.onError;onNavigate=options.onNavigate||(()=>{});}
const update=patch=>onState(patch);
function makeReader(){
  const host=document.getElementById('pdf-viewer');if(!host)throw new Error('PDF preview is not available.');
  host.replaceChildren();host.tabIndex=0;host.setAttribute('aria-label','PDF document');
  const pages=document.createElement('div');pages.className='pdfViewer';host.append(pages);
  const bus=new EventBus(),abort=new AbortController(),link=new PDFLinkService({eventBus:bus,externalLinkTarget:2,externalLinkRel:'noopener noreferrer'});
  const find=new PDFFindController({eventBus:bus,linkService:link});
  const viewer=new PDFViewer({container:host,viewer:pages,eventBus:bus,linkService:link,findController:find,abortSignal:abort.signal,
    annotationMode:pdfjs.AnnotationMode.ENABLE,annotationEditorMode:pdfjs.AnnotationEditorType.DISABLE,
    maxCanvasPixels:4194304,maxCanvasDim:4096,enableDetailCanvas:false,enableAutoLinking:false});
  link.setViewer(viewer);
  const context={host,bus,abort,link,find,viewer,location:null,query:'',caseSensitive:false,whole:false,findOpen:false};
  const live=()=>reader===context&&!abort.signal.aborted;
  let resizeFrame;
  const resize=new ResizeObserver(()=>{cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>{if(!live()||!viewer.pdfDocument)return;const scale=viewer.currentScaleValue;if(scale==='page-width'||scale==='page-fit')viewer.currentScaleValue=scale;viewer.update();});});
  resize.observe(host);abort.signal.addEventListener('abort',()=>{resize.disconnect();cancelAnimationFrame(resizeFrame);},{once:true});
  bus.on('pagechanging',({pageNumber})=>{if(live())update({pdfPage:pageNumber});});
  bus.on('scalechanging',({scale})=>{clearSourceHighlight();if(live())update({pdfScale:Math.round(scale*100)});});
  bus.on('updateviewarea',({location})=>{if(live())context.location=location;});
  bus.on('pagerendered',({error})=>{if(live()&&error){update({pdfError:'This page could not be rendered. Try compiling again or downloading the PDF.'});onError(error);}});
  const matches=({matchesCount})=>{if(live()&&context.findOpen&&context.query){const {current,total}=matchesCount;update({pdfFindCount:total,pdfFindStatus:total?`${current} of ${total} matches`:'No matches'});}};
  bus.on('updatefindmatchescount',matches);
  bus.on('updatefindcontrolstate',event=>{if(!live()||!context.findOpen||event.rawQuery!==context.query)return;if(event.state===3)update({pdfFindStatus:'Searching PDF…'});else matches(event);});
  host.addEventListener('click',event=>{if(!(event.ctrlKey||event.metaKey)||event.button!==0)return;const point=pdfPosition(event.clientX,event.clientY);if(point){event.preventDefault();event.stopPropagation();onNavigate(point);}},{capture:true,signal:abort.signal});
  host.addEventListener('keydown',event=>{
    if(composingEvent(event))return;
    if(event.altKey&&event.key==='Enter'){event.preventDefault();event.stopPropagation();const point=selectedPdfPosition();if(point)onNavigate(point);return;}
    if(event.target.closest('input,textarea,select,button,a'))return;
    if(event.key==='Escape'){event.preventDefault();viewer.clearSelection();if(context.findOpen)pdfAction('pdf-find-close');return;}
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='f'){event.preventDefault();event.stopPropagation();pdfAction('pdf-find');return;}
    if(event.target!==host)return;
    if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const page=event.key==='Home'?1:event.key==='End'?viewer.pagesCount:viewer.currentPageNumber+(event.key==='ArrowLeft'?-1:1);goToPage(page);}
  },{signal:abort.signal});
  return context;
}
function once(context,name,signal){
  return new Promise((resolve,reject)=>{
    const done=event=>{cleanup();resolve(event);},cancel=()=>{cleanup();reject(new DOMException('PDF preview cancelled','AbortError'));};
    const timeout=setTimeout(()=>{cleanup();reject(new Error('PDF preview did not initialize.'));},15000);
    function cleanup(){clearTimeout(timeout);context.bus.off(name,done);context.abort.signal.removeEventListener('abort',cancel);signal?.removeEventListener('abort',cancel);}
    context.bus.on(name,done);context.abort.signal.addEventListener('abort',cancel,{once:true});signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  });
}
function interruptible(promise,signal){
  if(!signal)return promise;
  return new Promise((resolve,reject)=>{
    const cancel=()=>{cleanup();reject(new DOMException('PDF preview cancelled','AbortError'));};
    const cleanup=()=>signal.removeEventListener('abort',cancel);
    signal.addEventListener('abort',cancel,{once:true});
    promise.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
    if(signal.aborted)cancel();
  });
}
function pdfTask(bytes,signal,check){
  const worker=new pdfjs.PDFWorker();let documentTask,destroyed=false,disposal;
  return {
    promise:(async()=>{await interruptible(worker.promise,signal);check();if(destroyed)throw new DOMException('PDF preview cancelled','AbortError');documentTask=pdfjs.getDocument({worker,data:bytes.slice(),isEvalSupported:false,disableAutoFetch:true,enableXfa:false});return interruptible(documentTask.promise,signal);})(),
    destroy(){
      if(disposal)return disposal;destroyed=true;
      if(!documentTask){worker.destroy();return disposal=Promise.resolve();}
      let timeout;
      disposal=Promise.race([documentTask.destroy(),new Promise(resolve=>{timeout=setTimeout(resolve,15000);})]).finally(()=>{clearTimeout(timeout);worker.destroy();});
      return disposal;
    },
  };
}
export async function showPdf(bytes,{signal}={}){
  const token=++generation;const obsolete=pending;pending=null;await obsolete?.destroy();
  const check=()=>{signal?.throwIfAborted();if(token!==generation)throw new DOMException('PDF preview cancelled','AbortError');};
  check();
  const task=pdfTask(bytes,signal,check);pending=task;
  let context,previous,position,scale,previousDocument,committed=false;
  const rollback=()=>{
    if(context&&reader===context&&loaded===task&&!committed){
      loaded=previous;context.link.setDocument(previousDocument||null);context.viewer.setDocument(previousDocument||null);
      if(previousDocument){context.viewer.currentScaleValue=scale;if(position)context.viewer.scrollPageIntoView({pageNumber:position.pageNumber,destArray:[null,{name:'XYZ'},position.left,position.top,null],allowNegativeOffset:true});}
      update({pdfPages:previousDocument?.numPages||0,pdfPage:context.viewer.currentPageNumber,pdfScale:Math.round(context.viewer.currentScale*100)||100});
    }
  };
  const cancel=()=>{rollback();void task.destroy().catch(()=>{});};
  signal?.addEventListener('abort',cancel,{once:true});
  try{
    check();const document=await task.promise;await interruptible(document.getPage(1),signal);check();
    reader ||= makeReader();context=reader;previous=loaded;previousDocument=context.viewer.pdfDocument;position=context.location;scale=context.viewer.currentScaleValue||'page-width';
    const initialized=once(context,'pagesinit',signal);context.link.setDocument(document);context.viewer.setDocument(document);loaded=task;pending=null;
    await initialized;check();if(reader!==context)throw new DOMException('PDF preview cancelled','AbortError');
    context.viewer.currentScaleValue=scale;
    if(position)context.viewer.scrollPageIntoView({pageNumber:Math.min(position.pageNumber,document.numPages),destArray:[null,{name:'XYZ'},position.left,position.top,null],allowNegativeOffset:true});
    check();committed=true;
    update({pdfPages:document.numPages,pdfPage:context.viewer.currentPageNumber,pdfScale:Math.round(context.viewer.currentScale*100),pdfError:'',pdfFindCount:0,pdfFindStatus:''});
    if(context.findOpen&&context.query)runFind();
    void previous?.destroy().catch(()=>{});return document.numPages;
  }catch(error){rollback();if(pending===task)pending=null;if(loaded!==task){if(signal?.aborted)void task.destroy().catch(()=>{});else await task.destroy();}if(previous&&reader!==context)void previous.destroy().catch(()=>{});throw error;}
  finally{signal?.removeEventListener('abort',cancel);}
}
export async function clearPdf(){
  generation++;const tasks=new Set([loaded,pending].filter(Boolean)),old=reader;reader=null;loaded=null;pending=null;
  if(old){old.viewer.setDocument(null);old.link.setDocument(null);old.abort.abort();}
  update(pdfState());await Promise.allSettled([...tasks].map(task=>task.destroy()));
}
export function zoomPdf(delta){if(reader?.viewer.pdfDocument){const viewer=reader.viewer;viewer.currentScale=Math.min(4,Math.max(.25,Math.round((viewer.currentScale+delta)*100)/100));}}
export function goToPage(value){if(!reader?.viewer.pdfDocument)return;const page=Number(value),viewer=reader.viewer;viewer.currentPageNumber=Number.isInteger(page)?Math.max(1,Math.min(viewer.pagesCount,page)):viewer.currentPageNumber;update({pdfPage:viewer.currentPageNumber});}
function runFind(again=false,previous=false){
  if(!reader)return;const context=reader;update({pdfFindCount:0,pdfFindStatus:context.query?'Searching PDF…':''});
  context.bus.dispatch('find',{source:context,type:again?'again':'',query:context.query,caseSensitive:context.caseSensitive,entireWord:context.whole,highlightAll:true,findPrevious:previous,matchDiacritics:false});
}
const actions=new Set(['pdf-page','pdf-previous','pdf-next','pdf-fit-width','pdf-fit-page','pdf-find','pdf-find-close','pdf-query','pdf-case','pdf-whole','pdf-find-next','pdf-find-previous']);
export const handlesPdfAction=name=>actions.has(name);
export function pdfAction(name,value=''){
  if(!reader?.viewer.pdfDocument)return;const context=reader;
  switch(name){
    case 'pdf-page':goToPage(value);break;
    case 'pdf-previous':goToPage(context.viewer.currentPageNumber-1);break;
    case 'pdf-next':goToPage(context.viewer.currentPageNumber+1);break;
    case 'pdf-fit-width':context.viewer.currentScaleValue='page-width';break;
    case 'pdf-fit-page':context.viewer.currentScaleValue='page-fit';break;
    case 'pdf-find':context.findOpen=true;update({pdfFindOpen:true});requestAnimationFrame(()=>document.getElementById('pdf-search-query')?.focus());if(context.query)runFind();break;
    case 'pdf-find-close':context.findOpen=false;context.bus.dispatch('findbarclose',{source:context});update({pdfFindOpen:false,pdfFindStatus:'',pdfFindCount:0});context.host.focus();break;
    case 'pdf-query':context.query=value.slice(0,4096);update({pdfQuery:context.query});runFind();break;
    case 'pdf-case':context.caseSensitive=!context.caseSensitive;update({pdfCase:context.caseSensitive});runFind();break;
    case 'pdf-whole':context.whole=!context.whole;update({pdfWhole:context.whole});runFind();break;
    case 'pdf-find-next':runFind(true);break;
    case 'pdf-find-previous':runFind(true,true);break;
  }
}

export function clearSourceHighlight(){document.querySelectorAll('.pdf-source-location').forEach(el=>el.remove());}
function pdfPosition(clientX,clientY){
  if(!reader)return null;const page=document.elementFromPoint(clientX,clientY)?.closest('.page[data-page-number]');if(!page||!reader.host.contains(page))return null;
  const number=Number(page.dataset.pageNumber),view=reader.viewer.getPageView(number-1);if(!view?.pdfPage)return null;
  const bounds=page.getBoundingClientRect(),[x,y]=view.viewport.convertToPdfPoint(clientX-bounds.left,clientY-bounds.top),box=view.pdfPage.view;
  return {page:number,x,y:box[3]-y,height:box[3]-Math.min(0,box[1])};
}
export function selectedPdfPosition(){
  if(!reader)return null;const selection=document.getSelection();
  if(selection?.rangeCount&&!selection.isCollapsed){const range=selection.getRangeAt(0);if(reader.host.contains(range.commonAncestorContainer)){const box=range.getBoundingClientRect();const point=pdfPosition(box.x+box.width/2,box.y+box.height/2);if(point)return point;}}
  const host=reader.host.getBoundingClientRect(),view=reader.viewer.getPageView(reader.viewer.currentPageNumber-1),page=view?.div.getBoundingClientRect();if(!page)return null;
  return pdfPosition(Math.max(host.left,page.left)+Math.min(host.width,page.width)/2,Math.max(host.top,page.top)+Math.max(1,Math.min(host.bottom,page.bottom)-Math.max(host.top,page.top))/2);
}
export async function showSourceRectangle(rectangle,isCurrent=()=>true){
  const context=reader,doc=context?.viewer.pdfDocument;if(!doc)return;const page=await doc.getPage(rectangle.page);if(context!==reader||doc!==context.viewer.pdfDocument||!isCurrent())return;
  const top=Math.max(rectangle.top,rectangle.bottom-24),height=page.view[3];
  context.viewer.scrollPageIntoView({pageNumber:rectangle.page,destArray:[null,{name:'XYZ'},rectangle.left, height-top+20,null],allowNegativeOffset:true});
  const view=context.viewer.getPageView(rectangle.page-1);if(!view.pdfPage)view.setPdfPage(page);
  const [x1,y1]=view.viewport.convertToViewportPoint(rectangle.left,height-top),[x2,y2]=view.viewport.convertToViewportPoint(rectangle.right,height-rectangle.bottom);
  clearSourceHighlight();const marker=document.createElement('div');marker.className='pdf-source-location';marker.setAttribute('aria-hidden','true');Object.assign(marker.style,{left:`${Math.min(x1,x2)}px`,top:`${Math.min(y1,y2)}px`,width:`${Math.max(3,Math.abs(x2-x1))}px`,height:`${Math.max(3,Math.abs(y2-y1))}px`});view.div.append(marker);setTimeout(()=>marker.remove(),3500);
}

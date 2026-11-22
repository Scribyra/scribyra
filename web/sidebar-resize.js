// The left sidebar's width: dragged by its edge or set from the keyboard, remembered on this device.
// Phone layouts keep their fixed sidebar; the handle is hidden there by CSS.
export const SIDEBAR={min:180,max:560,default:224,step:16,key:'scribyra:sidebar-width'};
const stored=()=>{try{const value=Number(localStorage.getItem(SIDEBAR.key));return Number.isFinite(value)&&value>0?value:null;}catch{return null;}};
const remember=width=>{try{if(width===SIDEBAR.default)localStorage.removeItem(SIDEBAR.key);else localStorage.setItem(SIDEBAR.key,String(width));}catch{}};
// Leaves room for the editor and preview beside the sidebar on smaller windows.
const ceiling=()=>Math.max(SIDEBAR.min,Math.min(SIDEBAR.max,Math.round(window.innerWidth*0.45)));

export function wireSidebarDivider(){
  const divider=document.getElementById('sidebar-divider');if(!divider||divider.dataset.wired)return;divider.dataset.wired='true';
  const root=document.documentElement;let width=stored()??SIDEBAR.default;
  const set=(value,save=true)=>{
    const max=ceiling();width=Math.round(Math.max(SIDEBAR.min,Math.min(max,value)));
    root.style.setProperty('--sidebar-width',`${width}px`);
    divider.setAttribute('aria-valuemax',String(max));divider.setAttribute('aria-valuenow',String(width));divider.setAttribute('aria-valuetext',`${width} pixels`);
    if(save)remember(width);
  };
  divider.setAttribute('aria-valuemin',String(SIDEBAR.min));set(width,false);
  divider.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;event.preventDefault();divider.setPointerCapture(event.pointerId);
    // The width follows the pointer's movement, so grabbing the handle off-centre never jumps.
    const startX=event.clientX,startWidth=width;document.body.classList.add('resizing-sidebar');divider.classList.add('dragging');
    const move=moveEvent=>set(startWidth+moveEvent.clientX-startX,false);
    const end=()=>{divider.removeEventListener('pointermove',move);divider.removeEventListener('pointerup',end);divider.removeEventListener('pointercancel',end);document.body.classList.remove('resizing-sidebar');divider.classList.remove('dragging');remember(width);};
    divider.addEventListener('pointermove',move);divider.addEventListener('pointerup',end);divider.addEventListener('pointercancel',end);
  });
  divider.addEventListener('dblclick',()=>set(SIDEBAR.default));
  divider.addEventListener('keydown',event=>{
    if(event.isComposing)return;
    const step=event.shiftKey?SIDEBAR.step*4:SIDEBAR.step;
    const next={ArrowLeft:width-step,ArrowRight:width+step,Home:SIDEBAR.min,End:ceiling(),Enter:SIDEBAR.default}[event.key];
    if(next===undefined)return;event.preventDefault();set(next);
  });
  refit=()=>{if(divider.isConnected)set(stored()??SIDEBAR.default,false);};
}
// A smaller window lowers the ceiling; the remembered width comes back when there is room again.
let refit=()=>{},resizeFrame;
window.addEventListener('resize',()=>{cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>refit());});

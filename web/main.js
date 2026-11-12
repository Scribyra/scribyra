import {directShare} from './direct-share.js';
import {parseInvite,profileIdentity,requireDirectSupport,deleteProfileIdentity} from './direct-identity.js';
import {identityAuthorId,earlierRecords} from './direct-provenance.js';
import {directEnabled,setDirectEnabled,setDirectKeyPresent,legacyAuthorIds,addLegacyAuthorId} from './direct-state.js';
import {zipSync,strToU8} from 'fflate';
import {assertUiMutation,uiCommandGuard,uiCollaborationGuard} from './ui-mutations.js';
import {installPopups,openMenu,openPrompt} from './menu.js';
import {inlineRename,installTreeMenus,moveDestinations,moveTarget,treeMenuItems} from './file-actions.js';
import {takeTexFragment,texLinkEntry} from './tex-link.js';
import './tex-link.css';
let initialTexLink=takeTexFragment(window);
import {initializeCollaborationSchema} from './collaboration-schema.js';
import {mountCollaboration} from './collaboration.js';
import {agentCommands,localAgentOwner} from './agent-commands.js';
import {projectBuildResult} from './project-operations.js';
import {AgentOrigin,sourceAffecting,changedTextFiles,isRemoteOrigin} from './change-origins.js';
import {localTabs,LOCAL_DURABLE} from './local-tabs.js';
import {watchStorage} from './storage-events.js';
import {providersDialog} from './providers-dialog.js';
import {companionHost,CompanionOrigin} from './companion-host.js';
import {connectCompanion} from './companion-connection.js';
import {companionDialog} from './companion-dialog.js';
import {environmentDialog} from './environment-dialog.js';
import {trackComposition,compositionInProgress,composingEvent,restoreDialogFocus} from './input.js';
trackComposition(document);
import init, { main as startApp, TelemetryRecorder } from './pkg/scribyra_app.js';
import {telemetryExport} from './telemetry-export.js';
import {telemetryConsent} from './telemetry-consent.js';
import {parseSessionRate} from './telemetry-session.js';
import {telemetry,telemetryError} from './telemetry.js';
import {installObservability,observed,observe} from './observability.js';
import {diagnosticsDialog} from './diagnostics-dialog.js';
import {updateNotice} from './update-notice.js';
import './update-notice.css';
import './staging-marker.css';
import {stagingMarker} from './staging-marker.js';
import './style.css';
import './menu.css';
import './review-editor.css';
import {editorSearch} from './editor-search.js';
import * as Y from 'yjs';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { StreamLanguage, syntaxHighlighting, defaultHighlightStyle, HighlightStyle, bracketMatching, indentUnit } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { projectNodes, projectNode, treeRows, figureSnippet, validateProject, projectFiles, snapshot, importZip, exportZip, STARTER, MAX_BYTES, SCHEMA_VERSION } from './model.js';
import * as storage from './storage.js';
import { readBrowserFiles, readDirectory, readDroppedFiles } from './import-files.js';
import { assetBytes, cloneProject, installBlob } from './assets.js';
import { compileProject, cancelCompile } from './compiler.js';
import {buildFailure} from './build-errors.js';
import { buildCoordinator } from './build-session.js';
import {liveCompileLog} from './compile-log.js';
// Local only: the live log is display state and never reaches telemetry or storage.
const liveLog=liveCompileLog();
const builds=buildCoordinator((...args)=>{texLinks.assertAllowed();return compileProject(...args);},cancelCompile,busy=>{state.busy=busy;emit();if(!busy)scheduleAutoCompile();});
import { showPdf, clearPdf, zoomPdf, pdfState, configurePdf, handlesPdfAction, pdfAction, selectedPdfPosition, showSourceRectangle, clearSourceHighlight } from './pdf.js';
import { connectDemo } from './sync.js';
import { reportDialog } from './report-dialog.js';
import { reviewReferences } from './reference-review.js';
import {sourceLines} from './source-lines.js';
import {revealedSelection} from './review-editor.js';
import { editorState, editorWorkspace } from './editor-workspace.js';
import { editorSettings } from './editor-dialogs.js';
import { projectCommands,entryCommand } from './commands.js';
import { sourceMapState, sourceNavigation } from './source-map.js';

let diagnostics,diagnosticsPanel,remoteDiagnostics,consentDiagnostics;
const startupAt=performance.now(),dashboardTitle=document.title;
let providerPanel;const providerConnections=new Map();
let environmentPanel,companionPanel,companion;let pdfBuild=null,leavingProject=false;
let allProjects = [], doc, projectId, editor, sync, pdfBytes, commands;
let collaboration,agent,agentOwner,transientProject=false,direct,openingDirectAttempt;
let initialDirectInvite=location.hash.startsWith('#direct=')?location.href:'';
if(initialDirectInvite)history.replaceState(null,'',location.pathname+location.search);
// An invite pasted into the address bar of an open tab must not stay in the URL or history either.
window.addEventListener('hashchange',()=>{if(!location.hash.startsWith('#direct='))return;const text=location.href;history.replaceState(null,'',location.pathname+location.search);if(direct)direct.offerInvite(text);else notice('Open a project, then paste this invite in Share.');});
const texLinks=texLinkEntry({initial:initialTexLink,create:source=>createProject('TeX link scratch',[{path:'main.tex',content:source}],{fromTexLink:true}),approve:acceptTexLink,compile:()=>agent.api.compile()});
const startedFromTexLink=!!initialTexLink;initialTexLink=null;
let tabSession,localEdits=0,savedEdits=0;
let autoPending=false;
let revision = 0, saveTimer, autoTimer, saveChain = Promise.resolve(), mountedFile, renderFrame;
// Stored history (docs/history.md): when this tab last saved an automatic version, and the idle maintenance that thins it.
let historyPointAt = 0, maintenanceTimer, maintenanceRunning = false;
const undoManagers = new Map();
const sourcePositions = new Map();let lastSource;
const collapsed = new Set();
let assetUrl, mountedBytes, mountedAssetPath;
function clearAsset() { if (assetUrl) URL.revokeObjectURL(assetUrl); assetUrl = null; mountedBytes = null; mountedAssetPath = null; }
// Explicit development switch for the loopback plaintext demo; a link can't turn it on.
const plaintextDemo=(()=>{try{return localStorage.getItem('scribyra-plaintext-demo')==='1';}catch{return false;}})();
// The Rust companion is discontinued (November 8, 2026). Its dialog and local
// providers stay reachable only behind this test-only switch; production never
// offers it and never contacts a local address by itself.
const companionDev=(()=>{try{return localStorage.getItem('scribyra-companion-dev')==='1';}catch{return false;}})();
const state = { plaintextDemo,companionDev,macPlatform:/^Mac/.test(navigator.platform),downloadLoaded:0,downloadTotal:0,...editorState(), ...pdfState(), ...sourceMapState(), fontSize: 14, tabSize: 2, wrap: true, projects: [], files: [], tree: [], selected: '', trashCount: 0, treeError: '', current: false, name: '', active: '', mainFile: '', engine: 'lualatex', busy: false, status: 'Ready to compile', saveStatus: 'Saved locally', syncStatus: 'Local only', notice: '', log: '', showLog: false, showIssues: false, buildIssues: [], auto: false, hasPdf: false, stale: false, storage: '', peers: 0, companionStatus: 'Disconnected', tabSyncStatus:'Local tabs', recoveryAvailable:false, filter: '' };
const emit = () => window.dispatchEvent(new CustomEvent('scribyra:state', { detail: JSON.stringify({...state,...(state.directActive?{syncStatus:'Direct session'}:{}),...(state.saveStatus==='Saved locally'&&(state.comments?.draft||state.comments?.pendingSave)?{saveStatus:'Comment draft · not yet submitted'}:state.reviewDraftPending?{saveStatus:'Review draft · not yet published'}:{})}) }));
configurePdf({onState:patch=>{Object.assign(state,patch);emit();},onError:displayError,onNavigate:point=>navigation.inverse(point)});
const editorOptions = new Compartment(), selections = new Map();
const workspace = editorWorkspace({state,getDoc:()=>doc,getRevision:()=>revision,emit,activate:activateFile,notify:notice,wireTree,mutate:run=>{assertUiMutation(collaboration?.review.state.mode);return run();}});
const navigation=sourceNavigation({state,getDoc:()=>doc,getRevision:()=>revision,emit,notify:notice,showRectangle:showSourceRectangle,clearMarker:clearSourceHighlight,activate:(id,line)=>{activateFile(id);selectSourceLine(line);}});
function persistWorkspace() {
  if (!projectId || !doc || transientProject) return;
  try { localStorage.setItem(`scribyra:workspace:${projectId}`,JSON.stringify({tabs:state.tabs.map(f=>f.id),active:state.active,fontSize:state.fontSize,tabSize:state.tabSize,wrap:state.wrap,auto:state.auto})); }
  catch { state.notice='Editor preferences could not be saved on this device.'; }
}
function loadWorkspace() {
  let prefs;try{prefs=JSON.parse(localStorage.getItem(`scribyra:workspace:${projectId}`));}catch{}
  const files=projectFiles(doc),ids=new Set(files.map(f=>f.id));
  state.fontSize=Number.isInteger(prefs?.fontSize)&&prefs.fontSize>=12&&prefs.fontSize<=24?prefs.fontSize:14;
  state.tabSize=[2,4,8].includes(prefs?.tabSize)?prefs.tabSize:2;state.wrap=prefs?.wrap!==false;state.auto=prefs?.auto===true;
  if(Array.isArray(prefs?.tabs)){state.tabs=[...new Set(prefs.tabs)].filter(id=>ids.has(id)).map(id=>files.find(f=>f.id===id));state.active=state.tabs.some(f=>f.id===prefs.active)?prefs.active:state.tabs[0]?.id||'';}
  else {state.active=(files.find(f=>f.id===doc.getMap('meta').get('mainFile'))||files.find(f=>!f.binary)||files[0])?.id||'';state.tabs=[];}
}
function captureSelection() {
  if(!editor||!mountedFile||!doc)return;const text=doc.getText(`text:${mountedFile}`),selection=editor.state.selection.main;
  const head=Y.createRelativePositionFromTypeIndex(text,collaboration?.review.toSource(selection.head)??selection.head);sourcePositions.set(mountedFile,head);
  selections.set(mountedFile,{head,anchor:Y.createRelativePositionFromTypeIndex(text,collaboration?.review.toSource(selection.anchor)??selection.anchor),scroll:editor.scrollDOM.scrollTop});
}
const syntaxColors={'#708':'keyword','#219':'keyword','#05a':'special','#164':'variable','#a11':'string','#00f':'number','#085':'variable','#a50':'type','#777':'comment','#c00':'invalid'};
const accessibleHighlight=HighlightStyle.define(defaultHighlightStyle.specs.map(style=>({...style,...(style.color?{color:syntaxColors[style.color]?`var(--syntax-${syntaxColors[style.color]})`:'var(--text)'}:{})})));
function options(){return [EditorState.tabSize.of(state.tabSize),indentUnit.of(' '.repeat(state.tabSize)),...(state.wrap?[EditorView.lineWrapping]:[])];}
// Comments stay available in Viewing; anything that decides a suggestion or changes accepted source does not.
const viewingRefuses=new Set(['suggestion.accept','suggestion.reject','suggestion.withdraw','review.acceptAll','review.acceptSet','review.propose','review.retry','review-accept-visible','review-reject-visible','change.undo','change.redo']);
function activateFile(id,start,end=start) {
  collaboration?.review.beforeLeave();
  if(!projectFiles(doc).some(f=>f.id===id))return;state.active=id;revealNode(id);mountEditor();
  if(editor&&start!==undefined){const max=editor.state.doc.length;editor.dispatch({selection:{anchor:Math.min(collaboration?.review.toDisplay(start,-1)??start,max),head:Math.min(collaboration?.review.toDisplay(end,1)??end,max)},annotations:revealedSelection.of(true),scrollIntoView:true});}editor?.focus();
}
function selectSourceLine(line){
  if(!editor||!mountedFile)return;
  const lines=doc.getText(`text:${mountedFile}`).toString().split('\n'),number=Math.min(lines.length,Math.max(1,line||1));
  const start=lines.slice(0,number-1).reduce((offset,text)=>offset+text.length+1,0),end=start+lines[number-1].length;
  editor.dispatch({selection:{anchor:collaboration?.review.toDisplay(start,-1)??start,head:collaboration?.review.toDisplay(end,1)??end},annotations:revealedSelection.of(true),scrollIntoView:true});editor.focus();
}
function closeTab(id) {
  collaboration?.review.beforeLeave();
  const index=state.tabs.findIndex(f=>f.id===id);state.tabs=state.tabs.filter(f=>f.id!==id);
  if(state.active===id)state.active=state.tabs[Math.min(index,state.tabs.length-1)]?.id||'';
  refreshDoc();
}
function notice(message) { state.notice = message; emit(); }
function displayError(error) { diagnostics?.begin('exception').end('failure',telemetryError(error));console.error(error); notice(error.message || String(error)); }
function download(bytes, name, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function modal(title, message, { value, label = 'Continue', choices } = {}) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog'); dialog.className = 'modal'; dialog.setAttribute('aria-label',title);restoreDialogFocus(dialog);
    const heading = document.createElement('h2'); heading.textContent = title; dialog.append(heading);
    const description = document.createElement('p'); description.textContent = message; dialog.append(description);
    let input;
    if (value !== undefined) { input = document.createElement('input'); input.value = value; input.setAttribute('aria-label', title); dialog.append(input); }
    const buttons = document.createElement('div'); buttons.className = 'modal-actions'; dialog.append(buttons);
    const finish = result => { dialog.close(); dialog.remove(); resolve(result); };
    const add = (text, result, primary) => { const b = document.createElement('button'); b.textContent = text; b.className = `button ${primary ? 'primary' : 'secondary'}`; b.onclick = () => finish(input && result === true ? input.value.trim() : result); buttons.append(b); };
    add('Cancel', null, false);
    if (choices) for (const [text, result] of choices) add(text, result, false); else add(label, true, true);
    input?.addEventListener('keydown', e => { if (e.key === 'Enter'&&!composingEvent(e)) {e.preventDefault();finish(input.value.trim());} });
    dialog.addEventListener('cancel', e => { e.preventDefault(); finish(null); });
    document.body.append(dialog); dialog.showModal(); input?.select();
  });
}
async function pickFiles(accept, multiple = false, directory = false) {
  return new Promise(resolve => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = accept; input.multiple = multiple; input.webkitdirectory = directory;
    input.addEventListener('change', () => resolve([...input.files])); input.addEventListener('cancel', () => resolve([])); input.click();
  });
}
async function refreshProjects() {
  allProjects = await storage.listProjects();
  state.projects = allProjects.filter(p => p.name.toLowerCase().includes(state.filter.toLowerCase())).map(p => ({ ...p, date: new Date(p.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) })); emit();
}
function refreshDoc(openFirst = false) {
  if (!doc) return;
  const meta = doc.getMap('meta');
  state.name = meta.get('name') || 'Untitled project'; state.engine = 'lualatex'; state.mainFile = meta.get('mainFile') || '';
  document.title = `${state.name} — Scribyra`;
  state.files = projectFiles(doc);
  state.tree = treeRows(doc, collapsed); state.trashCount = doc.getMap('trash').size;
  try { validateProject(doc); state.treeError = ''; } catch(e) { state.treeError = e.message; }
  if (!projectNodes(doc).some(n => n.id === state.selected)) state.selected = '';
  state.tabs=state.tabs.map(tab=>state.files.find(f=>f.id===tab.id)).filter(Boolean);
  if(openFirst&&!state.active)state.active=(state.files.find(f=>f.id===state.mainFile)||state.files.find(f=>!f.binary)||state.files[0])?.id||'';
  if (!state.files.some(f => f.id === state.active)) state.active = state.tabs[0]?.id || '';
  if(state.active&&!state.tabs.some(f=>f.id===state.active))state.tabs.push(state.files.find(f=>f.id===state.active));
  workspace.activeChanged();persistWorkspace();
  emit();
  requestAnimationFrame(() => { mountEditor(); wireTree(); });
}
function scheduleAutoCompile(){
  clearTimeout(autoTimer);
  if(autoPending&&state.auto&&doc&&!leavingProject)autoTimer=setTimeout(()=>{if(!state.busy)runCompile().catch(displayError);},1800);
}
function onUpdate(_update,origin,_doc,transaction) {
  const source=sourceAffecting(doc,transaction);
  if(source){revision++;workspace.changed(changedTextFiles(doc,transaction));navigation.changed();state.stale=state.hasPdf;}
  if(origin!==LOCAL_DURABLE){localEdits++;state.saveStatus=transientProject?'In memory · accept TeX link to save':'Saving locally…';clearTimeout(saveTimer);if(!transientProject)saveTimer=setTimeout(()=>flushSave().catch(displayError),160);}
  refreshDoc(state.files.length===0);
  if(source&&state.auto&&transaction.local&&!isRemoteOrigin(origin)){autoPending=true;scheduleAutoCompile();}
}
function composingSource(){return !!editor?.composing||compositionInProgress(editor?.contentDOM);}
async function flushSave({acceptLink=false}={}) {
  clearTimeout(saveTimer);
  if (!doc || transientProject&&!acceptLink) return;
  const accepting=transientProject&&acceptLink;
  const savedDoc = doc, savedId = projectId, savedRevision = localEdits;
  // An automatic version ends the typing burst first, so edits after it get their own record.
  const point = storage.pointDue(historyPointAt);
  if (point) { historyPointAt = Date.now(); collaboration?.endBurst(); }
  // Capture the immutable update now; persist writes in order, including project switches.
  const frozen = cloneProject(savedDoc);
  const operation = saveChain.catch(() => {}).then(() => storage.saveProject(savedId, frozen, undefined, { point }));
  saveChain = operation;
  try {
    const result = await operation;
    if (doc === savedDoc) {
      if(accepting)transientProject=false;
      // Learn about concurrent writers without replacing in-flight local edits.
      savedEdits=Math.max(savedEdits,savedRevision);
      if(composingSource())void tabSession?.refresh({force:true});
      else{for(const blob of result.blobs||[])installBlob(doc,blob.ref,blob.bytes);Y.applyUpdate(doc,result.update,LOCAL_DURABLE);}
      if (localEdits === savedEdits&&!state.recoveryAvailable) { state.saveStatus = 'Saved locally'; emit(); }
      else if(accepting){state.saveStatus='Saving locally…';saveTimer=setTimeout(()=>flushSave().catch(displayError),160);}
      if(result.recoveries?.some(copy=>copy.created))notice('A competing binary version was saved in a separate recovery project. Both versions are preserved.');
      if(result.maintenanceDue)scheduleMaintenance(savedId);
    }
  }
  catch (e) { if(doc===savedDoc){state.saveStatus = 'Not saved · export a backup'; emit();} throw new Error(`Local save failed (${e.name}): ${e.message}. Export your project before closing this tab.`); }
  finally { frozen.destroy(); }
}
/** Thin stored history while the person is not typing; one run at a time per tab (and per device, by lock). */
function scheduleMaintenance(id,delay=4000){
  clearTimeout(maintenanceTimer);
  maintenanceTimer=setTimeout(async()=>{
    if(maintenanceRunning||projectId!==id||transientProject)return;
    if(saveTimer&&localEdits!==savedEdits){scheduleMaintenance(id);return;}
    maintenanceRunning=true;
    try{if(await storage.historyMaintenanceDue(id)){const result=await storage.maintainHistory(id);if(result?.steps||result?.removedVersions)void refreshProjects().catch(()=>{});}}
    catch(error){
      if(error?.code==='history_verification')notice('Stored history could not be verified after it was compacted, so automatic clean-up has stopped. Nothing was removed from the project; a recovery copy named “… (before history compaction)” is kept if one was made. Export a backup.');
      else console.warn('History maintenance postponed:',error);
    }
    finally{maintenanceRunning=false;}
  },delay);
}
async function acceptTexLink(){
  const target=doc,id=projectId;
  await flushSave({acceptLink:true});
  if(doc!==target)return;
  try{localStorage.setItem('scribyra:author',JSON.stringify(agentOwner));}catch{}
  persistWorkspace();if(!tabSession)watchLocalProject(target,id);await refreshProjects();
}
function disconnectProjectTools(handoff){
  direct?.close(handoff);direct=null;
  providerPanel?.abort();providerPanel=null;for(const connection of providerConnections.values())void connection.close();providerConnections.clear();
  companionPanel?.abort();companionPanel=null;void companion?.close();companion=null;state.companionStatus='Disconnected';
}
async function leaveProject({save=true,directAttempt}={}) {
  if(openingDirectAttempt!==directAttempt)openingDirectAttempt?.abort();
  if(save&&composingSource())throw new Error('Finish the current text input before closing this project.');
  if(collaboration?.hasCommentDraft()&&!await modal('Leave with a comment draft','This comment has not been submitted. Its local recovery copy stays on this device; if local storage failed, export the draft before leaving. Leave this project?'))throw Object.assign(new Error('Navigation cancelled.'),{code:'comment_navigation_cancelled'});
  collaboration?.review.flush();
  leavingProject=true;
  disconnectProjectTools(directAttempt);
  environmentPanel?.abort();environmentPanel=null;
  try{if(save)await flushSave();}catch(error){leavingProject=false;throw error;}
  agent?.close();agent=null;window.scribyra.agent=null;
  tabSession?.close();tabSession=null; persistWorkspace(); workspace.leave(); navigation.clear(); selections.clear(); clearTimeout(autoTimer); autoPending=false; builds.close(); state.busy = false;
  texLinks.close();transientProject=false;
  clearAsset(); collapsed.clear(); sourcePositions.clear(); lastSource=null;
  sync?.close(); sync = null; editor?.destroy(); editor = null; mountedFile = null;
  for (const manager of undoManagers.values()) manager.destroy(); undoManagers.clear();
  collaboration?.close();collaboration=null;commands?.close();commands=null;
  if (doc) { doc.off('update', onUpdate); doc.destroy(); } doc = null; document.title=dashboardTitle;
  await clearPdf(); pdfBytes = null; pdfBuild=null; state.hasPdf = false; state.stale = false; state.syncStatus = 'Local only'; state.peers = 0; state.tabSyncStatus='Local tabs';state.recoveryAvailable=false;
}
// The person's explicit choice to turn direct sessions on. Only now is a signing key made,
// and the local author ID becomes the key-derived one; the earlier ID is kept as this
// profile's own, so its earlier records stay attributed to it here. Returns whether the ID changed.
async function enableDirectSessions(){
  await requireDirectSupport();
  const identity=await profileIdentity({create:true});setDirectKeyPresent(true);
  const signedId=identityAuthorId(identity.publicKey),previous=localAgentOwner();
  setDirectEnabled(true);
  if(previous.id===signedId)return false;
  addLegacyAuthorId(previous.id);localStorage.setItem('scribyra:author',JSON.stringify({...previous,id:signedId}));return true;
}
// Sessions are already off. Records the key signed stay verifiable by others. Without the
// key its author ID would be one nobody can sign for, so the profile takes a fresh local ID
// (kept with the earlier ones as its own here) that a later key can claim.
async function deleteDirectKey(){
  await deleteProfileIdentity();setDirectKeyPresent(false);
  const previous=localAgentOwner();addLegacyAuthorId(previous.id);localStorage.setItem('scribyra:author',JSON.stringify({...previous,id:crypto.randomUUID()}));
  if(projectId&&doc&&!transientProject){await openProject(projectId);direct?.show();}
}
async function openInvitedProject(invitation){const joined=new Y.Doc(),id=crypto.randomUUID();joined.getMap('meta').set('schemaVersion',SCHEMA_VERSION);joined.getMap('meta').set('lineageId',invitation.lineage);await storage.saveProject(id,joined);joined.destroy();await openProject(id);direct.show();}
async function openProject(id,{saveCurrent=true,transientDoc,directAttempt}={}) {
  if(openingDirectAttempt!==directAttempt)openingDirectAttempt?.abort();
  openingDirectAttempt=directAttempt;
  await leaveProject({save:saveCurrent,directAttempt});directAttempt?.signal.throwIfAborted();
  try { doc = transientDoc || await storage.loadProject(id); } catch (e) { state.current = false; await refreshProjects(); throw e; }
  directAttempt?.signal.throwIfAborted();
  transientProject=!!transientDoc;
  leavingProject=false;projectId = id; revision = 0;localEdits=savedEdits=0;historyPointAt=Date.now();const target=doc;commands=projectCommands({doc,projectId,isActive:()=>doc===target,beforeMutation:uiCommandGuard(()=>collaboration?.review.state.mode)});
  state.upgradeAvailable=false;state.reviewDraftPending=false;state.current = true; consentDiagnostics?.dismiss(); state.active = ''; state.selected = '';  state.log = '';liveLog.stop();state.buildIssues=[]; state.showLog = false; state.showIssues = false; state.status = 'Ready to compile'; state.saveStatus = transientProject?'In memory · accept TeX link to save':'Saved locally';
  agentOwner=localAgentOwner(transientProject?{getItem:key=>localStorage.getItem(key),setItem:()=>{}}:localStorage);
  collaboration=mountCollaboration({doc:target,projectId,signedMessages:()=>!!state.directActive,legacyAuthorIds,trustLabels:()=>directEnabled()||!!state.directActive,requestDecision:command=>direct.requestDecision(command),canPersistDrafts:()=>!transientProject,canUnload:()=>!!state.upgradeReload,onDraftPending:pending=>{if(doc===target){state.reviewDraftPending=pending;emit();}},author:{...agentOwner,kind:'human'},commands,flushSave,storage,selection:()=>({fileId:mountedFile,...(editor?collaboration?.review.sourceRange(editor.state.selection.main.from,editor.state.selection.main.to)||{start:editor.state.selection.main.from,end:editor.state.selection.main.to}:{})}),validateCommentSelection:()=>{if(editor)collaboration?.review.sourceRange(editor.state.selection.main.from,editor.state.selection.main.to,true);},activate:activateFile,captureSelection,remount:()=>{editor?.destroy();editor=null;mountedFile=null;mountEditor();},confirm:(title,message)=>modal(title,message),compile:options=>{texLinks.assertAllowed();return builds.run({...options,projectId:id,revision:commands.revision(),isActive:()=>doc===target&&!leavingProject});},onState:patch=>{if(doc===target){Object.assign(state,patch);emit();}},managers:undoManagers,remote:[LOCAL_DURABLE],isActive:()=>doc===target&&!leavingProject});
  direct=directShare({doc:target,initialAttempt:directAttempt,author:{...agentOwner,kind:'human'},initialInvite:initialDirectInvite,notify:notice,
    enable:async({invite}={})=>{if(await enableDirectSessions()&&doc===target){initialDirectInvite=invite||'';await openProject(id);direct?.show();}},deleteKey:deleteDirectKey,earlier:()=>earlierRecords(target,agentOwner.id,legacyAuthorIds()),onActive:active=>{if(state.directActive!==active){state.directActive=active;emit();}},onEnabled:on=>{if(state.directEnabled!==on){state.directEnabled=on;emit();}},flushSave,isComposing:()=>composingSource()||!!document.getElementById('code-editor')?.inert,isActive:()=>doc===target&&!leavingProject,preserve:source=>storage.preserveRecoveryProject(id,source),onRecovery:()=>notice('A competing binary version was preserved in a recovery project.'),
    cleanCopy:async(config,attempt)=>{attempt.signal.throwIfAborted();const entries=importZip(exportZip(target)),fromTexLink=target.getMap('meta').get('texLinkOrigin')==='link';await createProject(state.name+' · shared copy',entries,{fromTexLink,directAttempt:attempt});attempt.signal.throwIfAborted();if(fromTexLink){await flushSave({acceptLink:true});attempt.signal.throwIfAborted();}await direct.start(undefined,config);},
    joinProject:async(invitation,config,attempt)=>{attempt.signal.throwIfAborted();const joined=new Y.Doc(),key=crypto.randomUUID();joined.getMap('meta').set('schemaVersion',SCHEMA_VERSION);joined.getMap('meta').set('lineageId',invitation.lineage);try{await storage.saveProject(key,joined);}finally{joined.destroy();}attempt.signal.throwIfAborted();await openProject(key,{directAttempt:attempt});attempt.signal.throwIfAborted();await flushSave();attempt.signal.throwIfAborted();await direct.start(invitation,config);},
    decide:command=>collaboration.commands.execute({version:2,requestId:crypto.randomUUID(),projectId:id,expectedRevision:collaboration.commands.revision(),command},undefined,{uiGuard:uiCollaborationGuard(()=>collaboration.review.state.mode)})});
  initialDirectInvite='';
  Object.assign(state,collaboration.state);
  agent=agentCommands({doc:target,projectId:id,commands:collaboration.commands,owner:agentOwner,ensureUndo:sourceUndo,compile:signal=>runCompile({signal}),isBusy:()=>state.busy,getState:()=>state,getPdf:()=>pdfBytes?{bytes:pdfBytes.slice(),build:pdfBuild,stale:state.stale}:null,download,isActive:()=>doc===target&&!leavingProject,build:typeof __SCRIBYRA_BUILD__==='undefined'?null:__SCRIBYRA_BUILD__});
  window.scribyra.agent=agent.api;
  loadWorkspace();texLinks.open(id,doc); doc.on('update', onUpdate);if(!transientProject)scheduleMaintenance(id,8000);
  const previousEngine = doc.getMap('meta').get('engine');
  if(previousEngine!=='lualatex') { commands.run({op:'project.configure',engine:'lualatex'}); if(previousEngine) notice(`This project now uses LuaLaTeX (previously ${previousEngine}). Its source files are unchanged.`); }
  refreshDoc(); state.selected = state.active; emit();
  if(!transientProject)watchLocalProject(target,id);
}
function watchLocalProject(target,id){
  tabSession=localTabs({doc:target,projectId:id,read:storage.readCommittedProject,preserve:storage.preserveRecoveryProject,onRecovery:()=>{if(doc===target)notice('A competing binary version was saved in a separate recovery project. Both versions are preserved.');},isActive:()=>doc===target&&!leavingProject,isComposing:composingSource,onStatus:message=>{if(doc===target&&state.tabSyncStatus!==message){state.tabSyncStatus=message;emit();}},onMissing:kind=>{if(doc!==target)return;disconnectProjectTools();state.upgradeAvailable=kind==='upgraded';state.recoveryAvailable=true;state.saveStatus='Not saved · export a backup';notice(kind==='upgraded'?'Reload to update Scribyra. Export your open copy or save a recovered copy first; it includes your unsaved source.':kind==='deleted'?'This project was deleted in another tab. Export your open copy or save a recovered copy.':'This project is missing from local storage. Export your open copy or save a recovered copy.');},onError:error=>{if(doc===target)notice(error.message+' Your open source is preserved.');}});
}

async function createProject(name, files = [{ path: 'main.tex', content: STARTER }],{fromTexLink=false,directAttempt}={}) {
  if (!name) return;
  const newDoc = new Y.Doc(),id=crypto.randomUUID(),client=projectCommands({doc:newDoc,projectId:id});
  try {
    client.run({op:'project.configure',name:name.slice(0,160),engine:'lualatex',mainFile:''});
    if(files.length){const added=entryCommand(files);client.run(added.command,client.revision(),added.attachments);}
    const list=projectFiles(newDoc),main=list.find(f=>f.path==='main.tex')||list.find(f=>f.path.endsWith('/main.tex'))||list.find(f=>f.path.toLowerCase().endsWith('.tex'));
    client.run({op:'project.configure',mainFile:main?.id||''});
    if(fromTexLink){texLinks.mark(newDoc);await openProject(id,{transientDoc:newDoc,directAttempt});return;}
    await storage.saveProject(id,newDoc);
  }finally{client.close();if(doc!==newDoc)newDoc.destroy();}
  await refreshProjects();directAttempt?.signal.throwIfAborted();await openProject(id,{directAttempt});
}
function sourceUndo(id){
  let undo=undoManagers.get(id);if(!undo){undo=new Y.UndoManager(doc.getText(`text:${id}`),{trackedOrigins:new Set([null,CompanionOrigin,AgentOrigin])});undoManagers.set(id,undo);}return undo;
}
function mountEditor() {
  const host = document.getElementById('code-editor');
  if (!state.current || !doc) return;
  if (!host) { renderFrame = requestAnimationFrame(mountEditor); return; }
  wireDivider();
  if (mountedFile === state.active && (editor?.dom.isConnected || (host.querySelector('.asset-message') && mountedBytes === doc.getMap('assets').get(state.active) && mountedAssetPath === projectNode(doc, state.active)?.path))) return;
  collaboration?.review.beforeLeave();
  captureSelection();
  editor?.destroy(); editor = null; clearAsset(); host.replaceChildren(); mountedFile = state.active;
  const file = state.files.find(f => f.id === state.active); if (!file) {const empty=document.createElement('p');empty.className='empty-editor';empty.textContent='Open a file from the project tree to start writing.';host.append(empty);return;}
  if (file.binary) {
    const bytes = assetBytes(doc,file.id); mountedBytes = doc.getMap('assets').get(file.id); mountedAssetPath = file.path;
    const message = document.createElement('div'); message.className = 'asset-message';
    const info = document.createElement('p'); info.textContent = `${(bytes.byteLength / 1024).toFixed(1)} KiB`; message.append(info);
    const mime = imageMime(file.path);
    if (mime) {
      assetUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
      const image = document.createElement('img'); image.className = 'asset-preview'; image.alt = file.path; image.src = assetUrl;
      image.onload = () => { info.textContent = `${image.naturalWidth} × ${image.naturalHeight} · ${(bytes.byteLength / 1024).toFixed(1)} KiB`; };
      image.onerror = () => { image.remove(); info.textContent += ' · This image cannot be previewed.'; };
      message.append(image);
    } else { const help = document.createElement('p'); help.textContent = 'Download this asset to view it.'; message.append(help); }
    const actions = document.createElement('div'); actions.className = 'asset-actions';
    for (const [label, callback] of [
      ['Download file', () => { const current = projectNode(doc, file.id); download(assetBytes(doc,file.id), current.path.split('/').pop()); }],
      ['Replace file', () => action('replace-asset', file.id)],
      ...(/\.(png|jpe?g|pdf)$/i.test(file.path)?[['Insert figure',()=>action('insert-figure',file.id)]]:[]),
    ]) { const button = document.createElement('button'); button.className = 'button secondary'; button.textContent = label; button.onclick = callback; actions.append(button); }
    message.append(actions); host.append(message); return;
  }
  lastSource=file.id;
  const text = doc.getText(`text:${file.id}`);
  const undo=sourceUndo(file.id);
  const saved=selections.get(file.id),anchor=saved&&Y.createAbsolutePositionFromRelativePosition(saved.anchor,doc),head=saved&&Y.createAbsolutePositionFromRelativePosition(saved.head,doc);
  const reviewEditor=collaboration?.review.configure(file.id);
  const selection=anchor?.type===text&&head?.type===text?{anchor:collaboration?.review.toDisplay(anchor.index)??anchor.index,head:collaboration?.review.toDisplay(head.index)??head.index}:undefined;
  editor = new EditorView({ parent: host, dispatchTransactions:reviewEditor?.dispatchTransactions, state: EditorState.create({ doc: reviewEditor?.doc??text.toString(), selection, extensions: [
    ...(reviewEditor?.extensions||[]),
    ...(collaboration?.editorExtensions||[]), lineNumbers(), sourceLines, highlightActiveLine(), drawSelection(), editorOptions.of(options()),
    keymap.of([{scope:'editor search-panel',any:(view,event)=>{
      if(composingEvent(event)||view.composing||event.getModifierState('AltGraph'))return false;
      let command;
      if((event.ctrlKey||event.metaKey)&&event.key==='Enter')command=['compile',''];
      else if((event.ctrlKey||event.metaKey)&&event.shiftKey&&['f','o'].includes(event.key.toLowerCase()))command=['workspace-panel',event.key.toLowerCase()==='f'?'search':'outline'];
      else if(event.altKey&&event.key.toLowerCase()==='w')command=['close-tab',state.active];
      else if(event.altKey&&event.key==='Enter')command=['source-to-pdf',''];
      if(!command)return false;void action(...command);return true;
    }},...(collaboration?.review.state.mode!=='editing'?[]:yUndoManagerKeymap), ...defaultKeymap, ...searchKeymap, indentWithTab]), StreamLanguage.define(stex), syntaxHighlighting(accessibleHighlight), bracketMatching(), highlightSelectionMatches(), editorSearch(),
    ...(collaboration?.review.state.mode==='reviewing'?[]:[yCollab(text, sync?.awareness || null, { undoManager: collaboration?.review.state.mode==='viewing'?false:undo })]),
    EditorView.contentAttributes.of({ 'aria-label': 'LaTeX source', spellcheck: 'false' }),
    EditorView.theme({ '&': { color: 'var(--text)', backgroundColor: 'var(--surface)' }, '.cm-activeLine': { backgroundColor: 'var(--subtle)' }, '.cm-cursor': { borderLeftColor: 'var(--text)' } }),
  ] }) });
  editor.scrollDOM.tabIndex=0;editor.scrollDOM.setAttribute('role','region');editor.scrollDOM.setAttribute('aria-label','LaTeX source scroll area');
  host.style.setProperty('--editor-font-size',`${state.fontSize}px`);
  if(saved)editor.scrollDOM.scrollTop=saved.scroll;
}
function imageMime(path) {
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif' })[path.split('.').pop().toLowerCase()];
}
function selectedDirectory() {
  const node = projectNodes(doc).find(n => n.id === state.selected);
  return !node ? '' : node.folder ? node.path + '/' : node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/') + 1) : '';
}
function revealNode(id) {
  const node = projectNode(doc, id); if (!node) return;
  const seen = new Set(); let parent = node.parentId;
  while (parent && !seen.has(parent)) { seen.add(parent); collapsed.delete(parent); parent = projectNode(doc,parent)?.parentId; }
  state.selected = id; refreshDoc();
}
function focusNode(id) {
  state.selected = id; emit();
  requestAnimationFrame(() => [...document.querySelectorAll('[role="treeitem"]')].find(el => el.dataset.node === id)?.focus());
}
function wireTree() {
  const tree = document.getElementById('project-tree'); if (!tree || tree.dataset.wired) return; tree.dataset.wired = 'true';
  wireFileDrop(tree.closest('.file-sidebar'));
  tree.onkeydown = e => {
    if(composingEvent(e))return;
    if (e.target.getAttribute('role') !== 'treeitem') return;
    const rows = state.tree, index = rows.findIndex(n => n.id === e.target.dataset.node), node = rows[index]; if (!node) return;
    let next;
    switch (e.key) {
      case 'ArrowDown': next = rows[Math.min(index+1, rows.length-1)]; break;
      case 'ArrowUp': next = rows[Math.max(0,index-1)]; break;
      case 'Home': next = rows[0]; break;
      case 'End': next = rows.at(-1); break;
      case 'ArrowRight': if (node.folder && !node.expanded) { collapsed.delete(node.id); refreshDoc(); next = node; } else if (node.folder && rows[index+1]?.depth > node.depth) next = rows[index+1]; break;
      case 'ArrowLeft': if (node.folder && node.expanded) { collapsed.add(node.id); refreshDoc(); next = node; } else next = [...rows.slice(0,index)].reverse().find(n => n.depth < node.depth); break;
      case 'F2': {const blocked=treeEditBlocked();if(blocked)notice(blocked);else action('rename-node', node.id);break;}
      case 'Delete': action('delete-node', node.id); break;
      default: return;
    }
    e.preventDefault(); if (next) focusNode(next.id);
  };
}
function importEntries(targetDoc,entries,client,expected,destination) {
  if(doc!==targetDoc)throw new Error('Project changed. Please import again.');
  if(!entries.length)return;
  for(const entry of entries)destination?.(entry.path);
  const added=entryCommand(entries),ids=client.run(added.command,expected,added.attachments).ids,firstFile=ids.find(id=>!projectNode(doc,id).folder);
  if(firstFile)state.active=firstFile;
  revealNode(firstFile||ids[0]);notice(`Imported ${entries.filter(e=>!e.folder).length} files and ${entries.filter(e=>e.folder).length} folders.`);
}
async function importFolder(client=commands,expected) {
  const targetDoc=doc,directory=selectedDirectory(),destination=destinationGuard();
  try {
    if(typeof window.showDirectoryPicker==='function') {
      const handle=await window.showDirectoryPicker({mode:'read'});
      importEntries(targetDoc,await readDirectory(handle,directory),client,expected,destination);
    }else {
      const files=await pickFiles('',true,true);if(!files.length)return;
      importEntries(targetDoc,await readBrowserFiles(files,directory,true),client,expected,destination);
      notice('Folder imported. This browser’s folder picker omits empty folders; use ZIP import to preserve them.');
    }
  }catch(error){if(error.name!=='AbortError')throw error;}
}
function wireFileDrop(area) {
  const type='application/x-scribyra-node';
  const row=e=>e.target.closest('[role="treeitem"]');
  function directoryAt(e) {
    const node=projectNode(doc,row(e)?.dataset.node);
    if(!node)return '';
    return node.folder?node.path+'/':node.path.includes('/')?node.path.slice(0,node.path.lastIndexOf('/')+1):'';
  }
  function clear(){area.querySelectorAll('.drop-target').forEach(el=>el.classList.remove('drop-target'));area.classList.remove('drop-target');}
  area.ondragstart=e=>{const item=row(e);if(!item)return;const node=projectNode(doc,item.dataset.node);if(!node||node.conflict){e.preventDefault();return;}e.dataTransfer.setData(type,JSON.stringify({projectId,id:node.id}));e.dataTransfer.effectAllowed='move';};
  area.ondragover=e=>{if(![...e.dataTransfer.types].some(t=>t===type||t==='Files'))return;e.preventDefault();clear();(row(e)||area).classList.add('drop-target');e.dataTransfer.dropEffect=e.dataTransfer.types.includes(type)?'move':'copy';};
  area.ondragleave=e=>{if(!area.contains(e.relatedTarget))clear();};area.ondragend=clear;
  area.ondrop=async e=>{
    if(![...e.dataTransfer.types].some(t=>t===type||t==='Files'))return;e.preventDefault();clear();
    try {
      const directory=directoryAt(e),local=e.dataTransfer.getData(type);
      if(local){const item=JSON.parse(local);if(item.projectId!==projectId)throw new Error('Move files within the same project. Use export/import between projects.');const node=projectNode(doc,item.id);if(!node)throw new Error('The dragged item no longer exists.');await moveWithReview(node.id,directory+node.name);}
      else {const targetDoc=doc,destination=destinationGuard();importEntries(targetDoc,await readDroppedFiles(e.dataTransfer,directory),commands,undefined,destination);}
    }catch(error){displayError(error);}
  };
}
/*
 * Tree actions are checked against what the person acted on, never against the whole
 * project's revision: typing in another tab or by a direct-session peer, in this or any other file, must not close a menu or
 * void a rename. Only the node itself being renamed, moved or deleted is a conflict.
 */
const nodeShape=id=>{const node=id&&doc?projectNode(doc,id):null;return node?JSON.stringify([node.path,!!node.folder,!!node.conflict]):null;};
function nodeGuard(id,doing){
  const targetDoc=doc,seen=nodeShape(id),path=projectNode(doc,id)?.path||'';
  return()=>{
    if(doc!==targetDoc)throw new Error('Project changed. Please try again.');
    if(nodeShape(id)!==seen)throw Object.assign(new Error(`Someone else renamed, moved or deleted “${path}” while you were ${doing} it. Nothing was changed.`),{code:'revision_conflict'});
  };
}
/*
 * A destination folder is part of what the person chose. Paths create missing folders, so
 * a folder another tab or a peer renamed, moved or deleted meanwhile would silently come back empty
 * at its old path with this file in it, apart from what was in it. Refuse instead.
 */
const folderIds=()=>new Map(projectNodes(doc).filter(node=>node.folder&&!node.conflict).map(node=>[node.path,node.id]));
function destinationGuard(){
  const targetDoc=doc,seen=folderIds();
  return path=>{
    if(doc!==targetDoc)throw new Error('Project changed. Please try again.');
    const now=folderIds(),parts=path.split('/');
    for(let depth=1;depth<parts.length;depth++){const folder=parts.slice(0,depth).join('/');if(seen.has(folder)&&now.get(folder)!==seen.get(folder))throw Object.assign(new Error(`Someone else renamed, moved or deleted the folder “${folder}” while you were choosing it. Nothing was changed.`),{code:'revision_conflict'});}
  };
}
// What deleting a folder takes with it: the person confirmed everything inside as it was.
const subtreeShape=id=>{const node=projectNode(doc,id);return node?JSON.stringify(projectNodes(doc).filter(n=>n.id===id||n.path.startsWith(node.path+'/')).map(n=>[n.id,n.path,!!n.folder,!!n.conflict]).sort()):null;};
// The references a person reviewed, independent of where typing in other tabs or by peers has shifted them.
const referenceKey=plan=>JSON.stringify(plan.edits.map(edit=>[edit.fileId,edit.before,edit.after]));
async function moveWithReview(id,path,client=commands,guard=nodeGuard(id,'moving'),destination=destinationGuard()) {
  guard();destination(path);const plan=client.run({op:'node.planRelocation',id,path});
  const selected=plan.edits.length||plan.warnings.length?await reviewReferences(plan):[];
  if(selected===null)return;
  guard();destination(path);
  // node.relocate plans again; its reference indexes must still name what was reviewed.
  if(selected.length&&referenceKey(client.run({op:'node.planRelocation',id,path}))!==referenceKey(plan))throw Object.assign(new Error('The LaTeX references to this file changed while you reviewed the move. Nothing was changed; review the move again.'),{code:'revision_conflict'});
  client.run({op:'node.relocate',id,path,selectedReferences:selected});revealNode(id);
  if(plan.skippedConflicts)notice('Moved. Resolve tree conflicts before reviewing LaTeX references.');
}
// Mutations stay guarded by the shared command layer; this only explains them ahead of time in the menu.
/** The project.configure for settings a person edited, refusing any another tab or peer changed meanwhile. */
function sharedSettings(seen,chosen,title){
  const meta=doc.getMap('meta'),current={name:meta.get('name')||'Untitled project',mainFile:meta.get('mainFile')||''},command={op:'project.configure'};
  for(const [key,value]of Object.entries(chosen)){
    if(value===seen[key])continue;
    if(current[key]!==seen[key])throw Object.assign(new Error(`${title}: someone else changed the ${key==='name'?'project name':'main file'} while this was open. Nothing was changed; open it again.`),{code:'revision_conflict'});
    command[key]=value;
  }
  // The main file the dialog showed, chosen or left as it was, must still exist: otherwise
  // saving would apply the rest while silently dropping it. Another tab or peer deleting it, or
  // turning it into a conflict, refuses the whole save.
  if(chosen.mainFile){const node=projectNode(doc,chosen.mainFile);if(!node||node.folder||node.conflict)throw Object.assign(new Error(`Project changed while ${title.toLowerCase()} was open: someone else deleted the main file it shows. Nothing was changed; open it again.`),{code:'revision_conflict'});}
  return command;
}
function treeEditBlocked() {
  const mode=collaboration?.review.state.mode;
  try{assertUiMutation(mode);return '';}catch{return mode==='viewing'?'Viewing is read only. Switch to Editing to change project files.':'Reviewing records suggestions. Switch to Editing to change project files.';}
}
const treeRow=id=>[...document.querySelectorAll('.file-row [data-node]')].find(el=>el.dataset.node===id)?.closest('.file-row')||null;
async function renameNode(id, move = false, origin = {}, client=commands) {
  const node = projectNode(doc, id); if (!node) return;
  const guard=nodeGuard(id,move?'moving':'renaming'),destination=destinationGuard();
  const kind = node.folder ? 'folder' : 'file', row = treeRow(id);
  const path = move
    ? await openPrompt({title:`Move ${kind}`,message:'Choose a folder or edit the project path. You can review LaTeX references before anything moves.',value:node.path,label:'Move',...(origin.point||origin.anchor?origin:{anchor:row}),scope:row?.closest('.workspace'),destinations:moveDestinations(projectNodes(doc),node),composeValue:folder=>moveTarget(node,folder)})
    : row ? await inlineRename(row,node) : await openPrompt({title:`Rename ${kind}`,message:'Enter the full project path.',value:node.path,label:'Rename',...origin});
  // Another tab's or a peer's rename, move or deletion of this node ends the inline field; say why.
  if (!path) { try { guard(); } catch (error) { if (error.code === 'revision_conflict') notice(error.message); } return; }
  await moveWithReview(id,path,client,guard,destination);
}
async function removeNode(id, origin = {}, client=commands) {
  const node = projectNode(doc, id); if (!node) return;
  const guard=nodeGuard(id,'deleting'),inside=subtreeShape(id);
  const fromTree=!!document.activeElement?.closest('[role=treeitem],.file-menu');
  if (node.folder && !await openPrompt({title:'Delete folder',message:`Delete “${node.path}” and everything inside it? You can restore this deletion from the sidebar.`,label:'Delete folder',danger:true,...(origin.point||origin.anchor?origin:{anchor:treeRow(id)}),scope:treeRow(id)?.closest('.workspace')})) return;
  guard();
  if(subtreeShape(id)!==inside)throw Object.assign(new Error(`Project changed while you were deleting “${node.path}”: someone else changed what is inside it. Nothing was changed; check the folder and delete it again.`),{code:'revision_conflict'});
  client.run({op:'node.delete',id});
  if(fromTree)requestAnimationFrame(()=>(document.querySelector('[role=treeitem][tabindex="0"]')||document.querySelector('.tree-root'))?.focus());
  notice('Moved to deleted files. Use Restore last deletion to recover it.');
}
const workspaceRoot=()=>document.querySelector('.workspace');
async function addNode(kind,detail,client,expected){
  const file=kind==='file',destination=destinationGuard(),origin=detail.point||detail.anchor?detail:{anchor:document.querySelector(file?'[aria-label="Add file"]':'[aria-label="Add folder"]')};
  const path=await openPrompt({title:file?'New file':'New folder',message:file?'A name in the selected folder, or a full project path.':'Folders can contain files and other folders.',value:selectedDirectory()+(file?'chapter.tex':'figures'),label:file?'Create file':'Create folder',scope:workspaceRoot(),...origin});
  if(!path)return;
  destination(path);const id=client.run({op:'files.add',entries:[file?{kind:'text',path,content:''}:{kind:'folder',path}]},expected).ids[0];
  if(file)state.active=id;revealNode(id);
}
/** The menu behind a tree row's ⋯ button, right click, long press, and the keyboard. No id means the tree itself. */
async function treeMenu(id,origin={},client=commands,expected){
  const node=id?projectNode(doc,id):null;if(id&&!node)return;
  const row=id?treeRow(id):null,button=row?.querySelector('.file-menu'),anchor=origin.point?undefined:origin.anchor||button||document.querySelector('.tree-root');
  const blocked=treeEditBlocked(),target=doc;
  const menuSignature=()=>client===commands&&doc===target?JSON.stringify([nodeShape(id),state.trashCount,treeEditBlocked()]):null,seen=menuSignature();
  const opened=openMenu({label:node?`${node.folder?'Folder':'File'} actions`:'Project files',title:node?node.path:'Project files',note:blocked||undefined,items:treeMenuItems(node,{blocked,trashCount:state.trashCount}),anchor,point:origin.point,scope:workspaceRoot(),
    returnFocus:()=>id?treeRow(id)?.querySelector('[data-node]')||document.querySelector('.tree-root'):document.querySelector('.tree-root'),
    // Closes when what the menu offers changes, not when any file's text does.
    watchOptions:menuSignature,
    onClose:()=>row?.classList.remove('menu-open')});
  row?.classList.add('menu-open');
  const choice=await opened;if(!choice)return;
  if(menuSignature()!==seen)throw new Error('The project changed while this menu was open. Open it again.');
  const next=origin.point?{point:origin.point}:{anchor:row||anchor};
  switch(choice){
    case 'rename': await renameNode(id,false,next,client);break;
    case 'move': await renameNode(id,true,next,client);break;
    case 'delete': await removeNode(id,next,client);break;
    case 'duplicate': {
      const guard=nodeGuard(id,'duplicating'),destination=destinationGuard();
      const path=await openPrompt({title:`Duplicate ${node.folder?'folder':'file'}`,message:'An independent copy at this project path.',value:node.folder?node.path+' copy':node.path.replace(/(\.[^/.]+)?$/,' copy$1'),label:'Duplicate',scope:workspaceRoot(),...next});
      if(path){guard();destination(path);const copy=client.run({op:'node.duplicate',id,path},expected).id;if(!node.folder)state.active=copy;revealNode(copy);}
      break;
    }
    case 'new-file': case 'new-folder': state.selected=id;emit();await addNode(choice==='new-file'?'file':'folder',next,client,expected);break;
    case 'upload': {
      state.selected=id;emit();const targetDoc=doc,directory=selectedDirectory(),destination=destinationGuard(),files=await pickFiles('',true);
      importEntries(targetDoc,await readBrowserFiles(files,directory),client,expected,destination);break;
    }
    case 'import-folder': state.selected='';emit();await importFolder(client,expected);break;
    case 'restore': client.run({op:'trash.restore'},expected);if(!state.active)activateFile(state.mainFile||state.files[0]?.id);notice('Last deletion restored with its original contents.');break;
  }
}
function wireDivider() {
  const divider = document.getElementById('pane-divider'); if (!divider || divider.dataset.wired) return; divider.dataset.wired = 'true';
  const container = document.getElementById('split-panes'); let width = 50;
  const set = n => { width = Math.max(25, Math.min(75, n)); container.style.setProperty('--editor-width', `${width}%`); divider.setAttribute('aria-valuenow', String(Math.round(width))); };
  divider.setAttribute('aria-valuemin', '25'); divider.setAttribute('aria-valuemax', '75'); set(width);
  divider.onpointerdown = e => { divider.setPointerCapture(e.pointerId); divider.onpointermove = e => { const rect = container.getBoundingClientRect(); set((e.clientX - rect.left) / rect.width * 100); }; };
  divider.onpointerup = () => { divider.onpointermove = null; };
  divider.onkeydown = e => { if(composingEvent(e))return; if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); set(width + (e.key === 'ArrowLeft' ? -2 : 2)); } };
}
async function runCompile({signal,telemetryParent}={}) {
  signal?.throwIfAborted();
  texLinks.assertAllowed();
  if (!doc || state.busy) {if(signal)throw Object.assign(new Error('A build is already running or the project is closed.'),{code:'browser_busy'});return;}
  const main = state.files.find(f => f.id === state.mainFile);
  if (!main || main.binary) throw new Error('Select a .tex main document before compiling.');
  const diagnosticFiles=state.files.map(file=>file.path);
  autoPending=false;clearTimeout(autoTimer);
  const startRevision = revision, session = builds.start(projectId, commands.revision()), startProject = projectId;let renderingPdf=false;
  const trace=observe('compile',telemetryParent);
  const cancelOwned=()=>session.cancel();signal?.addEventListener('abort',cancelOwned,{once:true});
  // An open log stays open and fills live; a closed one stays closed and the status shows the step.
  state.busy = true; state.status = 'Preparing compiler…'; state.log = '';state.buildIssues=[]; liveLog.start(); emit();
  try {
    const sources=snapshot(doc),files=sources.map(f=>({path:f.path,content:f.content}));
    const manifest={mainFile:main.path,root:'/home/web_user/project_dir',pages:0,files:sources.flatMap(f=>{if(typeof f.content!=='string'||/\.(aux|bbl|toc|out|lof|lot|nav|snm|vrb|bcf|blg|log|fls|fdb_latexmk|run.xml)$/i.test(f.path))return[];let lineCount=1;for(let at=-1;(at=f.content.indexOf('\n',at+1))>=0;)lineCount++;return[{id:f.id,path:f.path,lineCount}];})};
    return await builds.publish(session,{ files, mainFile: main.path, engine: state.engine,environment:doc.getMap('meta').get('texEnvironment')??null,telemetryParent:trace?.context },{progress:message=>{const amount=/([\d.]+) of ([\d.]+) MB/.exec(message);state.downloadLoaded=amount?Number(amount[1]):0;state.downloadTotal=amount?Number(amount[2]):0;state.status=message;emit();},output:entry=>liveLog.push(entry),isActive:()=>startProject===projectId&&!leavingProject,destination:async result=>{
    liveLog.stop();
    if (!session.current() || startProject !== projectId) return;
    state.buildIssues=result.report?.issues||[];if(result.success)state.showLog=false;
    const errors=state.buildIssues.filter(issue=>issue.severity==='error').length;
    const warnings=result.report?.warningCount??state.buildIssues.filter(issue=>issue.severity==='warning').length,warningSummary=` · ${warnings} ${warnings===1?'warning':'warnings'}`;
    const count = result.packages?.length || 0, packageSummary = count ? ` · ${count} TeX ${count===1?'package':'packages'} ${result.packages.every(p=>p.cached)?'loaded from cache':'installed'}` : '';
    state.log = result.log || result.logs?.join('\n') || '';
    if (result.diagnostic) state.log = `${result.diagnostic}\n\n${state.log}`;
    if (!result.success || !result.pdf?.length) { state.showIssues=true; state.status = `Failed · ${errors} ${errors===1?'error':'errors'} · 0 pages${warningSummary} · ${result.diagnostic || 'Compilation failed'}${packageSummary}`; state.stale = state.hasPdf; }
    else if (revision !== startRevision) { state.status = `Compiled · pages unavailable${warningSummary} · source changed, compile again`; state.stale = true; }
    else {
      renderingPdf=true;navigation.clear();emit();const bytes = result.pdf.slice(); const pages = await observed('pdf_prepare',()=>showPdf(bytes,{signal:session.signal}),{parent:trace?.context,metrics:()=>[{name:'bytes',value:bytes.byteLength}]});
      if(!session.current()||startProject!==projectId)return;session.check();pdfBytes=bytes;pdfBuild={jobId:session.id,projectId:session.projectId,sourceRevision:session.revision};
      void navigation.install(result.synctex,{...manifest,pages},startRevision);
      state.hasPdf = true; state.stale = revision!==startRevision; state.status = `Compiled · ${(result.durationMs / 1000).toFixed(2)} s · ${pages} ${pages === 1 ? 'page' : 'pages'}${warningSummary}${packageSummary}${state.stale?' · source changed, compile again':''}`;
    }
    if(result.report?.truncated)state.status+=' · first 100 issues shown';
    window.scribyra.lastCompile = { ...result, pdf: undefined, log: state.log, bytes: result.pdf?.length, jobId:session.id, projectId:session.projectId, sourceRevision:session.revision, engine: state.engine, project: state.name };
    trace?.end(result.success?'success':'failure',result.success?undefined:'source');
    return window.scribyra.lastCompile;
    }});
  } catch (e) {
    trace?.end(e.name==='AbortError'?'cancelled':'failure',e.name==='AbortError'?undefined:telemetryError(e));
    if (!session.current()) return;
    const report=e.name==='AbortError'?null:buildFailure(e,{mainFile:main.path,projectFiles:diagnosticFiles});state.buildIssues=report?.issues||[];if(report)state.showIssues=true;
    window.scribyra.lastCompile = { success: false, report, diagnostic:report?.issues[0]?.summary, jobId:session.id, projectId:session.projectId, sourceRevision:session.revision, log:e.message+(e.texLog?'\n\n'+e.texLog:''), errorType: e.name, exitCode: -1 };
    state.status = e.name === 'AbortError' ? 'Compilation cancelled' : e.name==='CompileTimeoutError'?'Compilation timed out · open log':e.name==='TexEnvironmentError'?'TeX environment needs attention · open log':e.name==='TexPackageError'?'TeX package unavailable · open log':renderingPdf?'PDF preview unavailable · open log':'Compiler unavailable · open log'; state.log = e.message+(e.texLog?'\n\n'+e.texLog:''); state.status = `${e.name==='AbortError'?'':'Failed · '}${state.status} · 0 pages · ${report?.warningCount||0} warnings`;
    // A cancelled compile keeps what it printed, says so, and leaves the log where the person put it.
    if(e.name==='AbortError'){const printed=liveLog.text();state.log=`${printed?printed+'\n\n':''}Compilation cancelled. Your sources and the previous PDF are unchanged.`;}else state.showLog=false;
    return window.scribyra.lastCompile;
  } finally { trace?.end('cancelled');signal?.removeEventListener('abort',cancelOwned); if (session.current()) { liveLog.stop(); session.finish(); } }
}
async function action(name, value = '', detail = {}) {
  // A UI action that waits for the person (a prompt, dialog or picker) commits against
  // the revision current at that moment, after checking only what it depends on.
  const client=commands,expected=undefined;
  try {
    if(collaboration?.review.state.mode==='viewing'&&viewingRefuses.has(name))throw new Error('Viewing is read only. Switch to Reviewing or Editing to decide suggestions.');
    if(collaboration?.handles(name)){await collaboration.action(name,value);return;}
    if(handlesPdfAction(name)){pdfAction(name,value);return;}
    if(workspace.handles(name)){await workspace.action(name,value);return;}
    switch (name) {
      case 'upgrade-project': {
        const target=doc;if(!target||!state.upgradeAvailable)break;
        if(composingSource())throw new Error('Finish composing before exporting your open copy.');
        const revision=commands.revision(),drafts=JSON.stringify(collaboration.review.recovery());
        download(zipSync({'sources.zip':exportZip(target),'open-project.yjs':Y.encodeStateAsUpdate(target),'review-drafts.json':strToU8(drafts)}),'scribyra-before-update.zip','application/zip');
        if(await modal('Reload to update','Your open source and review drafts were exported. Check that scribyra-before-update.zip is saved before continuing. Reload now?')&&doc===target){if(commands.revision()!==revision||JSON.stringify(collaboration.review.recovery())!==drafts)throw new Error('Your text changed. Export the open copy again before reloading.');state.upgradeReload=true;window.location.reload();}
        break;
      }
      case 'recover-project': {
        if(!doc)break;if(composingSource())throw new Error('Finish the current text input before saving a recovered copy.');const target=doc,frozen=cloneProject(doc),before=client.revision(),id=crypto.randomUUID();
        if(transientProject||frozen.getMap('meta').get('texLinkOrigin')==='link'){
          try{frozen.getMap('meta').set('lineageId',crypto.randomUUID());frozen.getMap('meta').set('name',`${state.name.slice(0,148)} (recovered)`);await openProject(id,{saveCurrent:false,transientDoc:frozen});}
          finally{if(doc!==frozen)frozen.destroy();}break;
        }
        try{frozen.getMap('meta').set('lineageId',crypto.randomUUID());frozen.getMap('meta').set('name',`${state.name.slice(0,148)} (recovered)`);await observed('recovery',parent=>storage.saveProject(id,frozen,parent));}finally{frozen.destroy();}
        if(doc===target&&client.revision()===before){await openProject(id,{saveCurrent:false});notice('Recovered copy saved locally as a separate project.');}
        else notice('A recovered copy was saved. Newer edits remain in the open project; export them before leaving.');break;
      }
      case 'providers': {
        if(!doc||leavingProject)break;providerPanel?.abort();providerPanel=new AbortController();const target=doc;
        await providersDialog({connections:providerConnections,localProviders:companionDev,getCompanion:()=>companionDev?companion:null,signal:providerPanel.signal,activeSource:()=>{if(doc!==target||leavingProject)return null;const file=state.files.find(file=>file.id===state.active);return file&&!file.binary?{path:file.path,content:doc.getText(`text:${file.id}`).toString()}:null;}});break;
      }
      case 'companion': {
        if(!companionDev||!doc||leavingProject)break;const target=doc,targetId=projectId;companionPanel?.abort();companionPanel=new AbortController();
        const buildResult=()=>projectBuildResult(window.scribyra.lastCompile,targetId);
        await companionDialog({projectName:state.name,signal:companionPanel.signal,getConnection:()=>companion,disconnect:async()=>{const previous=companion;companion=null;await previous?.close();},connect:async options=>{
          if(doc!==target||leavingProject)throw new Error('This project is closed.');
          const onStatus=message=>{if(doc===target){state.companionStatus=message;emit();}};
          const connection=await connectCompanion({...options,projectId:targetId,onStatus,createHost:scope=>{
            if(doc!==target||leavingProject)throw new Error('This project is closed.');
            return companionHost({...scope,doc:target,projectId:targetId,beginMutation:()=>{for(const manager of undoManagers.values())manager.stopCapturing();},endMutation:()=>{for(const manager of undoManagers.values())manager.stopCapturing();},isActive:()=>doc===target&&!leavingProject,compile:async (signal,telemetryParent)=>{await runCompile({signal,telemetryParent});return buildResult();},getDiagnostics:()=>({issues:state.buildIssues,log:state.log}),getBuildResult:buildResult,getPdf:()=>pdfBytes?{bytes:pdfBytes.slice(),build:pdfBuild,stale:state.stale}:null});
          }});
          if(doc!==target||leavingProject){await connection.close();throw new Error('This project is closed.');}companion=connection;
        }});break;
      }
      case 'source-to-pdf': if(editor&&mountedFile)await navigation.forward(mountedFile,doc.getText(`text:${mountedFile}`).toString().slice(0,collaboration?.review.toSource(editor.state.selection.main.head)??editor.state.selection.main.head).split('\n').length);else notice('Open a text source file first.');break;
      case 'pdf-to-source': {const point=selectedPdfPosition();if(point)await navigation.inverse(point);else notice('Select text in the PDF or choose a visible PDF page first.');break;}
      case 'direct-share': if(transientProject)throw Error('Accept and save this project before sharing.');direct?.toggle();break;
      case 'home': await leaveProject(); state.current = false; state.filter = ''; await refreshProjects(); break;
      case 'new': await createProject(await modal('New project', 'Give your next idea a name.', { value: 'Untitled project', label: 'Create project' })); break;
      case 'starter': await createProject('A space for your next great idea'); break;
      case 'open': await openProject(value); break;
      case 'open-file': activateFile(value); break;
      case 'close-tab': closeTab(value); break;
      case 'editor-settings': {
        const target=doc,seen={name:state.name,mainFile:state.mainFile},result=await editorSettings(state,state.files);if(!result||target!==doc)break;
        // Only what the person changed is sent; another tab's or a peer's edit elsewhere doesn't void it.
        {const command=sharedSettings(seen,{name:result.name,mainFile:result.mainFile},'Project settings');if(Object.keys(command).length>1)client.run(command,expected);}
        Object.assign(state,{fontSize:result.fontSize,tabSize:result.tabSize,wrap:result.wrap,auto:result.auto});
        editor?.dispatch({effects:editorOptions.reconfigure(options())});document.getElementById('code-editor')?.style.setProperty('--editor-font-size',`${state.fontSize}px`);
        if(!state.auto){autoPending=false;clearTimeout(autoTimer);}persistWorkspace();emit();break;
      }
      case 'select-root': state.selected = ''; emit(); break;
      case 'select-node': {
        const node = projectNode(doc, value); if (!node) break;
        if(!node.folder)collaboration?.review.beforeLeave();
        state.selected = value;
        if (node.folder) { if (collapsed.has(value)) collapsed.delete(value); else collapsed.add(value); }
        else state.active = value;
        refreshDoc(); focusNode(value); break;
      }
      case 'rename-node': await renameNode(value); break;
      case 'move-node': await renameNode(value,true); break;
      case 'delete-node': await removeNode(value); break;
      case 'restore-deleted': client.run({op:'trash.restore'},expected); if(!state.active)activateFile(state.mainFile||state.files[0]?.id); notice('Last deletion restored with its original contents.'); break;
      case 'filter': state.filter = value; await refreshProjects(); break;
      case 'rename-project': { const target=doc,seen={name:state.name},title = await modal('Rename project', 'A name for your work.', { value: state.name, label: 'Rename' }); if (title&&target===doc) {const command=sharedSettings(seen,{name:title.slice(0,160)},'Rename project');if(command.name)client.run(command,expected);} break; }
      case 'project-menu': {
        const backup = await storage.migrationBackup(value);
        const anchor=[...document.querySelectorAll('.card-menu')].find(el=>el.dataset.project===value);
        const choice = await openMenu({label:'Project actions',anchor,items:[{label:'Open project',value:'open',icon:'open'},...(backup?[{label:'Export pre-upgrade backup',value:'backup',icon:'download'}]:[]),{separator:true},{label:'Delete project',value:'delete',icon:'trash',danger:true}]});
        if (choice === 'open') await openProject(value);
        if (choice === 'backup') { const original = new Y.Doc(); try { Y.applyUpdate(original, backup); download(exportZip(original), 'pre-upgrade-sources.zip', 'application/zip'); } finally { original.destroy(); } }
        if (choice === 'delete' && await openPrompt({title:'Delete project',message:'Deleting a local project cannot be undone. Export a backup first.',label:'Delete project',danger:true,anchor})) { await storage.deleteProject(value); await refreshProjects(); }
        break;
      }
      case 'add-file': await addNode('file',detail,client,expected);break;
      case 'add-folder': await addNode('folder',detail,client,expected);break;
      case 'file-menu': await treeMenu(value,detail,client,expected);break;
      case 'upload-files': {
        const targetDoc = doc, directory = selectedDirectory(), destination = destinationGuard(), uploads = await pickFiles('', true);
        importEntries(targetDoc,await readBrowserFiles(uploads,directory),client,expected,destination);break;
      }
      case 'import-folder': await importFolder();break;
      case 'insert-figure': {
        const snippet=figureSnippet(doc,value),target=projectNode(doc,lastSource)||projectNode(doc,state.mainFile);
        if(!target||target.binary||target.folder||! /\.(tex|ltx)$/i.test(target.path))throw new Error('Open a TeX source file first, then select the figure.');
        const text=doc.getText(`text:${target.id}`),relative=sourcePositions.get(target.id),position=relative&&Y.createAbsolutePositionFromRelativePosition(relative,doc);
        const at=position?.type===text?position.index:text.length;
        client.run({op:'text.patch',edits:[{fileId:target.id,start:at,end:at,before:'',after:snippet}]},expected);state.active=target.id;revealNode(target.id);mountEditor();
        editor?.dispatch({selection:{anchor:at+snippet.length},scrollIntoView:true});editor?.focus();notice('Figure inserted. The document must load the graphicx package.');break;
      }
      case 'replace-asset': {
        const targetDoc = doc, node = projectNode(doc, value); if (!node) break;
        const guard=nodeGuard(value,'replacing'),blob=JSON.stringify(doc.getMap('assets').get(value)??null);
        const [file] = await pickFiles('.' + node.path.split('.').pop()); if (!file) break;
        if (file.size > MAX_BYTES) throw new Error('File exceeds 64 MiB.');
        const oldExtension = node.path.split('.').pop().toLowerCase(), extension = file.name.split('.').pop().toLowerCase();
        if (oldExtension !== extension && !(['jpg','jpeg'].includes(oldExtension) && ['jpg','jpeg'].includes(extension))) throw new Error('Choose a replacement with the same file type.');
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (imageMime(node.path)) {
          const url = URL.createObjectURL(new Blob([bytes], { type: imageMime(node.path) }));
          try { const img = new Image(); img.src = url; await img.decode(); } catch { throw new Error('The replacement is not a readable image. Original file kept.'); } finally { URL.revokeObjectURL(url); }
        }
        if (doc !== targetDoc) throw new Error('Project changed. Please replace again.');
        guard();if(JSON.stringify(doc.getMap('assets').get(value)??null)!==blob)throw Object.assign(new Error(`Someone else replaced “${node.path}” while you were choosing its replacement. Nothing was changed.`),{code:'revision_conflict'});
        const added=entryCommand([{path:node.path,content:bytes}]);client.run({op:'asset.replace',id:value,blob:added.command.entries[0].blob},expected,added.attachments); notice('File replaced. Its project path and LaTeX references are unchanged.'); break;
      }
      case 'import': { const [file] = await pickFiles('.zip'); if (!file) break; if (file.size > MAX_BYTES) throw new Error('ZIP exceeds 64 MiB.'); const entries = importZip(new Uint8Array(await file.arrayBuffer())); await createProject(file.name.replace(/\.zip$/i, ''), entries); break; }
      case 'export': download(client.run({op:'project.export'},expected).bytes, `${state.name.replace(/[^a-zA-Z0-9_-]/g,'_')}.zip`, 'application/zip'); notice('Source ZIP exported. Keep it somewhere safe as a backup.'); break;
      case 'engine': if (value==='lualatex') client.run({op:'project.configure',engine:value},expected); break;
      case 'main-file': if (state.files.some(f => f.id === value && f.path.toLowerCase().endsWith('.tex'))) client.run({op:'project.configure',mainFile:value},expected); break;
      case 'auto': state.auto = !state.auto; if(!state.auto){autoPending=false;clearTimeout(autoTimer);}persistWorkspace();emit(); break;
      case 'compile': if (state.busy) { builds.cancel(); state.status = 'Cancelling compilation…'; emit(); } else if(collaboration?.review.state.preview)await collaboration.action('review-compile');else await runCompile(); break;
      case 'compile-start': collaboration?.review.flush();if(collaboration?.review.state.preview)await collaboration.action('review-compile');else await runCompile(); break;
      case 'compile-cancel': if(state.busy){builds.cancel();state.status='Cancelling compilation…';emit();} break;
      case 'issue-source': {
        const entry=state.buildIssues[Number(value)],file=state.files.find(file=>file.path===entry?.file&&!file.binary);
        if(!file)break;activateFile(file.id);
        selectSourceLine(entry.line);break;
      }
      case 'issues': {
        const open=state.showIssues||state.showLog;state.showIssues=!open;if(open)state.showLog=false;emit();break;
      }
      case 'issues-close': {
        const restore=document.activeElement?.closest('.diagnostics');state.showIssues=false;state.showLog=false;emit();
        if(restore)requestAnimationFrame(()=>document.querySelector('.compilation-status-button')?.focus());break;
      }
      case 'log': state.showLog = !state.showLog; emit(); if(state.showLog&&state.busy)requestAnimationFrame(()=>liveLog.refresh()); break;
      case 'download-pdf': if (pdfBytes) download(pdfBytes, `${state.name}.pdf`, 'application/pdf'); break;
      case 'zoom-in': await zoomPdf(.1); break;
      case 'zoom-out': await zoomPdf(-.1); break;
      case 'theme': { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; localStorage.setItem('scribyra-theme', theme); break; }
      case 'diagnostics': {
        diagnosticsPanel?.close();diagnosticsPanel=diagnosticsDialog({telemetry:diagnostics,remote:remoteDiagnostics,consent:consentDiagnostics,download});break;
      }
      case 'tex-environment': {
        if(state.busy||environmentPanel)break;clearTimeout(autoTimer);
        const targetDoc=doc,panel=new AbortController();environmentPanel=panel;
        const current=()=>{if(doc!==targetDoc||!commands||state.busy)throw new Error('Project changed or compilation is running. Open the environment again.');};
        try{await environmentDialog({signal:panel.signal,download,getState:()=>{
          current();const last=window.scribyra.lastCompile,revision=client.revision();return{revision,lock:targetDoc.getMap('meta').get('texEnvironment')??null,candidate:last?.success&&last.bytes>0&&last.projectId===projectId&&last.sourceRevision===revision?last.environment:null};
        },setLock:(environment,revision)=>{current();client.run({op:'environment.set',environment},revision);clearTimeout(autoTimer);cancelCompile();}});}
        finally{if(environmentPanel===panel)environmentPanel=null;}break;
      }
      case 'storage': {
        const info = await storage.storageStatus();
        const result = await modal('Storage & backups', `${(info.usage / 1048576).toFixed(1)} MiB used on this device.\n${info.persistent ? 'Persistent storage is enabled.' : 'The browser may clear local storage under pressure.'}\n\nLocal saves are not a remote backup. Export source ZIPs regularly. Clearing site data removes your local projects.`, { label: 'Request persistent storage' });
        if (result) notice(await navigator.storage?.persist?.() ? 'Persistent storage enabled. Keep exporting backups.' : 'Persistence was not granted. Export backups regularly.'); break;
      }
      case 'report': reportDialog({openDiagnostics:()=>action('diagnostics')}); break;
      case 'sync': {
        if(!state.plaintextDemo)break;
        if (sync) { sync.close(); sync = null; state.syncStatus = 'Local only'; state.peers = 0; mountedFile = null; mountEditor(); emit(); break; }
        const room = await modal('Local synchronization demo', 'Run cargo run -p scribyra-sync --example plaintext-demo on this machine. Connect two browser profiles using the same room.\n\nThis demonstration has no accounts or access controls. Use a new room for each project; joining an existing room merges its files into this project.', { value: 'paper-demo', label: 'Connect demo' });
        if (!room) break; if (!/^[a-zA-Z0-9_-]{1,64}$/.test(room)) throw new Error('Room names use 1–64 letters, digits, underscores or hyphens.');
        sync = connectDemo(doc, room, (status, peers) => { state.syncStatus = status; state.peers = peers; emit(); }); mountedFile = null; mountEditor(); break;
      }
      case 'dismiss': state.notice = ''; emit(); break;
    }
  } catch (e) { if(e.code!=='comment_navigation_cancelled')displayError(e); }
}
installPopups();
installTreeMenus((id,origin)=>action('file-menu',id,origin));
window.scribyra = { composing:()=>compositionInProgress(document.activeElement)||!!editor?.composing, action, lastCompile: null, ready() { queueMicrotask(async () => { try { await refreshProjects();texLinks.start(); if (allProjects.length === 0) { /* Keep first-run dashboard empty and honest. */ } } catch(e) { displayError(e); } }); } };
window.addEventListener('keydown', e => {
  if(e.defaultPrevented||document.querySelector('dialog[open]')||e.getModifierState('AltGraph')||composingEvent(e)||editor?.composing&&editor.dom.contains(e.target))return;
  if(state.current&&!document.querySelector('dialog[open]')){
    if(e.key==='Escape'&&(state.showIssues||state.showLog)){e.preventDefault();action('issues-close');return;}
    if(e.altKey&&e.key==='Enter'){e.preventDefault();action('source-to-pdf');return;}
    if((e.metaKey||e.ctrlKey)&&e.shiftKey&&['f','o'].includes(e.key.toLowerCase())){e.preventDefault();action('workspace-panel',e.key.toLowerCase()==='f'?'search':'outline');return;}
    if(e.altKey&&e.key.toLowerCase()==='w'){e.preventDefault();closeTab(state.active);return;}
    if(e.target.matches('[role=tab]')&&['ArrowLeft','ArrowRight','Home','End','Delete'].includes(e.key)){
      e.preventDefault();const i=state.tabs.findIndex(f=>f.id===state.active);
      if(e.key==='Delete')closeTab(state.active);else activateFile(state.tabs[e.key==='Home'?0:e.key==='End'?state.tabs.length-1:(i+(e.key==='ArrowLeft'?-1:1)+state.tabs.length)%state.tabs.length].id);
      requestAnimationFrame(()=>document.querySelector('[role=tab][aria-selected=true]')?.focus());return;
    }
  }
 if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); action('compile'); } if (e.key === '/' && !state.current && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); document.querySelector('[aria-label="Find a project"]')?.focus(); } });
window.addEventListener('scribyra:storage-blocked', () => notice('Close other Scribyra tabs so this version can upgrade local storage. Your projects are unchanged.'));
window.addEventListener('beforeunload', e => { if (doc && !state.upgradeReload && (collaboration?.hasCommentDraft() || !transientProject && (state.reviewDraftPending || state.saveStatus !== 'Saved locally'))) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave().catch(displayError); });
let dashboardRefresh;
watchStorage(event=>{if(!doc){clearTimeout(dashboardRefresh);dashboardRefresh=setTimeout(()=>refreshProjects().catch(displayError),80);}});
const refreshDashboard=()=>{if(!doc&&document.visibilityState!=='hidden')void refreshProjects().catch(displayError);};
window.addEventListener('focus',refreshDashboard);window.addEventListener('pageshow',refreshDashboard);document.addEventListener('visibilitychange',refreshDashboard);
setInterval(refreshDashboard,5000);
document.documentElement.dataset.theme = localStorage.getItem('scribyra-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
await init();
initializeCollaborationSchema();
remoteDiagnostics=telemetryExport({identity:typeof __SCRIBYRA_BUILD__==='undefined'?undefined:__SCRIBYRA_BUILD__,originUnixMs:Math.round(Date.now()-(performance.now()-startupAt))});
window.addEventListener('pagehide',()=>remoteDiagnostics.configure({enabled:false}));
diagnostics=telemetry({recorder:new TelemetryRecorder(),onRecord:encoded=>remoteDiagnostics.enqueue(encoded),onRemoteRecord:encoded=>consentDiagnostics?.record(encoded),onControls:settings=>remoteDiagnostics.collection(settings.collect),onClear:()=>{remoteDiagnostics.clear();consentDiagnostics?.clear();},identity:typeof __SCRIBYRA_BUILD__==='undefined'?undefined:__SCRIBYRA_BUILD__,origin:startupAt,storage:{getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)}});
consentDiagnostics=telemetryConsent({endpoint:import.meta.env.VITE_TELEMETRY_INGEST_URL,destination:import.meta.env.VITE_TELEMETRY_DESTINATION_LABEL,about:import.meta.env.VITE_TELEMETRY_ABOUT_URL,sessionRate:parseSessionRate(import.meta.env.VITE_TELEMETRY_SESSION_RATE),identity:typeof __SCRIBYRA_BUILD__==='undefined'?undefined:__SCRIBYRA_BUILD__,originUnixMs:Math.round(Date.now()-(performance.now()-startupAt)),collection:value=>diagnostics.remoteCollection(value)});
installObservability(diagnostics);
window.addEventListener('error',()=>diagnostics.begin('exception').end('failure','unknown'));
window.addEventListener('unhandledrejection',()=>diagnostics.begin('rejection').end('failure','unknown'));
const startup=diagnostics.begin('startup',null,startupAt);
startApp();
emit();
startup.end();
// After an update reload, reopen the project this tab had open (this tab only).
const REOPEN_AFTER_UPDATE='scribyra:update-reopen';
{let reopen=null;try{reopen=sessionStorage.getItem(REOPEN_AFTER_UPDATE);sessionStorage.removeItem(REOPEN_AFTER_UPDATE);}catch{}
 if(reopen&&!startedFromTexLink&&/^[A-Za-z0-9-]{1,64}$/.test(reopen)&&!doc)void openProject(reopen).catch(()=>{});}
// A newer release reloads only after the open project is committed. Its safety rules
// follow 'upgrade-project': no reload mid-composition, nothing unsaved left behind,
// and a project that needs migration goes through that heavier path instead.
async function prepareUpdateReload(){
  const refuse=reason=>({ok:false,reason});
  if(!doc||leavingProject)return{ok:true,still:()=>!doc};
  const target=doc;
  if(state.upgradeAvailable){await action('upgrade-project');return refuse('Not reloaded. This update needs your open copy exported first; use Reload to update.');}
  if(state.recoveryAvailable)return refuse('Not reloaded. This project is no longer in local storage. Export your open copy or save a recovered copy first.');
  if(transientProject)return refuse('Not reloaded. This TeX link project is only in memory. Accept local saving or export it first.');
  if(composingSource())return refuse('Not reloaded. Finish the current text input, then choose Reload.');
  try{collaboration?.review.flush();}catch(error){return refuse(`Not reloaded. ${error.message}`);}
  for(let attempt=0;attempt<3&&doc===target;attempt++){
    try{await flushSave();await saveChain;}catch(error){return refuse(`Not reloaded. ${error.message}`);}
    if(localEdits===savedEdits&&state.saveStatus==='Saved locally')break;
  }
  if(doc!==target)return refuse('Not reloaded. The open project changed.');
  if(localEdits!==savedEdits||state.saveStatus!=='Saved locally')return refuse('Not reloaded. Your latest edits are still being saved; choose Reload again.');
  if(state.reviewDraftPending)return refuse('Not reloaded. A review draft is not published yet. Publish or save it, then reload.');
  let kept='';
  if(collaboration?.hasCommentDraft()){
    if(state.comments?.error)return refuse('Not reloaded. Your comment draft could not be stored on this device. Export it, then reload.');
    kept='Saved. Your unsent comment draft is kept on this device and returns after the reload.';
  }
  const revision=commands.revision(),edits=localEdits;
  // Checked again just before reloading, after the person had time to read the message.
  const still=()=>doc===target&&!leavingProject&&!composingSource()&&commands.revision()===revision&&localEdits===edits&&savedEdits===edits&&state.saveStatus==='Saved locally'&&!state.reviewDraftPending&&!state.comments?.error;
  return{ok:true,kept,still,commit({leaveSession=false}={}){if(leaveSession)direct?.close();persistWorkspace();try{sessionStorage.setItem(REOPEN_AFTER_UPDATE,projectId);}catch{}state.upgradeReload=true;
    // Undone if the browser drops the reload: the leave warning returns.
    return()=>{state.upgradeReload=false;};}};
}
stagingMarker(typeof __SCRIBYRA_RELEASE__==='undefined'?null:__SCRIBYRA_RELEASE__);
const updates=updateNotice({build:{release:typeof __SCRIBYRA_RELEASE__==='undefined'?null:__SCRIBYRA_RELEASE__,revision:typeof __SCRIBYRA_BUILD__==='undefined'?null:__SCRIBYRA_BUILD__.revision},releaseUrl:`${import.meta.env.BASE_URL}release.json`,beforeReload:prepareUpdateReload,inSession:()=>!!state.directActive});
if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).then(registration=>updates.watch(registration)).catch(console.error);

if(initialDirectInvite){try{const invitation=parseInvite(initialDirectInvite);
  if(directEnabled())await openInvitedProject(invitation);
  else{
    // Off means off: nothing is created or stored for an invite until the person turns
    // sessions on. Until then Share shows the invite against an unsaved placeholder.
    const placeholder=new Y.Doc(),text=initialDirectInvite;placeholder.getMap('meta').set('lineageId',invitation.lineage);
    direct=directShare({doc:placeholder,author:{...localAgentOwner({getItem:key=>localStorage.getItem(key),setItem(){}}),kind:'human'},initialInvite:text,notify:notice,flushSave:async()=>{},
      onEnabled:on=>{if(state.directEnabled!==on){state.directEnabled=on;emit();}},onActive:()=>{},deleteKey:deleteDirectKey,
      enable:async()=>{await enableDirectSessions();direct?.close();direct=null;placeholder.destroy();initialDirectInvite=text;await openInvitedProject(invitation);}});
    initialDirectInvite='';direct.show();
  }}catch(error){notice(error.message);}}

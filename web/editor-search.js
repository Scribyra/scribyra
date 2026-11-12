import {runScopeHandlers} from '@codemirror/view';
import {SearchQuery,search,getSearchQuery,setSearchQuery,findNext,findPrevious,selectMatches,replaceNext,replaceAll,closeSearchPanel} from '@codemirror/search';
import {composingEvent} from './input.js';
import './editor-search.css';

const COUNT_LIMIT=10000;
const icons={word:'M9 10v4m0-2a2 2 0 1 0-4 0 2 2 0 0 0 4 0m4-5v7m0-2a2 2 0 1 0 4 0 2 2 0 0 0-4 0M3 16v3h16v-3',previous:'M12 15V5m-4 4 4-4 4 4',next:'M12 5v10m-4-4 4 4 4-4',all:'M4 4h5M4 4v5m16-5h-5m5 0v5M4 20h5m-5 0v-5m16 5h-5m5 0v-5',close:'m6 6 12 12M6 18 18 6'};
function element(tag,className){const node=document.createElement(tag);node.className=className;return node;}

// Only the panel is custom. CodeMirror retains query semantics, commands and announcements.
export function editorSearch(){return search({createPanel:view=>new EditorSearchPanel(view)});}
class EditorSearchPanel{
  constructor(view){
    this.view=view;this.query=getSearchQuery(view.state);this.matches=new Map();
    this.dom=element('div','cm-search editor-search');this.dom.setAttribute('role','search');this.dom.setAttribute('aria-label','Find in file');
    const main=element('div','cm-search-main'),field=element('div','cm-search-field'),navigation=element('div','cm-search-group'),options=element('div','cm-search-group');
    this.searchField=this.input('search','Find');this.searchField.setAttribute('main-field','true');
    this.status=element('span','cm-search-status');this.status.setAttribute('role','status');this.status.setAttribute('aria-label','Search results');this.status.setAttribute('aria-live','polite');this.status.setAttribute('aria-atomic','true');
    field.append(this.searchField,this.status);
    this.previous=this.button('prev','previous','Previous match (Shift+Enter)',()=>findPrevious(view),'previous');
    this.next=this.button('next','next','Next match (Enter)',()=>findNext(view),'next');
    this.all=this.button('select','all','Select all matches',()=>selectMatches(view),'all');navigation.append(this.previous,this.next,this.all);
    this.toggles=[['case','match case','Match case','Aa','caseSensitive'],['re','regexp','Regular expression','.*','regexp'],['word','by word','Whole word','ab','wholeWord']].map(([name,label,title,text,key])=>{
      const button=this.button(name,label,title,()=>this.commit({[key]:!this.query[key]}),key==='wholeWord'?'word':undefined);if(key!=='wholeWord'){const glyph=element('span','');glyph.textContent=text;glyph.setAttribute('aria-hidden','true');button.append(glyph);}button.classList.add('cm-search-toggle');if(key==='wholeWord')button.classList.add('cm-search-word');options.append(button);return{button,key};
    });
    const close=this.button('close','close','Close search (Escape)',()=>closeSearchPanel(view),'close');
    main.append(field,navigation,options);this.dom.append(main,close);
    const replacement=element('div','cm-search-replacement');this.replaceField=this.input('replace','Replace');
    this.replace=this.button('replace','replace','Replace current match',()=>replaceNext(view));this.replace.textContent='Replace';
    this.replaceAll=this.button('replaceAll','replace all','Replace all matches',()=>replaceAll(view));this.replaceAll.textContent='Replace all';
    replacement.append(this.replaceField,this.replace,this.replaceAll);this.dom.append(replacement);
    this.readOnly=element('span','cm-search-readonly');this.readOnly.textContent='Viewing · replacement unavailable';this.dom.append(this.readOnly);
    this.dom.addEventListener('keydown',event=>{
      if(composingEvent(event))return;
      if(runScopeHandlers(view,event,'search-panel'))event.preventDefault();
      else if(event.key==='Enter'&&(event.target===this.searchField||event.target===this.replaceField)){
        event.preventDefault();(event.target===this.replaceField?replaceNext:event.shiftKey?findPrevious:findNext)(view);
      }
    });
    this.refresh(true);
  }
  input(name,label){
    const input=element('input','cm-search-input');input.name=name;input.type='text';input.value=name==='search'?this.query.search:this.query.replace;input.placeholder=label;input.setAttribute('aria-label',this.view.state.phrase(label));input.setAttribute('form','');input.autocomplete='off';input.spellcheck=false;
    input.addEventListener('input',()=>this.commit());return input;
  }
  button(name,label,title,command,icon){
    const button=element('button',icon?'cm-search-button cm-search-icon':'cm-search-button');button.type='button';button.name=name;button.title=title;button.setAttribute('aria-label',this.view.state.phrase(label));button.addEventListener('click',command);
    if(icon){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),path=document.createElementNS(svg.namespaceURI,'path');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');path.setAttribute('d',icons[icon]);svg.append(path);button.append(svg);}return button;
  }
  commit(options={}){
    const query=new SearchQuery({...this.query,search:this.searchField.value,replace:this.replaceField.value,...options});
    if(!query.eq(this.query))this.view.dispatch({effects:setSearchQuery.of(query)});
  }
  update(update){
    const query=getSearchQuery(update.state),changed=!query.eq(this.query),recount=update.docChanged||query.search!==this.query.search||query.caseSensitive!==this.query.caseSensitive||query.regexp!==this.query.regexp||query.wholeWord!==this.query.wholeWord||query.literal!==this.query.literal||query.test!==this.query.test;
    if(changed){this.query=query;this.searchField.value=query.search;this.replaceField.value=query.replace;}
    if(changed||update.docChanged||update.selectionSet||update.startState.readOnly!==update.state.readOnly)this.refresh(recount);
  }
  refresh(recount){
    const {state}=this.view,query=this.query;
    if(recount){
      this.matches.clear();this.truncated=false;
      if(query.valid){
        const cursor=query.getCursor(state);
        // Count once per document/query, not on selection changes; bound retained ranges and work.
        while(!cursor.next().done){if(this.matches.size===COUNT_LIMIT){this.truncated=true;break;}const {from,to}=cursor.value;this.matches.set(`${from}:${to}`,this.matches.size+1);}
      }
    }
    const {from,to}=state.selection.main,current=this.matches.get(`${from}:${to}`),total=this.truncated?'10,000+':String(this.matches.size);
    const status=!query.search?'Find in file':!query.valid?'Invalid expression':!this.matches.size?'No results':current?`${current} of ${total}`:`${total} ${this.matches.size===1?'match':'matches'}`;
    if(this.status.textContent!==status)this.status.textContent=status;this.status.title=status;
    this.searchField.setAttribute('aria-invalid',String(!!query.search&&!query.valid));
    for(const {button,key}of this.toggles)button.setAttribute('aria-pressed',String(query[key]));
    const unavailable=!query.valid||!this.matches.size;
    for(const button of [this.previous,this.next,this.all])button.disabled=unavailable;
    this.replace.disabled=this.replaceAll.disabled=unavailable||state.readOnly;this.readOnly.hidden=!state.readOnly;
  }
  mount(){this.searchField.select();}
  get pos(){return 80;}
  get top(){return false;}
}

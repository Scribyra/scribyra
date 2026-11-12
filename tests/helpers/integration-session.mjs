import 'fake-indexeddb/auto';
import './core.mjs';
import {registerHooks} from 'node:module';
import * as Y from 'yjs';
import * as storage from '../../web/storage.js';
import {addFile,migrateProject} from '../../web/model.js';
import {anchors} from '../../web/comment-anchors.js';
import {collaborationCommands} from '../../web/collaboration-commands.js';
import {reviewService,projection} from '../../web/review-commands.js';
import {reviewExchange} from '../../web/review-exchange.js';
import {registerComments} from '../../web/comments.js';
import {agentCommands} from '../../web/agent-commands.js';
registerHooks({load(url,context,next){return url.endsWith('.css')?{format:'module',source:'',shortCircuit:true}:next(url,context);}});
const {mount:mountHistory}=await import('../../web/history.js');
export const initialSource='\\documentclass{article}\n\\begin{document}\nalpha | bravo | charlie\n\\end{document}\n';
export async function integrationSession({doc,projectId=crypto.randomUUID(),owner={id:crypto.randomUUID(),kind:'human',displayName:'Owner'}}={}){
 if(!doc){doc=new Y.Doc();addFile(doc,'main.tex',initialSource,'main');addFile(doc,'other.tex','untouched','other');migrateProject(doc,projectId);await storage.saveProject(projectId,doc);}
 const context={doc,projectId,author:owner,sessionId:crypto.randomUUID(),anchors,storage,locks:{request:(_name,_options,run)=>run()},flushSave:async()=>{const saved=await storage.saveProject(projectId,doc);Y.applyUpdate(doc,saved.update);}};
 const commands=collaborationCommands(context);context.commands=commands;
 const reviews=reviewService(context),exchange=reviewExchange(context,reviews),comments=registerComments(context),history=mountHistory(context),agent=agentCommands({...context,owner,isBusy:()=>false,getState:()=>({active:'main'})});
 const identity=agent.api.patchSource({expectedRevision:commands.revision(),edits:[{fileId:'other',find:'untouched',replace:'untouched'}]});if(!identity.ok)throw Error(JSON.stringify(identity));
 const agentAuthor=identity.value.authorId,agentSession=doc.getMap('changes').get(identity.value.changeId).sessionId;
 const call=(command,asAgent=true,attachments)=>{const request={version:2,requestId:crypto.randomUUID(),projectId,expectedRevision:commands.revision(),command};return asAgent?agent.api.execute(request,attachments):commands.execute(request,attachments);};
 const heads=id=>projection(doc,id).heads;
 return{doc,projectId,owner,context,commands,agentAuthor,agentSession,reviews,exchange,history,agent,call,heads,source:()=>doc.getText('text:main').toString(),async reload(){await context.flushSave();const loaded=await storage.loadProject(projectId);this.close();return integrationSession({doc:loaded,projectId,owner});},close(){agent.close();history.close();comments.close();exchange.close();reviews.close();commands.close();doc.destroy();},async remove(){this.close();await storage.deleteProject(projectId);}};
}

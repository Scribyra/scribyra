import {uiCollaborationGuard} from './ui-mutations.js';
import {reviewWorkspace} from './review-workspace.js';
import * as comments from './comments.js';
import * as reviews from './reviews.js';
import * as history from './history.js';
import {anchors} from './comment-anchors.js';
import {collaborationCommands} from './collaboration-commands.js';
import {changeOrigins} from './change-origins.js';
import {registerStateValidator,registerTransferHandler,transferState} from './collaboration-schema.js';
export function mountCollaboration(context){
  const commands=collaborationCommands(context),origins=changeOrigins(context),cleanups=[];
  let review;
  const uiGuard=uiCollaborationGuard(()=>review?.state.mode);
  const uiCommands={...commands,execute:(request,attachments,invocation)=>commands.execute(request,attachments,{...invocation,uiGuard})};
  const shared={...context,commands:uiCommands,origins,anchors,transferState,
    activeReviewId:()=>review?.state.active,
    displayPosition:(position,side)=>review?.toDisplay(position,side)??position,
    showReview:()=>{if(review&&!review.state.open)review.actions['review-toggle']();},
    registerValidator(handler){const close=registerStateValidator(handler);cleanups.push(close);return close;},
    registerTransfer(namespace,handler){const close=registerTransferHandler(namespace,handler);cleanups.push(close);return close;}};
  const modules=Object.fromEntries(Object.entries({comments,reviews,history}).map(([name,module])=>[name,module.mount({...shared,onState:state=>{context.onState?.({[name]:state});review?.refresh();}})]));
  review=reviewWorkspace({...shared,onState:context.onState},modules);
  if(modules.comments.hasDraft()&&!review.state.open)review.actions['review-toggle']?.();
  return{commands,review,hasCommentDraft:modules.comments.hasDraft,state:Object.fromEntries(Object.entries(modules).map(([name,module])=>[name,module.state])),editorExtensions:Object.values(modules).flatMap(module=>module.editorExtensions),
    /** The next source edit starts a new change record (an automatic version is being saved). */
    endBurst(){modules.history.endBurst?.();},
    handles(name){return Object.hasOwn(review.actions,name)||Object.values(modules).some(module=>Object.hasOwn(module.actions,name));},
    async action(name,value){let result;if(Object.hasOwn(review.actions,name))result=await review.actions[name](value);else{if(!name.startsWith('comment-draft'))review.flush();for(const module of Object.values(modules))if(Object.hasOwn(module.actions,name)){result=await module.actions[name](value);break;}}review.report(result);return result;},
    close(){review.close();Object.values(modules).forEach(module=>module.close());cleanups.forEach(close=>close());origins.close();commands.close();}};
}

// UI modes are interaction policy. Trusted agent/companion hosts do not use it.
export function assertUiMutation(mode,capabilities=['edit']){
  if(mode==='viewing'||mode==='reviewing'&&capabilities.includes('edit'))throw Object.assign(new Error('Switch to Editing to change accepted source with this tool.'),{code:'viewing_mode'});
}
export function uiCommandGuard(getMode){
  const reads=new Set(['project.inspect','file.read','project.export','node.planRelocation']);
  return command=>{if(!reads.has(command.op))assertUiMutation(getMode());};
}
export function uiCollaborationGuard(getMode){
  return (command,policy)=>{
    if(getMode()!=='viewing'||!policy.mutation)return;
    if(command.op==='history.restore'&&command.mode===undefined||command.op==='history.restorePlan'&&command.mode==='copy'||command.op==='history.restore'&&command.mode==='copy')return;
    if(/^(thread|message|anchor)\./.test(command.op)||['review.preview','review.export','backup.export'].includes(command.op))return;
    assertUiMutation('viewing');
  };
}

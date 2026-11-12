import {validate_collaboration_command} from './pkg/scribyra_app.js';
import {extensionCommands} from './commands.js';
import {LIMITS} from './collaboration-schema.js';
import {commandError} from './source-edits.js';
export const OWNER_RIGHTS=Object.freeze(['read','edit','comment','review','export','history']);
export function collaborationCommands(context){
  const operations=new Map(),durableOperations=new Set(['history.name','suggestion.accept','history.restore','history.compact','backup.import']);
  const durable=op=>durableOperations.has(op)||operations.get(op)?.durable===true;
  const checked=value=>{if(value?.valueVersion!==1||new TextEncoder().encode(JSON.stringify(value)).length>LIMITS.receiptBytes)throw new Error('Invalid or oversized collaboration value.');return value;};
  const host=extensionCommands({...context,capabilities:context.capabilities||OWNER_RIGHTS,
    validate(request,trusted){try{return JSON.parse(validate_collaboration_command(JSON.stringify(request),JSON.stringify(trusted)));}catch(error){throw commandError(error);}},
    isDurable:({request})=>operations.has(request.command.op)&&durable(request.command.op),
    isIsolated:({request})=>operations.get(request.command.op)?.isolated===true,
    dispatch({request,policy},attachments,trusted){
      const handler=operations.get(request.command.op);
      if(!handler)throw Object.assign(new Error('This feature is not implemented.'),{code:'unsupported_command'});
      if(trusted.durable||trusted.isolated)return(async()=>{
        const scope={...trusted,attachments,policy,...(trusted.durable?{commitPrepared:(expectedSequence,update,objects,pins,value)=>{
          trusted.commitGuard();
          if(typeof value!=='function')throw new TypeError('A durable receipt value factory is required.');
          return context.storage.commitPrepared(context.projectId,expectedSequence,update,objects,pins,{
            guard:trusted.commitGuard,signal:trusted.signal,transaction:trusted.transaction,
            prepareCommit:result=>{const receipt=structuredClone(checked(value(result)));return()=>trusted.committed(receipt);},
          });
        }}:{})};
        const prepared=handler.prepare(request.command,scope);
        if(prepared?.then)throw Object.assign(new Error('Prepare asynchronous work as a revision-bound plan before dispatch.'),{code:'invalid_request'});
        trusted.guard();
        return checked(await handler.commit(prepared,scope));
      })();
      // Payload and conditional rights (ownership, restore mode, undo) belong to the feature.
      const prepared=handler.prepare(request.command,{...trusted,attachments,policy});
      if(prepared?.then)throw Object.assign(new Error('Prepare asynchronous work as a revision-bound plan before dispatch.'),{code:'invalid_request'});
      trusted.guard();
      const value=handler.commit(prepared,trusted);
      return checked(value);
    },describe:()=>[...operations].map(([op,handler])=>({op,version:2,valueVersion:1,capabilities:handler.capabilities,durable:durable(op),...(handler.isolated?{isolated:true}:{}),limits:handler.limits||{}}))});
  return{...host,register(op,handler){if(operations.has(op))throw new Error('Command already registered.');operations.set(op,handler);return()=>operations.delete(op);},close(){operations.clear();host.close();}};
}

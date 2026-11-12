import {AbstractType} from 'yjs';
import {collaboration_versions,collaboration_lineage,validate_collaboration_state} from './pkg/scribyra_app.js';
export let SCHEMA_VERSION, DATABASE_VERSION, RECORD_VERSION, BACKUP_VERSION, COMMAND_VERSION, ROOTS, LIMITS;
let ready;
export const schemaReady=new Promise(resolve=>{ready=resolve;});
export function initializeCollaborationSchema(){
  const versions=JSON.parse(collaboration_versions());
  SCHEMA_VERSION=versions.project;DATABASE_VERSION=versions.database;RECORD_VERSION=versions.record;BACKUP_VERSION=versions.backup;COMMAND_VERSION=versions.command;
  ROOTS=Object.freeze(versions.roots);LIMITS=Object.freeze(versions.limits);ready();
}
export const lineageForProject=id=>collaboration_lineage(id);
const validators=new Set(),transfers=new Map();
export function registerStateValidator(validate){validators.add(validate);return()=>validators.delete(validate);}
export function registerTransferHandler(namespace,handler){if(transfers.has(namespace))throw new Error('Transfer handler already registered.');transfers.set(namespace,handler);return()=>transfers.delete(namespace);}
export function transferState(namespace,operation,context){const handler=transfers.get(namespace);if(!handler)throw Object.assign(new Error('This transfer is not implemented.'),{code:'unsupported_command'});return handler(operation,context);}
export function validateCollaboration(doc){
  const version=doc.getMap('meta').get('schemaVersion')??1;
  if(!Number.isInteger(version)||version<1||version>SCHEMA_VERSION)throw new Error('This project needs a newer version of Scribyra. Export or reload before editing.');
  const state={};for(const root of ROOTS){const map=doc.getMap(root);for(const record of map.values())if(record instanceof AbstractType)throw new Error('Collaboration records must be immutable JSON, not nested shared types.');if(map.size)state[root]=map.toJSON();}
  if(version>=SCHEMA_VERSION&&!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(doc.getMap('meta').get('lineageId')||''))throw new Error('Project lineage is missing or invalid.');
  try{validate_collaboration_state(JSON.stringify(state));}catch(error){throw new Error(String(error));}
  for(const validate of validators)validate(doc);
}

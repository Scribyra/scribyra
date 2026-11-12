// Test-only bundle, served by Playwright routing; never part of the application build.
import init from '../../web/pkg/scribyra_app.js';
import {initializeCollaborationSchema} from '../../web/collaboration-schema.js';
await init({module_or_path:'/foundation.wasm'});initializeCollaborationSchema();
export * as Y from 'yjs';
export * as storage from '../../web/storage.js';
export * as schema from '../../web/collaboration-schema.js';
export * as model from '../../web/model.js';
export * as assets from '../../web/assets.js';
export {collaborationCommands} from '../../web/collaboration-commands.js';
export {openDB} from 'idb';
export {bufferMutation,durableCommand,isolatedBuilds,committedOutcome,closedDurable} from './foundation-regressions.js';

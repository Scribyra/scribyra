// Exercise the same Rust/WASM model as the browser without mounting the UI.
import { readFileSync } from 'node:fs';
import { initSync } from '../../web/pkg/scribyra_app.js';
initSync({ module: readFileSync(new URL('../../web/pkg/scribyra_app_bg.wasm', import.meta.url)) });

import {initializeCollaborationSchema} from '../../web/collaboration-schema.js';
initializeCollaborationSchema();

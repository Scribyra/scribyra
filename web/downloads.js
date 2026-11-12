import policy from './cache-policy.json' with {type:'json'};
import './download-state.js';
import {observe} from './observability.js';
export const downloads=globalThis.createScribyraDownloads(policy,observe);

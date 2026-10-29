import * as pi from './pi.mjs';
import * as claude from './claude-code.mjs';
import * as dsh from './dsh.mjs';
import * as zcode from './zcode.mjs';
const adapters=Object.freeze({pi,'claude-code':claude,dsh,zcode});
export const HOSTS=Object.freeze(Object.keys(adapters));
export function buildHostSpec(options){const adapter=adapters[options?.host];if(!adapter)throw Error('harness2_host_unsupported');return adapter.buildHostSpec(options);}

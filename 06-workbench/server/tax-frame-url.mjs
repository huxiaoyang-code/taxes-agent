import {createHash} from 'node:crypto';

export const FULL_FRAME_URL_SEMANTICS='cdp_frame_url_plus_fragment_v1';
const fail=()=>{throw new Error('tax_collection_scope_changed')};
// CDP Page.Frame.url excludes the fragment; urlFragment includes its leading #.
// Keep the original serialized bytes, including a lone #, for scope binding.
export function fullFrameUrl(frame){
  if(!frame||typeof frame.url!=='string'||frame.url.includes('#'))fail();
  const fragment=Object.hasOwn(frame,'urlFragment')?frame.urlFragment:'';
  if(typeof fragment!=='string'||fragment!==''&&!fragment.startsWith('#'))fail();
  const full=frame.url+fragment;
  try{const parsed=new URL(full);if(parsed.href!==full||!['https:','http:'].includes(parsed.protocol))fail();}
  catch{fail();}
  return full;
}
export const frameUrlDigest=frame=>createHash('sha256').update(fullFrameUrl(frame)).digest('hex');

import {createHash} from 'node:crypto';

export const FULL_FRAME_URL_SEMANTICS='cdp_frame_url_plus_fragment_v1';
const fail=()=>{throw new Error('tax_collection_scope_changed')};
// CDP Page.Frame.url 不含 fragment，urlFragment 包含开头的 #。
// 保留原始序列化字节，包括单独的 #，以绑定实际范围。
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

// 只替换 stdio 子进程的公开站点传输，工具发现、参数校验、分派、解析、分页和调用记录均运行实际代码。
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';

const articleUrl='https://www.gov.cn/zhengce/synthetic-example.htm';
globalThis.fetch=async (input,options={})=>{
 const url=new URL(input instanceof Request?input.url:input);
 appendFileSync(join(process.cwd(),'requests.jsonl'),JSON.stringify({url:url.href,method:options.method??'GET',headers:Object.fromEntries(new Headers(options.headers)),body:options.body??null})+'\n');
 if(url.href==='https://www.gov.cn/zhengce/synthetic-vat-pilot.htm'){
  const html='<html><head><meta name="ArticleTitle" content="合成试点公告"><meta name="PubDate" content="2026-05-08"></head><body><article><p>合成试点实施。自2026年6月1日施行。第二阶段自2026年7月1日施行。</p></article></body></html>';
  return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8'}});
 }
 if(url.href===articleUrl){
  const html='<html><head><meta name="ArticleTitle" content="合成税务公告"><meta name="PubDate" content="2026-01-10"></head><body><article><p>第一条 合成条文仅供程序验证。</p><p>第二条 合成文件有效期间另见附件。</p><a href="/zhengce/synthetic.pdf">合成公告附件</a></article></body></html>';
  return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8'}});
 }
 if(url.pathname==='/zhengce/synthetic.pdf')return new Response('%PDF-1.7 synthetic',{headers:{'Content-Type':'application/pdf'}});
 const query=[...url.searchParams.values()].find(value=>value.startsWith('合成'));
 if(query==='合成断网')throw new TypeError('synthetic test network error');
 if(url.hostname==='sousuo.www.gov.cn'){
  if(query==='合成无匹配')return Response.json({code:1001,msg:'没有找到相关结果'});
  const rows=[{title:'合成税务公告',url:articleUrl,pubtimeStr:'2026.01.10'}];
  return Response.json({code:200,msg:'操作成功',searchVO:{catMap:{gongwen:{totalCount:1,catName:'国务院文件',currentNum:1,listVO:rows}}}});
 }
 if(url.hostname==='search.mof.gov.cn'){
  if(query==='合成部分来源')return new Response('synthetic unavailable',{status:503});
  return new Response('<html><head><title>中华人民共和国财政部_全文检索</title></head><body><div class="list_search">没有找到和您的查询相匹配的结果</div></body></html>',{headers:{'Content-Type':'text/html; charset=utf-8'}});
 }
 if(url.hostname==='www.chinatax.gov.cn'&&url.pathname==='/search5/search/s'){
  return Response.json({searchResultAll:{status:1000,total:0,searchTotal:[]}});
 }
 throw Error('synthetic transport has no route');
};
await import('../../../05-reconstruction/codex/mcp/finance-mcp/server.mjs');

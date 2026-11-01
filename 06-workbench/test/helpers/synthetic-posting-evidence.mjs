// 合成回归夹具：明确写出原件后由生产守卫实读；不关闭保护，也不自动审批。
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
export function syntheticVoucherEvidence(input,sourceRoot) {
 if(input.businessEvidence||!Array.isArray(input.entries)||input.entries.length<2)return input;
 const v={...input,voucher_date:input.voucher_date??input.date??`${input.period}-15`};
 mkdirSync(sourceRoot,{recursive:true});const path=join(sourceRoot,`synthetic-${randomUUID()}.json`);
 writeFileSync(path,JSON.stringify({凭证日期:v.voucher_date,分录:v.entries}));
 const mapping=(inputPointer,jsonPointer)=>({inputPointer,parameterLabel:'合成原件字段',transform:'identity',reason:'该回归夹具明确设定的合成业务事实',sources:[{path,jsonPointer}]});
 const mappings=[mapping('/voucher_date','/凭证日期')];
 v.entries.forEach((e,i)=>{if(e&&typeof e==='object')for(const field of ['debit','credit'])if(e[field]!==undefined&&Number(e[field])!==0)mappings.push(mapping(`/entries/${i}/${field}`,`/分录/${i}/${field}`));});
 return {...v,businessEvidence:{businessLabel:'合成凭证资料',method:'依据合成原件逐字段录入',mappings}};
}
export function syntheticPostingTool(name,args,sourceRoot) {
 if(name==='voucher_create')return syntheticVoucherEvidence(args,sourceRoot);
 if(['legacy_book_import','book_import_incremental'].includes(name)&&Array.isArray(args.payload?.vouchers)){for(const voucher of args.payload.vouchers){if(!voucher.businessEvidence){const evidence=syntheticVoucherEvidence(voucher,sourceRoot);voucher.date=evidence.voucher_date;voucher.businessEvidence=evidence.businessEvidence;}}}

 return args;
}

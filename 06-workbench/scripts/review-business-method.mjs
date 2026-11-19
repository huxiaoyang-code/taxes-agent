#!/usr/bin/env node
// 只在本机 TTY 审阅和选择不可变方法版本，不提供非交互批准参数。
import { selectBusinessMethodInteractively } from '../server/business-memory.mjs';
const args=process.argv.slice(2),allowed=new Set(['--db','--account-set-id','--period','--method-ref','--audit-dir','--source-root']),values={};
for(let index=0;index<args.length;index+=2){const key=args[index],value=args[index+1];if(!allowed.has(key)||!value||Object.hasOwn(values,key))throw Error('用法：node scripts/review-business-method.mjs --db 绝对账库路径 --account-set-id 账套ID --period YYYY-MM --method-ref bm:版本ID [--audit-dir 记录目录] [--source-root 获准来源目录]');values[key]=value;}
const result=await selectBusinessMethodInteractively({target:{accountSetId:Number(values['--account-set-id']),period:values['--period']},methodRef:values['--method-ref']},{dbPath:values['--db'],auditDir:values['--audit-dir'],sourceRoot:values['--source-root']});
console.log(JSON.stringify(result,null,2));

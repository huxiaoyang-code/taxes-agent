import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureCorrectionSources,verifyCorrectionProof} from '../server/voucher-correction-proof.mjs';

const book=(date,amount)=>({voucher_date:date,entries:[
  {code:'100201',debit:amount},{code:'112201',credit:amount},
]});
function bankFixture(){
  const root=mkdtempSync(join(tmpdir(),'proof-'));
  const path=join(root,'银行原件.csv');
  writeFileSync(path,'日期,户名,入,出,余,前\n2026-03-15,甲工厂,350,,1350,1000\n2026-03-16,甲工厂,250,,1600,1350\n');
  const originals=captureCorrectionSources(root);
  return {sourceRoot:root,originals,accountName:()=> '应收账款-甲工厂',
    before:book('2026-03-15',300),after:book('2026-03-15',350),
    proof:{...originals[0],kind:'bank_statement',columns:{date:'日期',party:'户名',inflow:'入',outflow:'出',balance:'余',priorBalance:'前'},
      lines:[{row:2,bankCode:'100201',counterCode:'112201'}]}};
}

test('独立原件逐行余额、金额和往来须同时成立；同一原始收款生成稳定的占用键',()=>{
  const f=bankFixture(),result=verifyCorrectionProof(f);
  const misallocated=book('2026-03-15',350);
  misallocated.entries[1].code='112299';
  assert.deepEqual(verifyCorrectionProof({...f,before:misallocated}).claimKeys,result.claimKeys);
  assert.throws(()=>verifyCorrectionProof({...f,before:misallocated,getPeers:()=>[book('2026-03-15',350)]}),/ambiguous_event/);
  const red=book('2026-03-15',-50);
  assert.deepEqual(verifyCorrectionProof({...f,getPeers:()=>[red]}).claimKeys,result.claimKeys);
  assert.match(result.claimKeys[0],/^[a-f0-9]{64}$/);
  assert.deepEqual(result,verifyCorrectionProof(f));
  assert.throws(()=>verifyCorrectionProof({...f,after:book('2026-03-15',300)}),/bank_ledger_mismatch/);
  assert.throws(()=>verifyCorrectionProof({...f,accountName:()=> '应收账款-乙工厂'}),/bank_counterparty_mismatch/);
  assert.throws(()=>verifyCorrectionProof({...f,getPeers:()=>[book('2026-03-15',500)]}),/ambiguous_event/);
  assert.throws(()=>verifyCorrectionProof({...f,after:book('2026-03-16',350)}),/bank_date_conflict/);
  writeFileSync(f.proof.path,'临时手抄表');
  assert.throws(()=>verifyCorrectionProof(f),/original_changed/);
});

test('同日同户多笔、同日同额串户、已经过账的原始行不能由当前申请自由挑选',()=>{
  const f=bankFixture();
  writeFileSync(f.proof.path,'日期,户名,入,出,余,前\n2026-03-15,甲工厂,350,,1350,1000\n2026-03-15,甲工厂,250,,1600,1350\n2026-03-15,乙工厂,350,,1950,1600');
  f.originals=captureCorrectionSources(f.sourceRoot);
  Object.assign(f.proof,f.originals[0]);
  assert.throws(()=>verifyCorrectionProof(f),/ambiguous_event/);
  const wrongParty=book('2026-03-15',350);
  wrongParty.entries[1].code='112299';
  assert.throws(()=>verifyCorrectionProof({...f,before:wrongParty}),/ambiguous_event/);
  const link={mappings:[{inputPointer:'/entries/0/debit',sources:[{...f.originals[0],row:2}]}]};
  assert.equal(verifyCorrectionProof({...f,previousEvidence:link}).verified,true);
  assert.throws(()=>verifyCorrectionProof({...f,previousEvidence:link,getPeers:()=>[f.after]}),/ambiguous_event/);
  const grouped={...f.after,entries:[{code:'100201',debit:400},{code:'112201',credit:350},{code:'112270',credit:50}]};
  assert.throws(()=>verifyCorrectionProof({...f,previousEvidence:link,getPeers:()=>[grouped]}),/ambiguous_event/);
});

test('倒排银行 XLSX 以交易日和相邻余额验算，同表翻转收付列会被拒绝',async()=>{
  const f=bankFixture(),path=join(f.sourceRoot,'倒排结单.xlsx'),workbook=new ExcelJS.Workbook();
  workbook.addWorksheet('说明').addRow(['合成结单']);
  const sheet=workbook.addWorksheet('流水');
  sheet.addRow(['日期','户名','入','出','余']);
  sheet.addRow([new Date('2026-03-16T00:00:00Z'),'甲工厂',250,null,1600]);
  sheet.addRow([new Date('2026-03-15T00:00:00Z'),'甲工厂',350,null,1350]);
  sheet.addRow([null,null,null,null,1000]);
  for(const row of [2,3])sheet.getCell('A'+row).numFmt='yyyy-mm-dd';
  writeFileSync(path,Buffer.from(await workbook.xlsx.writeBuffer()));
  f.originals=captureCorrectionSources(f.sourceRoot,{paths:[path]});
  f.proof={...f.proof,...f.originals[0],sheet:'流水',lines:[{...f.proof.lines[0],row:3}]};
  delete f.proof.columns.priorBalance;
  assert.equal(verifyCorrectionProof(f).verified,true);
  assert.throws(()=>verifyCorrectionProof({...f,proof:{...f.proof,columns:{...f.proof.columns,inflow:'出',outflow:'入'}}}),/columns_invalid/);
});

test('旧整理子目录与新增临时文件不进入当前委托；混合目录可单独选原件',()=>{
  const f=bankFixture(),nested=join(f.sourceRoot,'以前的整理'),derived=join(nested,'流水.csv');
  mkdirSync(nested);writeFileSync(derived,'不是客户原件');
  const fresh=join(f.sourceRoot,'新抄录.csv');writeFileSync(fresh,'派生值');
  assert(!captureCorrectionSources(f.sourceRoot).some(e=>e.path===derived));
  assert.deepEqual(captureCorrectionSources(f.sourceRoot,{paths:[f.proof.path]}),f.originals);
  assert.throws(()=>verifyCorrectionProof({...f,proof:{...f.proof,path:fresh}}),/not_delegated/);
});

test('非银行支持表更正能追到原凭证引用的同一业务行，不能拿另一行的真实数据换一笔账',()=>{
  const root=mkdtempSync(join(tmpdir(),'document-proof-')),path=join(root,'支持表.json');
  writeFileSync(path,JSON.stringify([{date:'2026-02-10',debitCode:'5601',creditCode:'2202',debit:'150.50',credit:'150.50'}]));
  const originals=captureCorrectionSources(root),ref=key=>({path,jsonPointer:'/0/'+key});
  const mapping=(pointer,key)=>({inputPointer:pointer,transform:'identity',sources:[ref(key)]});
  const mappings=[mapping('/voucher_date','date'),mapping('/entries/0/code','debitCode'),mapping('/entries/1/code','creditCode'),
    mapping('/entries/0/debit','debit'),mapping('/entries/1/credit','credit')];
  const after={voucher_date:'2026-02-10',entries:[{code:'5601',debit:150.5},{code:'2202',credit:150.5}]};
  const f={sourceRoot:root,proof:{kind:'document',...originals[0]},originals,after,before:after,
    previousEvidence:{mappings:mappings.map(m=>({...m,sources:m.sources.map(s=>({...s,sha256:originals[0].sha256}))}))},businessEvidence:{mappings}};
  assert.equal(verifyCorrectionProof(f).claimKeys.length,1);
  assert.throws(()=>verifyCorrectionProof({...f,previousEvidence:{mappings}}),/original_event_mismatch/);
  const duplicateMappings=mappings.filter(m=>m.inputPointer.startsWith('/entries/')).map(m=>({...m,
    inputPointer:m.inputPointer.replace(/entries\/(\d+)/,(_,i)=>'entries/'+(Number(i)+2))}));
  assert.throws(()=>verifyCorrectionProof({...f,after:{...after,entries:[...after.entries,...after.entries]},
    businessEvidence:{mappings:[...mappings,...duplicateMappings]}}),/document_duplicate_amount/);
  assert.throws(()=>verifyCorrectionProof({...f,previousEvidence:{mappings:[]}}),/original_event_mismatch/);
  const swapped=structuredClone(mappings);
  [swapped[1].inputPointer,swapped[2].inputPointer]=[swapped[2].inputPointer,swapped[1].inputPointer];
  assert.throws(()=>verifyCorrectionProof({...f,after:{...after,entries:[{code:'2202',debit:150.5},{code:'5601',credit:150.5}]},
    businessEvidence:{mappings:swapped}}),/document_mismatch/);
  const reused=structuredClone(mappings);
  reused.at(-1).sources[0]=ref('debit');
  assert.throws(()=>verifyCorrectionProof({...f,businessEvidence:{mappings:reused}}),/document_duplicate_amount/);
  assert.throws(()=>verifyCorrectionProof({...f,after:{...after,entries:[{code:'5601',debit:180},{code:'2202',credit:180}]}}),/document_mismatch/);
  assert.throws(()=>verifyCorrectionProof({...f,before:book('2026-02-10',150.5)}),/bank_statement_required/);
});

test('原始报销分录表按实际列和既有金额行更正，交叉取日期、摘要、遗漏费用及税额均会退回',()=>{
  const root=mkdtempSync(join(tmpdir(),'expense-proof-')),path=join(root,'企业报销登记.csv');
  writeFileSync(path,['凭证日期,报销提交日,摘要,科目编码,借方金额,贷方金额',
    '2026-02-10,2026-02-09,办公用品报销,5601,100,',
    '2026-02-10,2026-02-09,办公用品报销,222101,13,',
    '2026-02-10,2026-02-09,办公用品报销,2241,,113',
    '2026-02-11,2026-02-10,次日报销,5601,100,'].join('\n'));
  const originals=captureCorrectionSources(root),ref=(row,column)=>({path,row,column});
  const m=(inputPointer,row,column)=>({inputPointer,transform:'identity',sources:[ref(row,column)]});
  const mappings=[m('/voucher_date',2,'凭证日期'),m('/entries/0/code',2,'科目编码'),m('/entries/0/debit',2,'借方金额'),
    m('/entries/1/code',3,'科目编码'),m('/entries/1/debit',3,'借方金额'),m('/entries/2/code',4,'科目编码'),m('/entries/2/credit',4,'贷方金额')];
  const historical=mappings.map(x=>({...x,sources:x.sources.map(({row})=>({path,row,sha256:originals[0].sha256}))}));
  const after={voucher_date:'2026-02-10',summary:'办公用品报销',
    entries:[{code:'5601',debit:100},{code:'222101',debit:13},{code:'2241',credit:113}]};
  const before={voucher_date:'2026-02-09',summary:'报销登记',
    entries:[{code:'5601',debit:98},{code:'222101',debit:13},{code:'2241',credit:111}]};
  const f={sourceRoot:root,proof:{kind:'document',...originals[0]},originals,before,after,
    previousEvidence:{mappings:historical},businessEvidence:{mappings}};
  assert.equal(verifyCorrectionProof(f).claimKeys.length,3);
  const peer=rows=>({previousEvidence:{mappings:rows.map(row=>({inputPointer:'/entries/1/credit',
    sources:[{path:join(root,'同一支持表副本.csv'),sha256:originals[0].sha256,row}]}))}});
  assert.throws(()=>verifyCorrectionProof({...f,getPeers:()=>[peer([3])]}),/source_already_used/);
  assert.equal(verifyCorrectionProof({...f,getPeers:()=>[peer([5])]}).claimKeys.length,3);
  assert.throws(()=>verifyCorrectionProof({...f,after:{...after,summary:'已支付现金'}}),/summary_mismatch/);
  assert.throws(()=>verifyCorrectionProof({...f,after:{...after,entries:after.entries.map(e=>({...e,summary:'已支付现金'}))}}),/summary_mismatch/);
  for(const [row,column,date,code] of [[2,'报销提交日','2026-02-09',/document_mismatch/],[5,'凭证日期','2026-02-11',/original_event_mismatch/]]){
    assert.throws(()=>verifyCorrectionProof({...f,after:{...after,voucher_date:date},businessEvidence:{
      mappings:[m('/voucher_date',row,column),...mappings.slice(1)]}}),code);
  }
  assert.throws(()=>verifyCorrectionProof({...f,after:{...after,entries:[after.entries[0]]}}),/document_incomplete/);
});

test('嵌套原凭证可用已提交的凭证头日期，不能换成同文件另一凭证日期或金额方向',()=>{
  const root=mkdtempSync(join(tmpdir(),'journal-proof-')),path=join(root,'业务系统凭证.json');
  const journal={date:'2026-02-18',summary:'承接运费',
    entries:[{code:'5401',debit:2000,credit:0},{code:'2202',debit:0,credit:2000}]};
  writeFileSync(path,JSON.stringify([journal,{...journal,date:'2026-02-19'}]));
  const originals=captureCorrectionSources(root),mapping=(inputPointer,jsonPointer)=>({
    inputPointer,transform:'identity',sources:[{path,jsonPointer}]});
  const mappings=['/voucher_date','/entries/0/code','/entries/0/debit','/entries/1/code','/entries/1/credit']
    .map(p=>mapping(p,'/0'+(p==='/voucher_date'?'/date':p)));
  const after={...journal,voucher_date:journal.date};
  const previousEvidence={mappings:mappings.map(m=>({...m,sources:m.sources.map(s=>({...s,sha256:originals[0].sha256}))}))};
  const f={sourceRoot:root,proof:{kind:'document',...originals[0]},originals,after,
    before:{...after,voucher_date:'2026-02-16'},businessEvidence:{mappings},previousEvidence};
  assert.equal(verifyCorrectionProof(f).claimKeys.length,2);
  assert.throws(()=>verifyCorrectionProof({...f,businessEvidence:{mappings:[
    mapping('/voucher_date','/1/date'),...mappings.slice(1)]},after:{...after,voucher_date:'2026-02-19'}}),/original_event_mismatch/);
  assert.throws(()=>verifyCorrectionProof({...f,previousEvidence:{mappings:previousEvidence.mappings.slice(1)}}),/original_event_mismatch/);
  const flipped=structuredClone(mappings);
  flipped[2].inputPointer='/entries/0/credit';
  flipped[4].inputPointer='/entries/1/debit';
  assert.throws(()=>verifyCorrectionProof({...f,businessEvidence:{mappings:flipped},after:{...after,
    entries:[{code:'5401',credit:2000},{code:'2202',debit:2000}]}}),/document_mismatch/);
});

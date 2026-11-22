import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('非银行更正从原入账审计找回真实业务行，错误借贷被退回，正确费用、应付和日期写入同一正式凭证',async()=>{
  const root=mkdtempSync(join(tmpdir(),'posted-document-'));
  const originalDir=join(root,'企业原件');
  mkdirSync(originalDir);
  process.env.WORKBENCH_DATA_DIR=root;
  process.env.FINANCE_SOURCE_ROOT=originalDir;
  const A=await import('../server/accounting.mjs');
  const {db}=await import('../server/db.mjs');
  const {withRequestMetadata}=await import('../server/local-audit-coordinator.mjs');
  const {captureCorrectionSources}=await import('../server/voucher-correction-proof.mjs');
  const enterpriseKey='SYNTHETIC-DOCUMENT-CORRECTION',period='2026-02';
  const set=A.createAccountSet({name:'合成费用登记',start_period:period,enterprise:{enterpriseKey}}).id;
  const path=join(originalDir,'核准费用登记.csv');
  writeFileSync(path,'填单日期,凭证日期,摘要,借方科目编码,借方金额,贷方科目编码,贷方金额,暂估金额\n2026-02-08,2026-02-16,办公费用报销,5602,2400,2202,2400,400\n');
  const source=(inputPointer,column)=>({inputPointer,parameterLabel:'报销原件字段',
    transform:'identity',sources:[{path,row:2,column}]});
  const evidence=mappings=>({businessLabel:'费用报销',method:'按已签发的客户费用登记核对',mappings});
  const historical=evidence([source('/voucher_date','填单日期'),source('/entries/0/debit','暂估金额'),source('/entries/1/credit','暂估金额')]);
  const scope={accountSetId:set,enterpriseKey,period,
    databaseInstanceId:db.prepare('SELECT instance_id FROM audit_database_instances WHERE is_active=1').get().instance_id};
  const context={sourceRoot:originalDir,originals:captureCorrectionSources(originalDir),scope};
  try{
    const posted=withRequestMetadata({actor:'agent',operationId:randomUUID()},()=>A.createVoucher(set,{period,status:'posted',
      voucher_date:'2026-02-08',summary:'报销登记',entries:[{code:'5602',debit:400},{code:'2202',credit:400}],businessEvidence:historical}));
    const target={voucherId:posted.id,period};
    const {fingerprint}=A.inspectVoucherCorrection(set,target,context);
    const mappings=[source('/voucher_date','凭证日期'),source('/entries/0/code','借方科目编码'),source('/entries/0/debit','借方金额'),
      source('/entries/1/code','贷方科目编码'),source('/entries/1/credit','贷方金额')];
    const request={...target,expectedFingerprint:fingerprint,operationId:randomUUID(),voucher_date:'2026-02-16',
      summary:'办公费用报销',entries:[{code:'5602',debit:2400},{code:'2202',credit:2400}],
      businessEvidence:evidence(mappings),proof:{kind:'document',...context.originals[0]}};
    const apply=req=>withRequestMetadata({actor:'agent',operationId:req.operationId},()=>A.correctVoucher(set,req,context));
    const swapped={...request,operationId:randomUUID(),entries:[{code:'2202',debit:2400},{code:'5602',credit:2400}],
      businessEvidence:evidence([mappings[0],source('/entries/0/code','贷方科目编码'),mappings[2],
        source('/entries/1/code','借方科目编码'),mappings[4]])};
    assert.throws(()=>apply(swapped),/correction_document_mismatch/);
    const prior=A.getVoucher(set,posted.id);
    assert.deepEqual([prior.voucher_date,prior.entries[0].debit,prior.entries[1].credit],['2026-02-08',400,400]);
    const receipt=apply(request),result=A.getVoucher(set,posted.id);
    assert.deepEqual([result.id,result.number,result.status,result.voucher_date],[posted.id,posted.number,'posted','2026-02-16']);
    assert.deepEqual(result.entries.map(e=>[e.code,e.debit,e.credit]),[['5602',2400,0],['2202',0,2400]]);
    assert.equal(receipt.afterFingerprint,A.inspectVoucherCorrection(set,target,context).fingerprint);
    assert.equal(receipt.proofReceipt.claimKeys.length,1);
  }finally{db.close();}
});

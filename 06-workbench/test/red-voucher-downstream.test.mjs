import {assert,fs,join,DatabaseSync,harness} from './auxiliary-storage.test.mjs';
import {randomUUID} from 'node:crypto';
const h=await harness({install:false,bank:true});
const {db,dbPath,root,S,LB,A,X,makeSet,entity,allocate}=h;
let checks=0;const check=(name,fn)=>{fn();checks++;console.log('通过：'+name);};
try {
 // 使用旧版完整 DDL 构造受支持的 v1 合成账库，迁移前备份本身来自真实备份入口。
 const before=await LB.createBackup({dbPath,outDir:join(root,'before-v1')});assert.equal(before.ok,true);
 for(const sql of S.AUX_V1_DDL)db.exec(sql);
 db.prepare('INSERT INTO aux_component_migrations VALUES(1,?,?,?)').run(new Date().toISOString(),before.backupMeta.snapshotSha256,before.backupMeta.snapshotBytes);
 const setId=makeSet('red-downstream'),party=entity(setId,'party','SUPPLIER');
 A.setOpeningBalances(setId,[{code:'1002',debit:1000},{code:'3001',credit:1000}]);
 allocate(setId,{openingCode:'1002'},[{partyId:party,debit:1000}]);
 db.prepare("UPDATE sqlite_sequence SET seq=500 WHERE name='aux_allocations'").run();
 const oldAlloc=db.prepare('SELECT * FROM aux_allocations').all(),oldReceipts=db.prepare('SELECT * FROM aux_receipts ORDER BY request_id').all();
 const v1Backup=await LB.createBackup({dbPath,outDir:join(root,'legacy-v1')});assert.equal(v1Backup.ok,true);
 check('v1 精确结构及备份版本保持可读',()=>{assert.equal(S.inspectAuxiliarySchema(db).version,1);assert.equal(v1Backup.manifest.components.find(c=>c.name==='auxiliary').version,1);});
 assert.equal((await LB.verifyBackup({backupDir:v1Backup.backupDir})).ok,true);
 // 在完成 DROP 后注入 CREATE 失败，检验整个事务回滚，旧分配及结构不丢失。
 const broken=join(root,'migration-failure.db');fs.copyFileSync(join(v1Backup.backupDir,LB.SNAPSHOT_FILE),broken);
 const connection=new DatabaseSync(broken);const originalExec=connection.exec.bind(connection);let injected=false;
 connection.exec=sql=>{if(!injected&&sql.startsWith('CREATE TABLE aux_allocations ')){injected=true;throw Error('合成迁移写入失败');}return originalExec(sql);};
 await assert.rejects(S.ensureAuxiliarySchema(connection,{dbPath:broken,outDir:join(root,'failed-migration-backup')}),/合成迁移写入失败/);
 check('迁移故障恢复旧结构与全部分配',()=>{assert.equal(injected,true);assert.equal(connection.isTransaction,false);assert.equal(S.inspectAuxiliarySchema(connection).version,1);assert.deepEqual(connection.prepare('SELECT * FROM aux_allocations').all(),oldAlloc);});connection.close();
 const upgraded=await S.ensureAuxiliarySchema(db,{dbPath,outDir:join(root,'before-v2')});
 check('v1 到 v2 保留分配、回执及迁移历史',()=>{assert.equal(upgraded.status,'upgraded');assert.equal(S.inspectAuxiliarySchema(db).version,2);assert.deepEqual(db.prepare('SELECT * FROM aux_allocations').all(),oldAlloc);assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='aux_allocations'").get().seq,500);assert.deepEqual(db.prepare('SELECT * FROM aux_receipts ORDER BY request_id').all(),oldReceipts);assert.deepEqual(db.prepare('SELECT version FROM aux_component_migrations ORDER BY version').all().map(r=>r.version),[1,2]);});
 assert.equal((await LB.verifyBackup({backupDir:upgraded.backupDir})).ok,true);
 process.env.FINANCE_SOURCE_ROOT=root;
 let no=0;function post(entries,date='2026-01-10') {
  const source={voucher_date:date,entries};const name=`原始凭证-${++no}.json`;fs.writeFileSync(join(root,name),JSON.stringify(source));
  const fields=['/voucher_date',...entries.flatMap((e,i)=>['debit','credit'].filter(k=>e[k]).map(k=>`/entries/${i}/${k}`))];
  const businessEvidence={businessLabel:'合成原始凭证',method:'逐字段核对',mappings:fields.map(inputPointer=>({inputPointer,parameterLabel:'原始凭证字段',transform:'identity',sources:[{path:join(root,name),jsonPointer:inputPointer}]}))};
  return A.createVoucher(setId,{period:date.slice(0,7),voucher_date:date,status:'posted',entries,businessEvidence});
 }
 const IM=await import('../server/auxiliary-import.mjs');
 check('辅助导入合同接受有符号分录但保留期初格式',()=>{const payload={version:1,requestId:'red-import',reason:'红字原件',entities:[{ref:'p',kind:'party',code:'P',name:'供应商'}],entries:[{sourceVoucherId:'V',sourceEntryId:'E',allocations:[{partyRef:'p',credit:-20}]}],openings:[]};assert.equal(IM.parseAuxiliaryAppendix(payload).entries[0].allocations[0].creditCents,-2000);assert.throws(()=>IM.parseAuxiliaryAppendix({...payload,openings:[{openingCode:'2202',allocations:[{partyRef:'p',credit:-20}]}]}),/aux_opening_negative/);});
 const blue=post([{code:'1405',debit:100},{code:'2202',credit:100}]);
 const red=post([{code:'1405',debit:-20},{code:'2202',credit:-20}]);
 const entry=(v,code)=>db.prepare('SELECT id FROM voucher_entries WHERE voucher_id=? AND code=?').get(v.id,code).id;
 allocate(setId,{entryId:entry(blue,'2202')},[{partyId:party,credit:100}]);
 allocate(setId,{entryId:entry(red,'2202')},[{partyId:party,credit:-12}]);
 check('红字未分配余额保留原借贷栏和负号',()=>{const r=X.auxiliaryLedger(db,{accountSetId:setId,period:'2026-01',code:'2202'});assert.equal(r.totals.credit,80);assert.equal(r.totals.closing,-80);assert.equal(r.groups.find(g=>g.partyId===null).credit,-8);});
 check('红字分配拒绝越额、逆符号和双边填值',()=>{assert.throws(()=>allocate(setId,{entryId:entry(red,'2202')},[{partyId:party,credit:-21}]),/exceeds_entry/);assert.throws(()=>allocate(setId,{entryId:entry(red,'2202')},[{partyId:party,credit:1}]),/exceeds_entry/);assert.throws(()=>allocate(setId,{entryId:entry(red,'2202')},[{partyId:party,debit:1,credit:-1}]),/aux_side_invalid/);});
 allocate(setId,{entryId:entry(red,'2202')},[{partyId:party,credit:-20}]);
 check('完整红字分配可核往来对象及总账',()=>{assert.equal(X.entryPartyAllocation(db,{accountSetId:setId,entryId:entry(red,'2202')}).status,'confirmed');const r=X.auxiliaryLedger(db,{accountSetId:setId,period:'2026-01',code:'2202'});assert.equal(r.totals.credit,80);assert.equal(r.totals.closing,-80);assert.equal(A.trialBalance(setId,'2026-01').lines.find(l=>l.code==='2202').period_credit,80);});
 const insert=db.prepare('INSERT INTO aux_allocations(account_set_id,code,entry_id,party_id,debit_cents,credit_cents) VALUES(?,?,?,?,?,?)');
 check('SQL 触发器同样阻止红字超分与错号',()=>{assert.throws(()=>insert.run(setId,'2202',entry(red,'2202'),party,0,-1),/exceeds_entry/);assert.throws(()=>insert.run(setId,'2202',entry(red,'2202'),party,0,1),/exceeds_entry/);});
 const B=await import('../server/bank-reconciliation.mjs');const bank='RED-BANK';B.registerBankAccount(db,{accountSetId:setId,bankAccountId:bank,sourceId:'statement',glAccountCode:'1002'});
 const paid=post([{code:'5602',debit:100},{code:'1002',credit:100}]);
 const corrected=post([{code:'5602',debit:-20},{code:'1002',credit:-20}]);
 const mapping={columns:{date:'日期',summary:'摘要',amount:'金额',direction:'方向',refId:'流水号'},amountMode:'amount_direction',directionLabels:{inflow:['收'],outflow:['付']},currency:'CNY'};
 const imported=B.importBankBatch(db,{accountSetId:setId,bankAccountId:bank,sourceId:'statement',period:'2026-01',batchId:'red-bank-batch',csvText:'日期,摘要,金额,方向,流水号\n2026-01-10,实际付款,100,付,1\n2026-01-10,待核收款,20,收,2\n',mapping});
 B.confirmMatch(db,{accountSetId:setId,bankAccountId:bank,transactionId:imported.transactionIds[0],voucherId:paid.id,entryId:entry(paid,'1002'),reason:'付款原件核实'});
 check('红字不自动冒充反向现金流或零金额匹配',()=>{const c=B.listCandidates(db,{accountSetId:setId,bankAccountId:bank,transactionId:imported.transactionIds[1]});assert.ok(c.skipped.some(r=>r.entryId===entry(corrected,'1002')&&r.code==='red_entry_cash_evidence_required'));assert.throws(()=>B.confirmMatch(db,{accountSetId:setId,bankAccountId:bank,transactionId:imported.transactionIds[1],voucherId:corrected.id,entryId:entry(corrected,'1002'),reason:'仅凭负号不能确认退款'}),e=>e.code==='red_entry_cash_evidence_required');});
 const result=B.reconcileBank(db,{accountSetId:setId,bankAccountId:bank,period:'2026-01',asOf:'2026-01-31',statementOpenCents:100000,statementCloseCents:92000,coverageFrom:'2026-01-01',coverageTo:'2026-01-31',statementSource:'合成银行对账单'});
 check('银行余额含红字，未达表单列待核而不编方向',()=>{assert.equal(result.book.closingCents,92000);assert.equal(result.status,'pending_review');assert.equal(result.book.postedEntryCount,2);assert.equal(result.outstanding.bookRedEntriesPending[0].creditCents,-2000);assert.equal(result.outstanding.bookRedEntriesPending[0].netCents,2000);assert.equal(result.outstanding.bookPaidBankMissing.length,0);assert.equal(result.outstanding.bookReceivedBankMissing.length,0);});
 const {createFinanceModelEntry}=await import('../server/finance-model-entry.mjs'),{prepareBankDraft}=await import('../server/agent-tools.mjs');const E=createFinanceModelEntry();
 const allocation=await E.callModelTool('auxiliary_allocate',{accountSetId:setId,entryId:entry(red,'2202'),allocations:[{partyId:party,credit:-20}],requestId:'signed-model-allocation',reason:'原始红字凭证分配'});
 check('实际模型通道可返回红字辅助分配成功',()=>{assert.equal(allocation.ok,true,JSON.stringify(allocation));assert.equal(allocation.applied,true);assert.equal(allocation.projection.allocationCount,1);});
 const candidateDraft=await prepareBankDraft(setId,{tool:'bank_candidates',payload:{bankAccountId:bank,transactionId:imported.transactionIds[1]}});
 const candidateView=await E.callModelTool('bank_candidates',{accountSetId:setId,draftRef:candidateDraft.draftRef});
 check('实际模型通道披露红字候选待核数量',()=>{assert.equal(candidateView.ok,true,JSON.stringify(candidateView));assert.equal(candidateView.projection.redEntryPendingCount,1);});
 const confirmDraft=await prepareBankDraft(setId,{tool:'bank_confirm',confirm:true,payload:{bankAccountId:bank,transactionId:imported.transactionIds[1],voucherId:corrected.id,entryId:entry(corrected,'1002'),reason:'缺退款依据'}});
 const rejection=await E.callModelTool('bank_confirm',{accountSetId:setId,draftRef:confirmDraft.draftRef});
 check('实际模型通道保留红字待核码且不宣称已匹配',()=>{assert.equal(rejection.ok,false);assert.equal(rejection.error.code,'red_entry_cash_evidence_required');assert.equal(rejection.applied,false);assert.equal(rejection.needsLocalReview,true);});
 const reconDraft=await prepareBankDraft(setId,{tool:'bank_reconcile',confirm:true,payload:{bankAccountId:bank,period:'2026-01',asOf:'2026-01-31',statementOpenCents:100000,statementCloseCents:92000,coverageFrom:'2026-01-01',coverageTo:'2026-01-31',statementSource:'合成银行对账单'}});
 const reconView=await E.callModelTool('bank_reconcile',{accountSetId:setId,draftRef:reconDraft.draftRef});
 check('实际模型通道保持pending_review和红字待核数量',()=>{assert.equal(reconView.ok,true,JSON.stringify(reconView));assert.equal(reconView.projection.status,'pending_review');assert.equal(reconView.projection.redEntryPendingCount,1);});
 const T=await import('../../05-reconstruction/codex/mcp/finance-mcp/finance-model-transport.mjs');
 check('四类实际模型返回均通过MCP出站校验',()=>{for(const value of [allocation,candidateView,rejection,reconView])assert.equal(T.validateModelEnvelope(value).ok,true,JSON.stringify(T.validateModelEnvelope(value)));});
 const fresh=await LB.createBackup({dbPath,outDir:join(root,'with-red-v2')});assert.equal(fresh.ok,true);assert.equal((await LB.verifyBackup({backupDir:fresh.backupDir})).ok,true);
 check('v2 红字数据备份可完整校验，旧v1备份仍可校验',()=>assert.equal(fresh.manifest.components.find(c=>c.name==='auxiliary').version,2));assert.equal((await LB.verifyBackup({backupDir:v1Backup.backupDir})).ok,true);
 for(const [label,backup,version] of [['v1',v1Backup,1],['v2',fresh,2]]) {
  const ledgerDir=join(root,'restore-ledger-'+label);fs.mkdirSync(ledgerDir);
  const restored=await LB.restoreNew({backupDir:backup.backupDir,targetDir:join(root,'restored-'+label),ledgerPath:join(ledgerDir,'ledger.db'),operationId:randomUUID()});assert.equal(restored.ok,true,JSON.stringify(restored));
  const connection=new DatabaseSync(join(restored.targetDir,'workbench.db'));
  try {check(label+' 实际恢复保留分配与版本，恢复后待激活保护继续生效',()=>{assert.equal(S.inspectAuxiliarySchema(connection).version,version);const original=new DatabaseSync(join(backup.backupDir,LB.SNAPSHOT_FILE),{readOnly:true});try{for(const table of S.AUX_TABLES)assert.deepEqual(connection.prepare('SELECT * FROM '+table+' ORDER BY rowid').all(),original.prepare('SELECT * FROM '+table+' ORDER BY rowid').all());}finally{original.close();}assert.throws(()=>X.createAuxiliaryEntity(connection,{accountSetId:setId,kind:'party',code:'AFTER',name:'恢复后',requestId:'after'}),/restore_target_pending/);});}finally{connection.close();}
 }
 // 模拟已匹配凭证随后被损坏为负数，真实刷新必须保存失效，不能继续核销。
 db.prepare('UPDATE voucher_entries SET credit=-100 WHERE id=?').run(entry(paid,'1002'));
 check('已匹配凭证变为红字后失效并留痕',()=>{const refreshed=B.refreshMatchStates(db,{accountSetId:setId,bankAccountId:bank});assert.equal(refreshed.invalidated.length,1);assert.equal(refreshed.invalidated[0].reason,'red_entry_cash_evidence_required');});
 console.log(`红字下游 ${checks} 项通过；合成目录 ${root}`);
} finally {db.close();}





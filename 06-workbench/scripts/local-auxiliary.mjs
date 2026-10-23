#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { join,dirname } from 'node:path';
import { withRequestMetadata,operationErrorEvidence } from '../server/local-audit-coordinator.mjs';
import { installAuditSchema } from '../server/local-audit-storage.mjs';
// Explicit local file/JSON interface. It never imports db.mjs or initializes an unknown target.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { assertPlainPath, ensureAuxiliarySchema, assertAuxiliaryReady } from '../server/auxiliary-storage.mjs';
import * as A from '../server/auxiliary-accounting.mjs';
const commands={entities:A.listAuxiliaryEntities,'entity-create':A.createAuxiliaryEntity,'entity-update':A.updateAuxiliaryEntity,entries:A.listAuxiliaryEntries,allocate:A.replaceAuxiliaryAllocations,ledger:A.auxiliaryLedger,party:A.entryPartyAllocation,requirement:A.setAuxiliaryRequirement};
const readOnly=new Set(['entities','entries','ledger','party']);
let db,cliOperationId;
try {
 const [command,...rest]=process.argv.slice(2); if(command==='help'||command==='--help') {
  console.log(JSON.stringify({ok:true,usage:'local-auxiliary.mjs <install|entities|entity-create|entity-update|entries|allocate|ledger|party|requirement> --db <existing-file> [--input <json-file>] [--out <new-backup-directory>]',scope:'core5 + bank0/1 + aux1; install bank before auxiliary; explicit entry-ID binding and transactional auxiliaryAppendix v1; eight local HTTP/Agent/MCP tools; model summaries with localRef; install remains local CLI only'}));
 } else {
  if(command!=='install'&&!commands[command]) throw new Error('aux_usage');
  const options={}; for(let i=0;i<rest.length;i+=2) { if(!['--db','--input','--out','--operation-id'].includes(rest[i])||!rest[i+1]||options[rest[i]])throw new Error('aux_usage'); options[rest[i]]=rest[i+1]; }
  if(!options['--db']||(command==='install'?!options['--out']:!options['--input']))throw new Error('aux_usage');
  if(command==='install'&&options['--input']||command!=='install'&&options['--out'])throw new Error('aux_usage');
  const path=assertPlainPath(options['--db']); db=new DatabaseSync(path,{readOnly:readOnly.has(command)}); db.exec('PRAGMA foreign_keys=ON');
  const operationId=options['--operation-id']??randomUUID();if(!readOnly.has(command)&&command!=='install')cliOperationId=operationId;
  if(!readOnly.has(command)&&command!=='install'){await installAuditSchema(db,{dbPath:path,outDir:join(dirname(path),'audit-install-'+randomUUID())});}
  const result=command==='install'?await ensureAuxiliarySchema(db,{dbPath:path,outDir:options['--out']}):withRequestMetadata({operationId,actor:'cli'},()=>commands[command](db,JSON.parse(fs.readFileSync(options['--input'],'utf8').replace(/^\uFEFF/,''))));
  console.log(JSON.stringify({ok:true,...(cliOperationId?{operationId:cliOperationId}:{}),result}));
 }
} catch(error) { const code=error.code??error.message; console.log(JSON.stringify({ok:false,...(cliOperationId?{operationId:cliOperationId}:{}),...operationErrorEvidence(error),code:/^(audit_|aux_|account_set_|accounting_profile_|later_|period_)[a-z_]+$/.test(code)?code:'aux_operation_failed'})); process.exitCode=2; }
finally { if(db)db.close(); }

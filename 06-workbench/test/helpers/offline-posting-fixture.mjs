// Synthetic files only; no expected/golden artifacts are runtime inputs.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHistoryFixture } from './offline-vat-history-fixture.mjs';
import { openOfflineActionInput } from '../../server/offline-action-input.mjs';
import { buildOfflineActionPlanFromFiles } from '../../server/offline-action-plan.mjs';
export const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
export const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2));
export function createPostingFixture(directory) {
  const f = createHistoryFixture(directory, { amounts: ['891.37'], post: false });
  const materials = readJson(join(f.dir, 'materials.json')), declaration = readJson(join(f.dir, 'declaration.json')), accounting = readJson(join(f.dir, 'accounting.json')), business = readJson(join(f.dir, 'business.json'));
  const invoiceRef = { sellerKey: 'SYN-ADMIN-SUPPLIER', code: '', number: '200029' };
  writeFileSync(join(f.dir, 'purchase.csv'), `number,date,seller,buyer,net,tax,gross,status\n200029,2026-03-08,SYN-ADMIN-SUPPLIER,${f.key},271.53,8.15,279.68,blue`);
  materials.sources.push({ sourceId: 'purchase', kind: 'invoice_csv', scope: f.scope, path: 'purchase.csv', mapping: { ...materials.sources[0].mapping, role: 'purchase' } });
  business.facts.push({ factId: 'admin-basic', date: '2026-03-19', nature: 'service', performance: 'completed', settlement: 'unpaid', purpose: 'unknown', benefitPeriod: { state: 'unknown', from: null, to: null }, invoiceRef });
  const confirm = { confirmedBy: { name: 'SENSITIVE-POSTING-OPERATOR', role: 'business_operator' }, basis: '合成验收登记与合同原始依据' };
  accounting.facts.push({ factId: 'admin', kind: 'administrative_service', ...confirm, invoiceRef, contractId: 'ADMIN-CONTRACT', completionDate: '2026-03-19', purpose: 'organizational_administration', nonAsset: true, nonProjectCost: true, benefitFrom: '2026-03-01', benefitTo: '2026-03-31', benefitBasis: '当月日常组织行政服务' });
  writeFileSync(join(f.dir, 'bank.csv'), 'date,amount,direction,ref,summary\n2026-03-27,153.29,out,PREPAY-29,SENSITIVE-PAYMENT');
  materials.sources.push({ sourceId: 'bank', kind: 'bank_csv', scope: f.scope, path: 'bank.csv', mapping: { format: 'bank-csv-v1', ownerEnterpriseKey: f.key, bankAccountId: 'bank-A', dateFormat: 'YYYY-MM-DD', amountMode: 'amount_direction', currency: 'CNY', negativeAmount: 'reject', directionLabels: { inflow: ['in'], outflow: ['out'] }, columns: { date: 'date', amount: 'amount', direction: 'direction', refId: 'ref', summary: 'summary' } } });
  accounting.facts.push({ factId: 'prepay', kind: 'service_prepayment', ...confirm, bankRef: { bankAccountId: 'bank-A', refId: 'PREPAY-29' }, contractId: 'FUTURE-CONTRACT', supplierKey: 'SYN-FUTURE', serviceStartDate: '2026-04-01', serviceEndDate: '2026-06-30', ordinaryService: true, performanceThroughPeriodEnd: 'not_started', refundThroughPeriodEnd: 'none', paymentCount: 1, otherRecognitionInProvidedMaterials: 'none', relatedInvoiceRefs: [] });
  declaration.bankAccounts.accountIds = ['bank-A']; declaration.bankFacts = [{ bankAccountId: 'bank-A', refId: 'PREPAY-29', nature: 'operating_payment', evidenceIds: ['owner'] }];
  const purchase = declaration.coverage.find(c => c.kind === 'purchase'); purchase.state = 'complete'; purchase.sourceIds = ['purchase'];
  declaration.coverage.push({ kind: 'bank', accountId: 'bank-A', from: '2026-01', to: '2026-03', state: 'complete', sourceIds: ['bank'], evidenceIds: ['owner'] });
  writeJson(join(f.dir, 'materials.json'), materials); writeJson(join(f.dir, 'declaration.json'), declaration); writeJson(join(f.dir, 'accounting.json'), accounting); writeJson(join(f.dir, 'business.json'), business);
  f.inputPath = join(f.dir, 'action.json'); writeJson(f.inputPath, { version: 'offline-action-input/1', scope: f.scope, profileId: 'small-2011-basic-v1', materialsInput: 'materials.json', declaration: 'declaration.json', accountingFacts: 'accounting.json' });
  const db = new DatabaseSync(f.dbPath, { readOnly: true });
  try { f.instanceId = db.prepare('SELECT instance_id FROM audit_database_instances WHERE is_active=1').get().instance_id; } finally { db.close(); }
  return f;
}
export async function postingRequest(f, kind = 'service_sale', command = 'prepare') {
  const s = await openOfflineActionInput(f.inputPath);
  try {
    const p = await buildOfflineActionPlanFromFiles(s), t = p.tasks.find(t => t.operation === 'prepare_candidate' && t.kind === kind);
    return { version: 'offline-posting-input/1', command, inputPath: f.inputPath, target: { dbPath: f.dbPath, databaseInstanceId: f.instanceId, accountSetId: f.id, enterpriseKey: f.key }, selected: { taskId: t.taskId, businessKey: t.businessKey } };
  } finally { s.close(); }
}
export const executionRequest = (r, prepared, confirmNewSourceBinding = true) => ({ ...structuredClone(r), command: 'execute', confirmation: { operationId: prepared.operationId, dependencyDigest: prepared.dependencyDigest, policyDigest: prepared.policyDigest, confirmNewSourceBinding } });

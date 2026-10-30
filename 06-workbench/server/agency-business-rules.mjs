// 原始业务事实 → 可审计、借贷平衡的草稿；不拥有数据库或网络权限。
import { getAccountingProfile, getAccountingRoles } from './accounting-profiles.mjs';
import { evaluateAccountingStatement } from './accounting-report-rules.mjs';
import { hash, stable, requireValue, requirePlainJson } from './offline-material-adapters.mjs';
import { cents, money, quantity, roundRatio, calculateAgencyOutputVat, splitAgencyOriginalPrice, calculateAgencyObligations, calculateAgencyContributionNotices, calculateAgencyOfficialPayroll, calculateAgencyRentalPrice,calculateAgencyVehicleAcquisition,calculateAgencyUnionFees,calculateAgencyOldPropertyAppreciation,determineAgencySixTaxRelief } from './agency-tax-rules.mjs';
import { calculateAgencyExtendedTax } from './agency-extended-tax-rules.mjs';

export const AGENCY_ACCOUNTING_RULE_VERSION = 'agency-business-accounting/2';
export const AGENCY_INDUSTRIES = Object.freeze(['service', 'trade', 'ecommerce', 'catering', 'manufacturing', 'construction', 'transport', 'rental_property']);
export { AGENCY_ACCOUNTING_SOURCES } from './agency-rule-catalog.mjs';
import { AGENCY_ACCOUNTING_SOURCES } from './agency-rule-catalog.mjs';
const positive = (v, code) => { requireValue(v > 0n, code); return v; };
const total = (rows, field) => rows.reduce((n, r) => n + cents(r[field]), 0n);
const clone = structuredClone;
const dayInMonth = period => new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5)), 0)).toISOString().slice(0, 10);
const plain = (value, code) => requireValue(value && typeof value === 'object' && !Array.isArray(value), code);
const validateDate = (value) => { requireValue(typeof value === 'string' && /^20\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value, 'agency_date_invalid'); return value; };

/** 全部历史期间均从事实重放；调用者提供的合计或 posted 标志不获得信任。 */
export function evaluateAgencyAccounting(document) {
  requirePlainJson(document); plain(document.scope, 'agency_scope_invalid'); plain(document.entity, 'agency_entity_missing');
  const { scope, entity, records } = document;
  requireValue(/^202[67]-(0[1-9]|1[0-2])$/.test(scope.period) && scope.currency === 'CNY', 'agency_period_unsupported');
  validateDate(entity.businessStartDate); requireValue(entity.businessStartDate <= dayInMonth(scope.period), 'agency_business_start_after_period');
  const replayFrom = entity.accountingReplayFrom ?? (entity.businessStartDate.slice(0,7) < '2026-01' ? '2026-01' : entity.businessStartDate.slice(0,7));
  requireValue(/^202[67]-(0[1-9]|1[0-2])$/.test(replayFrom) && replayFrom >= entity.businessStartDate.slice(0,7) && replayFrom <= scope.period, 'agency_replay_start_invalid');
  requireValue(AGENCY_INDUSTRIES.includes(entity.industry), 'agency_industry_unknown');
  requireValue(Array.isArray(records) && records.length <= 20000, 'agency_records_invalid');
  const profile = getAccountingProfile(entity.profileId), roles = getAccountingRoles(entity.profileId);
  requireValue(profile.creationAllowed, 'agency_profile_unsupported');
  const issues = [], vouchers = [], vatTransactions = [], returnCostTrace = [],assetCardDrafts=[],pendingAssetDisposals=[],sales = new Map(), lots = new Map(), jobs = new Map(), contracts = new Map(), receivables = new Map(), payables = new Map(), cashIdentities = new Set();
  const officialContributions=calculateAgencyContributionNotices({scope,entity,records});
  issues.push(...officialContributions.issues);
  const officialPayroll=calculateAgencyOfficialPayroll({scope,entity,records,official:officialContributions});issues.push(...officialPayroll.issues);
  const unionByFact=new Map();for(const period of [...new Set(records.filter(r=>['payroll','union_payment'].includes(r.type)).map(r=>r.date.slice(0,7)).filter(p=>p>=replayFrom&&p<=scope.period))]){const accrual=calculateAgencyUnionFees({scope:{...scope,period},records,basis:'service_accrual'});issues.push(...accrual.issues);for(const c of accrual.calculations)unionByFact.set(c.factId,c);}
  const enterprise = entity.profileId === 'enterprise-2019-general-basic-v1', individual = entity.profileId === 'individual-bookkeeping-semantic-v1';
  const accountCode = { bank: '1002', receivable: '1122', prepayment: individual ? '2202' : '1123', payable: '2202', advance: individual ? '1122' : '2203', wages: '2211', tax: '2221', otherPayable: '2241', raw: '1403', inventory: '1405', ...roles, salesExpense: enterprise ? '6601' : '5601', taxesExpense: enterprise ? '6403' : '5403' };
  const balances = new Map(), yearFlows = new Map();
  const issue = (record, code, request) => { issues.push({ factId: record?.id ?? null, code, state: 'missing', request, sourceRefs: record?.sourceRefs ?? [] }); };
  requireValue(entity.kind !== 'individual_business' || entity.profileId === 'individual-bookkeeping-semantic-v1', 'agency_individual_system_required');
  if (individual) requireValue(['double_entry','simple'].includes(entity.bookkeepingMethod), 'agency_individual_bookkeeping_method_missing');
  const put = (code, debit, credit) => { balances.set(code, (balances.get(code) ?? 0n) + debit - credit); };
  const line = (role, debit, credit, detail = null) => { const code = accountCode[role] ?? role; requireValue(profile.coa.some(a => a.code === code), 'agency_profile_account_missing'); return { code, debit: money(debit), credit: money(credit), ...(detail ? { summary: detail } : {}) }; };
  const journal = (record, suffix, entries, reason) => {
    const debit = total(entries, 'debit'), credit = total(entries, 'credit'); requireValue(debit === credit && debit > 0n, 'agency_journal_unbalanced');
    const period = record.date.slice(0, 7);
    requireValue(record.businessIdentity && typeof record.businessIdentity.documentNumber === 'string' && record.businessIdentity.documentNumber.length > 0 && typeof record.businessIdentity.issuerKey === 'string' && typeof record.businessIdentity.event === 'string', 'agency_original_business_identity_required');
    const sourceVoucherId = `agency:${hash(stable([scope.enterpriseKey, scope.accountSetId, record.businessIdentity, suffix]))}`;
    const voucher = { sourceVoucherId, factId: record.id, period, date: record.date, word: '记', summary: reason, entries, sourceRefs: clone(record.sourceRefs), ruleVersion: AGENCY_ACCOUNTING_RULE_VERSION };
    voucher.contentDigest = hash(stable(voucher));
    vouchers.push(voucher);
    for (const entry of entries) { const d = cents(entry.debit), c = cents(entry.credit); put(entry.code, d, c); if (period.slice(0, 4) === scope.period.slice(0, 4)) yearFlows.set(entry.code, (yearFlows.get(entry.code) ?? 0n) + d - c); }
  };
  const stock = (itemId, inventoryType) => { requireValue(typeof itemId === 'string' && itemId.length > 0 && ['raw', 'inventory'].includes(inventoryType), 'agency_item_invalid'); if (!lots.has(itemId)) lots.set(itemId, { itemId, inventoryType, layers: [] }); const s = lots.get(itemId); requireValue(s.inventoryType === inventoryType, 'agency_item_class_conflict'); return s; };
  const receive = (r, count, cost, inventoryType, refs) => { positive(count, 'agency_quantity_zero'); requireValue(cost >= 0n, 'agency_stock_cost_negative'); stock(r.itemId, inventoryType).layers.push({ quantity: count, cost, sourceFactId:r.originFactId??r.id??null, sourceRefs: clone(refs) }); };
  const consume = (r, inventoryType) => {
    const s = stock(r.itemId, inventoryType), count = positive(quantity(r.quantity), 'agency_quantity_zero'); requireValue(s.layers.reduce((n, l) => n + l.quantity, 0n) >= count, 'agency_inventory_shortage');
    let left = count, cost = 0n; const allocations = [];
    for (const layer of s.layers) { if (left === 0n) break; const taken = left < layer.quantity ? left : layer.quantity, part = taken === layer.quantity ? layer.cost : roundRatio(layer.cost * taken, layer.quantity); allocations.push({ quantity: taken.toString(), cost: money(part), sourceFactId:layer.sourceFactId, sourceRefs: clone(layer.sourceRefs) }); layer.quantity -= taken; layer.cost -= part; left -= taken; cost += part; }
    s.layers = s.layers.filter(l => l.quantity > 0n); return { cost, quantity: count, allocations };
  };
  const job = (id, kind = 'production') => { requireValue(typeof id === 'string' && id.length > 0, 'agency_job_missing'); if (!jobs.has(id)) jobs.set(id, { id, kind, cost: 0n, futureCost: 0n, elements: { material: 0n, labor: 0n, overhead: 0n }, sourceRefs: [] }); requireValue(jobs.get(id).kind === kind, 'agency_job_kind_conflict'); return jobs.get(id); };
  const carryJob = (r, amount, kind, element) => { const j = job(r.jobId, kind); requireValue(Object.hasOwn(j.elements, element), 'agency_cost_element_missing'); j.cost += amount; j.elements[element] += amount; if (kind === 'contract') { requireValue(r.recoverable === true && typeof r.resourceConsumed === 'boolean', 'agency_contract_resource_consumption_or_recovery_missing'); if (!r.resourceConsumed) j.futureCost += amount; } j.sourceRefs.push(...r.sourceRefs); };
  const currentRows = records.filter(r => r.date <= dayInMonth(scope.period) && (r.date.slice(0,7) >= replayFrom || r.type.startsWith('opening_') || ['entity','owner','prior_loss','income_evidence','obligation_inventory','tax_location'].includes(r.type))).sort((a, b) => a.date.localeCompare(b.date) || (a.sequence ?? 0) - (b.sequence ?? 0) || a.id.localeCompare(b.id));
  const identities = new Set(), originalIdentities = new Set(),derivedLeaseEvents=new WeakSet(),trustedNativeEvents=new WeakSet(),workQueue=[...currentRows];
  if(document.nativeAssetContext){
    const context=document.nativeAssetContext;requireValue(['enterpriseKey','accountSetId','databaseInstanceId','currency'].every(k=>context.scope[k]===scope[k])&&context.scope.period>=scope.period,'agency_native_asset_scope_mismatch');issues.push(...context.issues.filter(i=>i.period<=scope.period));
    for(const v of context.vouchers.filter(v=>v.period>=replayFrom&&v.period<=scope.period)){
      const event={id:`native-core:${v.voucherId}`,type:'agency_native_asset_depreciation',date:v.date,enterpriseKey:scope.enterpriseKey,businessIdentity:{issuerKey:'LOCAL-CORE',documentNumber:String(v.voucherId),event:v.fingerprint},sourceRefs:v.sourceRefs,nativeVoucher:v};trustedNativeEvents.add(event);workQueue.push(event);
      for(const run of v.runs){const card=context.cards.find(c=>c.card.id===run.cardId),raw=records.find(r=>r.id===card.factId);if(raw.use!=='production')continue;const allocations=(raw.productionAllocations??[]).filter(a=>a.period===v.period);if(raw.productionAllocationEvidenceVerified!==true||!allocations.length){issue(raw,'agency_native_asset_production_allocation_missing','core实际生产折旧仍需原机时/任务归集，未分配不能当产品成本已完整');continue;}const weights=allocations.map(a=>quantity(a.machineHours)),total=weights.reduce((n,x)=>n+x,0n);requireValue(total>0n,'agency_native_asset_production_driver_invalid');let cumulative=0n,allocated=0n;for(const [i,a] of allocations.entries()){validateDate(a.allocationDate);requireValue(a.jobId&&a.allocationDate.slice(0,7)===v.period&&a.allocationDate<=v.date,'agency_native_asset_production_driver_invalid');cumulative+=weights[i];const target=roundRatio(cents(run.amount)*cumulative,total),cost=target-allocated;allocated=target;if(cost){const c={...event,id:`${event.id}/cost/${run.cardId}/${i}`,type:'agency_native_asset_cost',date:a.allocationDate,sequence:a.sequence??-1,jobId:a.jobId,cost:money(cost)};trustedNativeEvents.add(c);workQueue.push(c);}}}
    }
    workQueue.sort((a,b)=>a.date.localeCompare(b.date)||(a.sequence??0)-(b.sequence??0)||a.id.localeCompare(b.id));
  }
  for (let cursor=0;cursor<workQueue.length;cursor++) {
    const r=workQueue[cursor];
    validateDate(r.date); requireValue(typeof r.id === 'string' && r.id.length && !identities.has(r.id), 'agency_fact_identity_conflict'); identities.add(r.id);
    requireValue(r.enterpriseKey === scope.enterpriseKey && Array.isArray(r.sourceRefs) && r.sourceRefs.length > 0 && r.sourceRefs.every(ref => ref.kind === 'source' && typeof ref.locator === 'string' && /^[a-f0-9]{64}$/.test(ref.digest)), 'agency_fact_evidence_invalid');
    const snapshot = { lots: clone([...lots]), jobs: clone([...jobs]), sales: clone([...sales]), contracts: clone([...contracts]), receivables: clone([...receivables]), payables: clone([...payables]), cashIdentities: [...cashIdentities], balances: clone([...balances]), yearFlows: clone([...yearFlows]), count: vouchers.length, vat: vatTransactions.length,assetCards:assetCardDrafts.length,disposals:pendingAssetDisposals.length };
    try {
      if (r.businessIdentity&&!derivedLeaseEvents.has(r)&&!trustedNativeEvents.has(r)) { const key = stable(r.businessIdentity); requireValue(!originalIdentities.has(key), 'agency_original_business_duplicate'); originalIdentities.add(key); }
      if (['sale', 'sale_return', 'service_complete', 'transport_complete', 'property_service_complete', 'construction_billing', 'rental', 'lease_lessee'].includes(r.type)) requireValue(r.taxJurisdiction === 'domestic' && r.specialVatTreatment === 'ordinary' && r.crossBorder !== true, 'agency_vat_transaction_scope_unverified');
      switch (r.type) {
        case 'entity': case 'period_coverage': case 'obligation_inventory': case 'income_evidence': case 'prior_loss': case 'quarter_profile': case 'tax_location': case 'owner': case 'annual_employment': case 'contract': case 'opening_vat_prepayment': case 'opening_vat': case 'tax_payment': case 'property_asset': case 'land_asset': case 'vehicle': case 'vehicle_catalogue_entry': case 'excise_product': case 'extraction': case 'water_extraction': case 'pollutant_discharge': case 'farmland_use': case 'import_export': case 'advertising': case 'entertainment': case 'union': case 'union_payment': case 'personal_payment': case 'construction_cash': case 'construction_tax_trigger': case 'subcontract_payment': case 'contribution_parameters': case 'contribution_wage_history': case 'filing_context': case 'six_tax_relief_qualification': case 'contribution_notice': case 'contribution_payment': case 'disability_parameters': case 'tobacco_leaf_purchase': case 'foreign_port_vessel_entry': case 'rental_repair': case 'personal_rental_tax': case 'land_appreciation_unit': break;
        case 'property_acquisition': {
          // 在实际取得购入发票前，旧持有线索仅保留为元数据。
          if(!r.assetPurchaseInvoiceNumber)break;
          requireValue(r.assetUse==='under_construction'&&r.assetKind==='building'&&r.deliveryAcceptanceDocumentNumber&&r.deliveredOn&&validateDate(r.deliveredOn)<=r.date&&['paid','unpaid'].includes(r.settlement)&&r.inputVatTreatment==='non_deductible','agency_extended_property_acquisition_accounting_missing');
          const net=cents(r.priceExcludingVat),vat=cents(r.invoiceVat),gross=cents(r.invoiceGross);requireValue(net+vat===gross&&net>=0n&&vat>=0n,'agency_invoice_total_mismatch');
          const taxes=[r,...records.filter(x=>x.type==='farmland_use'&&x.relatedBusinessFactId===r.id&&x.date.slice(0,7)===r.date.slice(0,7))].map(x=>calculateAgencyExtendedTax({obligationId:x===r?'deed':'farmland_occupation',record:x,scope,entity,sixTaxRelief:determineAgencySixTaxRelief({scope:{...scope,period:r.date.slice(0,7)},entity,records}).eligible}));
          const extra=taxes.reduce((n,c)=>n+cents(c.due),0n);journal({...r,sourceRefs:[...r.sourceRefs,...taxes.flatMap(t=>t.sourceRefs)]},'property_construction',[line('1604',gross+extra,0n),line(r.settlement==='paid'?'bank':'payable',0n,gross),...(extra?[line('tax',0n,extra)]:[])],'取得原工程/未达可使用状态房产按原票及已核契税耕占税资本化，达到可用后须既有core资产流程，不提前折旧');payables.set(r.id,r.settlement==='paid'?0n:gross);break;
        }
        case 'vehicle_acquisition':{
          requireValue(['admin','transport','production'].includes(r.use),'agency_vehicle_benefit_use_missing');
          const v=calculateAgencyVehicleAcquisition({entity,record:r,records}),gross=cents(v.invoiceGross),input=cents(v.deductibleInputVat),purchaseCost=gross-input,tax=cents(v.due);
          journal(r,'vehicle_purchase',[line('1601',purchaseCost,0n),...(input?[line('tax',input,0n)]:[]),line(r.settlement==='paid'?'bank':'payable',0n,gross)],'原自用车辆发票购入，按已核抵扣用途分别资本化原价及不可抵扣VAT');if(tax)journal(r,'vehicle_purchase_tax',[line('1601',tax,0n),line('tax',0n,tax)],'程序依法计算车辆购置税计入固定资产成本，不作当期税金费用');
          if(r.settlement==='unpaid')payables.set(r.id,gross);
          const startPeriod=new Date(Date.UTC(Number(r.date.slice(0,4)),Number(r.date.slice(5,7)),1)).toISOString().slice(0,7);
          const native=document.nativeAssetContext?.cards.find(c=>c.factId===r.id);
          assetCardDrafts.push({factId:r.id,vin:r.vin,originalBusinessIdentity:r.businessIdentity,coreEntrypoint:'accounting.addAssetCard',depreciationEntrypoint:'accounting.generateDepreciation',accountSetId:scope.accountSetId,card:{name:r.assetName??r.vin,kind:'fixed',original_cost:v.assetCost,acquired_period:r.date.slice(0,7),start_period:startPeriod,useful_life_months:r.usefulLifeMonths??null,residual_rate:r.residualRate??null,asset_account:'1601',accum_account:'1602',expense_account:r.use==='transport'?roles.mainCost:r.use==='production'?roles.productionCost:roles.adminExpense,ledger_status:'booked',ledger_note:`原车辆VIN ${r.vin}，发票${r.invoiceNumber}及AGENCY购入/购税资本化凭证核对`,origin:'purchase'},status:native?'core_card_reconciled':'core_card_and_depreciation_operation_required',...(native?{nativeCardId:native.card.id,operation:native.operation}:{}),reason:native?'原件已与现库唯一卡片/真实审计操作勾稽；逐期计提状态另列nativeAssetContext，不信JSON posted':'卡片创建及次月计提由现固定core能力分别人审执行并保留各operation证据；AGENCY不再生成第二套折旧，缺寿命/残值/受益用途需核',sourceRefs:r.sourceRefs});break;
        }
        case 'agency_native_asset_depreciation':{
          requireValue(trustedNativeEvents.has(r),'agency_native_asset_event_untrusted');journal(r,'native_core_depreciation',r.nativeVoucher.entries,'复用本机core已过账资产计提/run与实际审计证据，AGENCY不再产生第二次折旧');vouchers.at(-1).coreProof={voucherId:r.nativeVoucher.voucherId,fingerprint:r.nativeVoucher.fingerprint,operation:r.nativeVoucher.operation};break;
        }
        case 'agency_native_asset_cost':{requireValue(trustedNativeEvents.has(r),'agency_native_asset_event_untrusted');carryJob(r,cents(r.cost),'production','overhead');break;}
        case 'property_disposal':{
          requireValue(entity.profileId==='small-2011-basic-v1'&&r.taxJurisdiction==='domestic'&&r.specialVatTreatment==='ordinary'&&r.crossRegion===false&&r.disposalAssetLedgerVerified===true&&r.assetOriginalInvoiceNumber&&['paid','unpaid'].includes(r.settlement),'agency_property_disposal_accounting_facts_missing');
          const land=calculateAgencyOldPropertyAppreciation({record:r}),cost=cents(r.originalAssetCost),depreciation=cents(r.accumulatedAssetDepreciation),gross=cents(r.saleGross),vat=cents(r.saleInvoiceVat),net=gross-vat;requireValue(cost>=depreciation&&depreciation>=0n,'agency_property_disposal_book_value_invalid');
          requireValue((balances.get('1601')??0n)>=cost&&-(balances.get('1602')??0n)>=depreciation,'agency_property_disposal_original_ledger_missing');
          requireValue(entity.vatStatus==='general'&&r.vatAssessmentMethod==='general'&&r.simplifiedElection===false,'agency_property_disposal_vat_method_or_differential_evidence_missing');
          for(const receipt of r.relatedTaxReceipts){validateDate(receipt.paidOn);if(receipt.paidOn.slice(0,7)>=replayFrom)requireValue(records.some(p=>p.type==='tax_payment'&&p.obligationId===receipt.obligationId&&p.propertyId===r.propertyId&&p.taxReceiptNumber===receipt.receiptNumber&&p.date===receipt.paidOn&&cents(p.amount)===cents(receipt.amount)&&p.paymentReference),'agency_property_disposal_tax_payment_reconciliation_missing');}
          // 一般计税方法下普通销售适用 9%；小规模或老项目简易计税选择
          // 需要原价差额凭证支持，此处不作推断。
          const output=calculateAgencyOutputVat({entity,category:'real_estate_lease',net:money(net),date:r.date,invoiceKind:r.invoiceKind});requireValue(cents(output.tax)===vat,'agency_property_disposal_vat_unverified');
          journal(r,'asset_disposal_remove',[line('1606',cost-depreciation,0n),...(depreciation?[line('1602',depreciation,0n)]:[]),line('1601',0n,cost)],'按原资产取得发票/累计折旧及原账核对转入固定资产清理，税务评估价值不代替账面净值');
          journal(r,'asset_disposal_sale',[line(r.settlement==='paid'?'bank':'receivable',gross,0n),line('1606',0n,net),...(vat?[line('tax',0n,vat)]:[])],'旧商业房原有偿转让价款，账面清理和土地增值税扣除基础分开');
          if(r.settlement==='unpaid')receivables.set(r.id,gross);
          vatTransactions.push({factId:r.id,date:r.date,net:money(net),tax:money(vat),category:'real_estate_sale',invoiceKind:r.invoiceKind,sourceRefs:r.sourceRefs});pendingAssetDisposals.push({factId:r.id,propertyId:r.propertyId,projectId:r.projectId,period:r.date.slice(0,7),date:r.date,originalBusinessIdentity:r.businessIdentity,netProceeds:money(net),bookNet:money(cost-depreciation),landTaxCalculation:'basic_assessment_unit_pending',sourceRefs:r.sourceRefs});break;
        }
        case 'opening_inventory': {
          requireValue(r.date < `${replayFrom}-01` && (entity.businessStartDate.slice(0,7) === replayFrom || r.asOfPeriod === replayFrom) && r.stocktakeVerified === true, 'agency_opening_inventory_unverified');
          receive(r, quantity(r.quantity), cents(r.documentCost), r.inventoryType, r.sourceRefs);
          put(accountCode[r.inventoryType], cents(r.documentCost), 0n); break;
        }
        case 'input_vat_adjustment': {
          requireValue(entity.vatStatus === 'general' && r.inputVatTreatment === 'transfer_out' && r.originalInvoiceId && r.transferReason && ['admin', 'cost', 'inventory'].includes(r.destination), 'agency_input_transfer_evidence_missing');
          const amount = positive(cents(r.invoiceTax), 'agency_input_transfer_amount_invalid');
          journal(r, 'input_transfer_out', [line(r.destination === 'admin' ? 'adminExpense' : r.destination === 'inventory' ? 'inventory' : 'mainCost', amount, 0n), line('tax', 0n, amount)], '按原票用途变化及转出理由转出进项，保留原发票关联'); break;
        }
        case 'opening_balance': {
          requireValue(r.date < `${replayFrom}-01` && (entity.businessStartDate.slice(0,7) === replayFrom || r.asOfPeriod === replayFrom) && r.originVerified === true && profile.coa.some(a => a.code === r.accountCode), 'agency_opening_balance_unverified');
          put(r.accountCode, cents(r.debit), cents(r.credit)); if (r.accountCode === '1122') receivables.set(r.id, cents(r.debit)-cents(r.credit)); if (r.accountCode === '2202') payables.set(r.id, cents(r.credit)-cents(r.debit)); break;
        }
        case 'purchase': {
          requireValue(['paid', 'unpaid'].includes(r.settlement) && ['deductible', 'non_deductible'].includes(r.inputVatTreatment), 'agency_purchase_facts_missing');
          const net = cents(r.net), tax = cents(r.invoiceTax), gross = cents(r.gross); requireValue(net >= 0n && tax >= 0n && gross === net + tax, 'agency_invoice_total_mismatch');
          const deductible = entity.vatStatus === 'general' && r.inputVatTreatment === 'deductible';
          const taxFacts=records.filter(x=>['tobacco_leaf_purchase','import_export'].includes(x.type)&&x.relatedBusinessFactId===r.id),taxes=taxFacts.map(x=>{requireValue(x.date.slice(0,7)===r.date.slice(0,7),'agency_extended_tax_purchase_period_missing');const c=calculateAgencyExtendedTax({obligationId:x.type==='tobacco_leaf_purchase'?'tobacco':'customs',record:x,scope:{...scope,period:r.date.slice(0,7)},entity});if(x.type==='tobacco_leaf_purchase')requireValue(cents(x.purchasePrice)===net,'agency_extended_tobacco_invoice_conflict');else requireValue(cents(x.invoiceCny)===net&&['freightToBorderCny','insuranceToBorderCny','assistsCny','royaltiesCny'].every(k=>cents(x[k])===0n),'agency_extended_customs_ancillary_accounting_allocation_missing');return c;});
          let importVat=0n,importDeductible=0n;for(const [i,x] of taxFacts.entries())if(x.type==='import_export'){const c=taxes[i];requireValue(c.importVat!==null&&cents(r.invoiceTax)===0n&&['deductible','non_deductible'].includes(x.inputVatTreatment),'agency_extended_import_vat_original_missing');const v=cents(c.importVat);importVat+=v;if(x.inputVatTreatment==='deductible'){requireValue(entity.vatStatus==='general'&&x.importVatTaxReceiptNumber&&/^20\d\d-\d\d-\d\d$/.test(x.certifiedDate??''),'agency_extended_import_vat_certification_missing');importDeductible+=v;}}
          const extra=taxes.reduce((n,c)=>n+cents(c.due),0n),cost = (deductible ? net : gross)+extra+importVat-importDeductible,sourceRefs=[...r.sourceRefs,...taxFacts.flatMap(x=>x.sourceRefs)];
          receive(r, quantity(r.quantity), cost, r.inventoryType, sourceRefs);
          const entries = [line(r.inventoryType, cost, 0n), ...(deductible && tax ? [line('tax', tax, 0n, '应交增值税—进项税额')] : []),...(importDeductible?[line('tax',importDeductible,0n,'按原进口专用缴款书认证日期抵扣；进口VAT不进入可抵扣存货成本')]:[]), line(r.settlement === 'paid' ? 'bank' : 'payable', 0n, gross),...(extra+importVat?[line('tax',0n,extra+importVat,'原采购关联烟叶税/关税/反补贴及进口VAT')]:[])];
          journal({...r,sourceRefs}, 'purchase', entries, '验收购入存货；可抵扣进项与成本分离，原采购关联烟叶税/关税进入批次成本；FIFO保留原始批次'); payables.set(r.id, r.settlement === 'paid' ? 0n : gross); break;
        }
        case 'sale': {
          requireValue(r.delivered === true && r.collectionRight === true && ['paid', 'unpaid', 'platform'].includes(r.settlement), 'agency_sale_performance_missing');
          requireValue(Array.isArray(r.lines) && r.lines.length > 0 && r.principal === true, 'agency_sale_lines_or_principal_missing');
          let net = 0n, tax = 0n, cost = 0n; const items = [];
          for (const l of r.lines) {
            const q = positive(quantity(l.quantity), 'agency_quantity_zero'), originalPrice = splitAgencyOriginalPrice({ entity, category: l.vatCategory, originalUnitPrice: l.unitPrice, units: l.quantity, priceIncludesVat: l.priceIncludesVat, date: r.date, invoiceKind: r.invoiceKind, vatReliefWaived: r.vatReliefWaived }), n = cents(originalPrice.net), t = cents(originalPrice.tax);
            let consumed = { cost: 0n, allocations: [], quantity: q };
            if (l.itemId) consumed = consume({ itemId: l.itemId, quantity: l.quantity }, 'inventory');
            net += n; tax += t; cost += consumed.cost; items.push({ ...l, net: money(n), tax: money(t), quantityUnits: q.toString(), cost: money(consumed.cost), allocations: consumed.allocations, returnedQuantity: '0' });
            vatTransactions.push({ factId: r.id, date: r.vatTriggerDate ?? r.date, net: money(n), tax: money(t), category: l.vatCategory, invoiceKind: r.invoiceKind, sourceRefs: r.sourceRefs });
          }
          if (r.invoiceGross !== undefined) requireValue(cents(r.invoiceGross) === net + tax, 'agency_invoice_computation_mismatch');
          journal(r, 'revenue', [line(r.settlement === 'paid' ? 'bank' : 'receivable', net + tax, 0n), line('mainRevenue', 0n, net), ...(tax ? [line('tax', 0n, tax, '应交增值税—销项/简易计税')] : [])], '按履约交付事实确认收入；平台净到账不冲减销售额');
          if (cost) journal(r, 'cost', [line('mainCost', cost, 0n), line('inventory', 0n, cost)], '按出库数量逐层FIFO结转销售成本');
          sales.set(r.id, { id: r.id, net, tax, items, settlement: r.settlement, received: r.settlement === 'paid' ? net + tax : 0n, sourceRefs: r.sourceRefs }); receivables.set(r.id, r.settlement === 'paid' ? 0n : net + tax); break;
        }
        case 'sale_return': {
          const original = sales.get(r.originalSaleId); requireValue(original && r.goodsReceived === true && r.originalInvoiceVerified === true, 'agency_return_original_missing');
          requireValue(Array.isArray(r.lines) && r.lines.length, 'agency_return_lines_missing'); let net = 0n, tax = 0n, cost = 0n;
          requireValue(['refunded', 'receivable_reduction'].includes(r.settlement), 'agency_return_settlement_missing');
          // 整笔先在副本上验证，坏的后续行、结算方式或超应收不能污染库存/VAT/已退数量。
          const stagedItems=clone(original.items),pendingReceipts=[],pendingVat=[],pendingTrace=[];
          for (const l of r.lines) {
            const originalLine = stagedItems[l.originalLine]; requireValue(originalLine, 'agency_return_line_invalid');
            const q = positive(quantity(l.quantity), 'agency_quantity_zero'), oldReturned = BigInt(originalLine.returnedQuantity), originalQ = BigInt(originalLine.quantityUnits);
            requireValue(oldReturned + q <= originalQ, 'agency_return_quantity_exceeded');
            const part = field => roundRatio(cents(originalLine[field]) * (oldReturned + q), originalQ) - roundRatio(cents(originalLine[field]) * oldReturned, originalQ);
            const n=part('net'),t=part('tax'),mode=l.originalPurchaseId===undefined?'sale_line_proportion':'identified_purchase_lot';
            requireValue(!originalLine.returnCostMode||originalLine.returnCostMode===mode,'agency_return_cost_basis_conflict');
            let c=0n;const restored=[];
            if(mode==='identified_purchase_lot'){
              requireValue(typeof l.originalPurchaseId==='string'&&l.originalPurchaseId.length>0,'agency_return_purchase_reference_invalid');
              const selected=originalLine.allocations.filter(a=>a.sourceFactId===l.originalPurchaseId);
              requireValue(selected.length>0,'agency_return_purchase_not_in_original_sale');
              requireValue(selected.reduce((s,a)=>s+BigInt(a.quantity)-BigInt(a.returnedQuantity??'0'),0n)>=q,'agency_return_purchase_quantity_exceeded');
              let left=q;
              for(const a of selected){if(!left)break;const originalQuantity=BigInt(a.quantity),already=BigInt(a.returnedQuantity??'0'),available=originalQuantity-already,taken=left<available?left:available;
                if(!taken)continue;
                const restoredCost=roundRatio(cents(a.cost)*(already+taken),originalQuantity)-roundRatio(cents(a.cost)*already,originalQuantity);
                c+=restoredCost;a.returnedQuantity=(already+taken).toString();left-=taken;
                restored.push({originalPurchaseId:l.originalPurchaseId,quantityUnits:taken.toString(),cost:money(restoredCost),sourceRefs:clone(a.sourceRefs)});
              }
            }else c=part('cost');
            originalLine.returnCostMode=mode;net+=n;tax+=t;cost+=c;originalLine.returnedQuantity=(oldReturned+q).toString();
            if(originalLine.itemId)pendingReceipts.push({record:{id:r.id,itemId:originalLine.itemId,...(mode==='identified_purchase_lot'?{originFactId:l.originalPurchaseId}:{})},quantity:q,cost:c});
            pendingTrace.push({factId:r.id,originalSaleId:r.originalSaleId,originalLine:l.originalLine,mode,quantityUnits:q.toString(),cost:money(c),allocations:restored,sourceRefs:clone(r.sourceRefs)});
            pendingVat.push({factId:r.id,date:r.date,net:money(-n),tax:money(-t),invoiceKind:r.invoiceKind,category:originalLine.vatCategory,sourceRefs:r.sourceRefs});
          }
          const open=receivables.get(r.originalSaleId)??original.net+original.tax-original.received;
          if(r.settlement==='receivable_reduction')requireValue(open>=net+tax,'agency_return_exceeds_open_receivable');
          journal(r, 'return', [line('mainRevenue', net, 0n), ...(tax ? [line('tax', tax, 0n, '红字发票对应VAT')] : []), line(r.settlement === 'refunded' ? 'bank' : 'receivable', 0n, net + tax)], '销售退回关联原交付/原票，收入及税额冲回保留历史');
          if (r.settlement === 'receivable_reduction')receivables.set(r.originalSaleId,open-net-tax);
          if (cost) journal(r, 'return_cost', [line('inventory', cost, 0n), line('mainCost', 0n, cost)], '退货验收入库按原出库成本恢复，不按当前采购价');
          original.items=stagedItems;
          for(const row of pendingReceipts)receive(row.record,row.quantity,row.cost,'inventory',[...r.sourceRefs,...original.sourceRefs]);
          returnCostTrace.push(...pendingTrace);vatTransactions.push(...pendingVat);
          break;
        }
        case 'platform_settlement': {
          requireValue(Array.isArray(r.saleIds) && r.saleIds.length && new Set(r.saleIds).size === r.saleIds.length && r.saleIds.every(id => sales.has(id) && sales.get(id).settlement === 'platform'), 'agency_platform_orders_missing');
          const orderGross = r.saleIds.reduce((n, id) => n + sales.get(id).net + sales.get(id).tax, 0n); const gross = cents(r.orderReceipts), refunds = cents(r.refunds), fee = cents(r.platformFee), paid = cents(r.netPaid); requireValue(gross === orderGross && gross - refunds - fee === paid && paid >= 0n, 'agency_platform_reconciliation_difference');
          requireValue(r.saleIds.every(id => sales.get(id).received === 0n), 'agency_platform_order_already_settled');
          const returnFacts = currentRows.filter(x => r.returnIds?.includes(x.id));
          requireValue(refunds === 0n || Array.isArray(r.returnIds) && r.returnIds.length > 0 && new Set(r.returnIds).size === r.returnIds.length && returnFacts.length === r.returnIds.length && returnFacts.every(x => x.type === 'sale_return' && r.saleIds.includes(x.originalSaleId) && x.settlement === 'receivable_reduction') && vouchers.filter(v => r.returnIds.includes(v.factId) && v.sourceVoucherId && v.summary.startsWith('销售退回')).reduce((n, v) => n + total(v.entries, 'credit'), 0n) === refunds, 'agency_platform_refund_missing');
          journal(r, 'platform', [...(paid ? [line('bank', paid, 0n)] : []), ...(fee ? [line('salesExpense', fee, 0n)] : []), line('receivable', 0n, gross - refunds)], '平台订单/退货/费用/净到账逐项核对，费用单独列支'); r.saleIds.forEach(id => { sales.get(id).received = sales.get(id).net + sales.get(id).tax; receivables.set(id, 0n); }); break;
        }
        case 'expense': {
          requireValue(['admin', 'sales', 'service', 'transport', 'production', 'contract', 'rental'].includes(r.use) && ['paid', 'unpaid'].includes(r.settlement), 'agency_expense_use_missing');
          const gross = positive(cents(r.gross), 'agency_expense_nonpositive'), tax = cents(r.invoiceTax), net = cents(r.net); requireValue(net + tax === gross && ['deductible', 'non_deductible'].includes(r.inputVatTreatment), 'agency_expense_invoice_invalid');
          requireValue(r.benefitPeriod === r.date.slice(0, 7), 'agency_expense_benefit_period_uncovered');
          const deductible = entity.vatStatus === 'general' && r.inputVatTreatment === 'deductible', cost = deductible ? net : gross;
          const role = r.use === 'admin' ? 'adminExpense' : r.use === 'sales' ? 'salesExpense' : ['production', 'contract'].includes(r.use) ? 'productionCost' : 'mainCost';
          journal(r, 'expense', [line(role, cost, 0n), ...(deductible && tax ? [line('tax', tax, 0n, '应交增值税—进项税额')] : []), line(r.settlement === 'paid' ? 'bank' : 'payable', 0n, gross)], '按实际用途/受益期间归集原始费用，生产及履约成本进入任务成本池');
          payables.set(r.id, r.settlement === 'paid' ? 0n : gross);
          if (['production', 'contract'].includes(r.use)) carryJob(r, cost, r.use, r.costElement); break;
        }
        case 'material_issue': {
          requireValue(['kitchen', 'production', 'contract'].includes(r.purpose), 'agency_issue_purpose_missing'); const consumed = consume(r, 'raw');
          journal(r, 'issue', [line(r.purpose === 'kitchen' ? 'mainCost' : 'productionCost', consumed.cost, 0n), line('raw', 0n, consumed.cost)], r.purpose === 'kitchen' ? '餐饮按实际领耗FIFO归集食材成本；盘点差异单列待查' : '制造/工程按领料单数量归集任务成本，保留原始采购批次');
          if (r.purpose !== 'kitchen') carryJob(r, consumed.cost, r.purpose, 'material'); break;
        }
        case 'production_complete': {
          const j = job(r.jobId); const finished = positive(quantity(r.completedQuantity), 'agency_finished_quantity_missing'), wip = quantity(r.wipQuantity); requireValue(r.method === 'equivalent_units' && r.wipCompletionByElement && typeof r.wipCompletionByElement === 'object', 'agency_wip_method_uncovered');
          let finishedCost = 0n; const allocation = {};
          for (const element of ['material', 'labor', 'overhead']) { const completion = quantity(r.wipCompletionByElement[element]); requireValue(completion <= 1000000n, 'agency_wip_completion_invalid'); const equivalent = roundRatio(wip * completion, 1000000n), allocated = roundRatio(j.elements[element] * finished, finished + equivalent); allocation[element] = money(allocated); finishedCost += allocated; j.elements[element] -= allocated; }
          requireValue(finishedCost > 0n, 'agency_production_cost_missing');
          receive(r, finished, finishedCost, 'inventory', [...r.sourceRefs, ...j.sourceRefs]);
          journal(r, 'finished', [line('inventory', finishedCost, 0n), line('productionCost', 0n, finishedCost)], '完工数量与在产约当量分配已归集直接材料/人工/制造费用，余成本留在产'); j.cost -= finishedCost; break;
        }
        case 'service_complete': case 'transport_complete': case 'property_service_complete': {
          requireValue(r.accepted === true && r.collectionRight === true && Array.isArray(r.work), 'agency_service_acceptance_missing');
          const category = r.type === 'transport_complete' ? 'transport' : r.type === 'property_service_complete' ? 'property_management' : 'service';
          let net = 0n, tax = 0n; for (const w of r.work) { const price = splitAgencyOriginalPrice({ entity, category, originalUnitPrice: w.unitPrice, units: w.units, priceIncludesVat: w.priceIncludesVat, date: r.date, invoiceKind: r.invoiceKind, vatReliefWaived: r.vatReliefWaived }); net += cents(price.net); tax += cents(price.tax); }
          journal(r, 'service', [line(r.settlement === 'paid' ? 'bank' : 'receivable', net + tax, 0n), line('mainRevenue', 0n, net), ...(tax ? [line('tax', 0n, tax)] : [])], r.type === 'transport_complete' ? '运单交付签收数量×合同运价确认运输收入；燃油路费人工按运单用途归集' : '验收工时/服务数量×合同单价确认服务收入'); vatTransactions.push({ factId: r.id, date: r.date, net: money(net), tax: money(tax), category, invoiceKind: r.invoiceKind, sourceRefs: r.sourceRefs }); receivables.set(r.id, r.settlement === 'paid' ? 0n : net + tax); break;
        }
        case 'construction_progress': {
          requireValue(r.progressMethod === 'surveyed_units' && r.surveyAccepted === true && r.variableConsideration === false && r.financingComponent === false, 'agency_construction_contract_complexity_uncovered');
          const completed = quantity(r.completedUnits), all = positive(quantity(r.totalUnits), 'agency_contract_units_missing'); requireValue(completed <= all, 'agency_contract_progress_invalid');
          const contract = contracts.get(r.contractId) ?? { revenue: 0n, billed: 0n, sourceRefs: [] };
          let cumulative;
          if (enterprise) { requireValue(r.customerControlsAsset === true || r.noAlternativeUse === true && r.enforceablePaymentRight === true, 'agency_over_time_conditions_missing'); cumulative = roundRatio(cents(r.contractPriceExcludingVat) * completed, all); }
          else {
            requireValue(entity.profileId === 'small-2011-basic-v1' && r.contractStartDate && r.expectedCompletionDate && r.collectionRight === true, 'agency_small_construction_contract_dates_missing');
            validateDate(r.contractStartDate); validateDate(r.expectedCompletionDate);
            if (completed < all && r.date.slice(0,4)===r.contractStartDate.slice(0,4)&&r.date.slice(5)!=='12-31'&&r.expectedCompletionDate.slice(0, 4) === r.contractStartDate.slice(0, 4)) { contract.sourceRefs.push(...r.sourceRefs); contract.recognition = 'same_year_unfinished_deferred_until_completed'; contracts.set(r.contractId, contract); break; }
            if (completed < all) requireValue(r.date.slice(5) === '12-31' && r.costRecoveryAssured === true && Array.isArray(r.estimatedResources), 'agency_small_cross_year_progress_evidence_required');
            cumulative = completed === all ? cents(r.contractPriceExcludingVat) : roundRatio(cents(r.contractPriceExcludingVat) * completed, all);
          }
          requireValue(cumulative >= contract.revenue, 'agency_contract_progress_decreased'); const revenue = cumulative - contract.revenue;
          const j = job(r.jobId, 'contract');
          const advanceAvailable = contract.billed > contract.revenue ? contract.billed - contract.revenue : 0n, advanceRelease = revenue < advanceAvailable ? revenue : advanceAvailable;
          if (revenue) journal(r, 'performance', [...(advanceRelease ? [line('advance', advanceRelease, 0n)] : []), ...(revenue > advanceRelease ? [line(enterprise ? '1151' : 'receivable', revenue - advanceRelease, 0n)] : []), line('mainRevenue', 0n, revenue)], enterprise ? '符合时段履约条件，按签认工程量/总量计量履约进度；先释放已结算预收，余列合同资产' : '小企按第63条区分同年完成与跨年劳务；同年完成取得收款权确认，跨年在年度日按已核进度确认');
          let consumedCost = j.cost - j.futureCost;
          if (!enterprise && completed < all) { const estimated = r.estimatedResources.reduce((n, x) => n + roundRatio(quantity(x.units) * cents(x.unitPrice), 1000000n), 0n), costToDate = roundRatio(estimated * completed, all), previously = contract.recognizedCost ?? 0n; requireValue(costToDate >= previously && costToDate - previously <= consumedCost, 'agency_small_estimated_cost_accrual_gap'); consumedCost = costToDate - previously; contract.recognizedCost = costToDate; }
          if (consumedCost) { journal(r, 'contract_cost', [line('mainCost', consumedCost, 0n), line('productionCost', 0n, consumedCost)], '本次履约已消耗且可收回的材料人工结转；未来资源留在履约成本池'); j.cost -= consumedCost; }
          contract.revenue = cumulative; contract.sourceRefs.push(...r.sourceRefs); contracts.set(r.contractId, contract); break;
        }
        case 'construction_billing': {
          const c = contracts.get(r.contractId); requireValue(c && r.unconditionalRight === true && typeof r.crossRegion === 'boolean', 'agency_construction_billing_unverified'); const net = cents(r.invoiceNet), tax = cents(r.invoiceTax); requireValue(net > 0n, 'agency_construction_invoice_invalid'); const computed = calculateAgencyOutputVat({ entity, category: 'construction', net: r.invoiceNet, date: r.date, invoiceKind: r.invoiceKind, vatReliefWaived: r.vatReliefWaived }); requireValue(cents(computed.tax) === tax, 'agency_invoice_computation_mismatch');
          const earnedUnbilled = c.revenue > c.billed ? c.revenue - c.billed : 0n, assetRelease = net < earnedUnbilled ? net : earnedUnbilled;
          journal(r, 'billing', [line('receivable', net + tax, 0n), ...(assetRelease ? [line(enterprise ? '1151' : 'receivable', 0n, assetRelease)] : []), ...(net > assetRelease ? [line('advance', 0n, net - assetRelease)] : []), ...(tax ? [line('tax', 0n, tax)] : [])], '工程结算无条件收款权转应收；已赚取部分释放合同资产/应收，超额部分列预收，不提前确认收入'); c.billed += net; receivables.set(r.id, net + tax); vatTransactions.push({ factId: r.id, date: r.date, net: r.invoiceNet, tax: r.invoiceTax, category: 'construction', invoiceKind: r.invoiceKind, sourceRefs: r.sourceRefs }); break;
        }
        case 'rental': {
          requireValue(r.role === 'lessor' && r.classification === 'operating' && ['movable', 'real_estate'].includes(r.assetKind) && typeof r.crossRegion === 'boolean', 'agency_lease_classification_or_real_estate_rule_unverified');
          const start = validateDate(r.startDate), end = validateDate(r.endDate); requireValue(start <= end && Number.isSafeInteger(r.rentFreeDays) && r.rentFreeDays >= 0 && r.variableRent === false && Array.isArray(r.collectionSchedule) && r.collectionSchedule.length > 0, 'agency_lease_complexity_uncovered');
          const category = r.assetKind === 'real_estate' ? 'real_estate_lease' : 'movable_lease';
          const contractPrice = calculateAgencyRentalPrice({entity,lease:r,amount:r.totalContractRent,priceIncludesVat:r.priceIncludesVat,date:start,invoiceKind:r.invoiceKind});
          const schedule = r.collectionSchedule.map(s => { validateDate(s.dueDate); return { ...s, ...calculateAgencyRentalPrice({entity,lease:r,amount:s.amount,priceIncludesVat:s.priceIncludesVat,date:s.dueDate,invoiceKind:s.invoiceKind}) }; });
          requireValue(schedule.reduce((n, s) => n + cents(s.net), 0n) === cents(contractPrice.net), 'agency_lease_schedule_contract_mismatch');
          if(entity.kind==='individual_business'&&cents(contractPrice.relief)>0n){for(const s of schedule.filter(s=>s.dueDate.slice(0,7)<=scope.period))vatTransactions.push({factId:r.id,date:s.dueDate,net:s.net,tax:s.tax,category,invoiceKind:s.invoiceKind,simplifiedMethod:true,sourceRefs:r.sourceRefs});issue(r,'agency_individual_housing_relief_posting_review','个人住房3%计销售额/1.5%实税及差额已正确算，个体专项会计差额需会计核对法源；未将实际税额伪作gross-net，不擅自入账');break;}
          const days = BigInt((Date.parse(end) - Date.parse(start)) / 86400000 + 1), firstMonth = start.slice(0, 7), lastMonth = end.slice(0, 7) < scope.period ? end.slice(0, 7) : scope.period;
          let earnedBefore = 0n, billedBefore = 0n, taxBefore = 0n, reliefBefore=0n,assetBefore = 0n, advanceBefore = 0n;
          for (let month = firstMonth; month <= lastMonth; ) {
            const monthEnd = dayInMonth(month), to = end < monthEnd ? end : monthEnd, elapsed = BigInt((Date.parse(to) - Date.parse(start)) / 86400000 + 1), earned = roundRatio(cents(contractPrice.net) * elapsed, days), billed = schedule.filter(s => s.dueDate <= to).reduce((n, s) => n + cents(s.net), 0n), vat = schedule.filter(s => s.dueDate <= to).reduce((n, s) => n + cents(s.tax), 0n), relief=schedule.filter(s=>s.dueDate<=to).reduce((n,s)=>n+cents(s.relief),0n),asset = (earned > billed ? earned : billed) + vat + relief, advance = billed > earned ? billed - earned : 0n;
            const revenue = earned - earnedBefore, tax = vat - taxBefore, reliefChange=relief-reliefBefore,assetChange = asset - assetBefore, advanceChange = advance - advanceBefore;
            const entries = [...(assetChange > 0n ? [line('receivable', assetChange, 0n)] : assetChange < 0n ? [line('receivable', 0n, -assetChange)] : []), ...(advanceChange > 0n ? [line('advance', 0n, advanceChange)] : advanceChange < 0n ? [line('advance', -advanceChange, 0n)] : []), ...(revenue ? [line('mainRevenue', 0n, revenue)] : []), ...(tax ? [line('tax', 0n, tax)] : []),...(reliefChange?[line(enterprise?'6117':'5301',0n,reliefChange)]:[])];
            if (entries.length) journal({ ...r, date: to }, `rent:${month}`, entries, '经营出租按完整合同含免租期直线确认；租金约定应收/先开票时点另算VAT，预收未赚取部分列负债');
            for (const s of schedule.filter(s => s.dueDate.slice(0, 7) === month)) vatTransactions.push({ factId: r.id, date: s.dueDate, net: s.net, tax: s.tax, category, invoiceKind: s.invoiceKind,simplifiedMethod:s.simplifiedMethod, sourceRefs: r.sourceRefs });
            earnedBefore = earned; billedBefore = billed; taxBefore = vat; reliefBefore=relief;assetBefore = asset; advanceBefore = advance;
            const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 1)); month = next.toISOString().slice(0, 7);
          }
          receivables.set(r.id, assetBefore); break;
        }
        case 'lease_lessee': {
          requireValue(enterprise && r.shortTermElection === false && r.lowValueElection === false && r.variablePayments === false && r.modification === false && r.impairmentIndicator === false, 'agency_lessee_conditions_unverified');
          const start = validateDate(r.assetAvailableDate); requireValue(start.endsWith('-01') && Array.isArray(r.paymentSchedule) && r.paymentSchedule.length > 0 && Number.isSafeInteger(r.monthlyDiscountBasisPoints) && r.monthlyDiscountBasisPoints >= 0 && r.monthlyDiscountBasisPoints <= 10000 && r.discountEvidenceVerified === true, 'agency_lease_discount_or_schedule_missing');
          requireValue(['initialDirectCosts', 'prepaidRent', 'restorationPresentValue', 'leaseIncentives'].every(k => Object.hasOwn(r, k) && cents(r[k]) === 0n), 'agency_lease_initial_cost_components_need_rule');
          requireValue(['deductible', 'non_deductible'].includes(r.inputVatTreatment) && Number.isSafeInteger(r.assetUsefulLifeMonths) && r.assetUsefulLifeMonths > 0 && typeof r.ownershipTransfers === 'boolean', 'agency_lease_deduction_or_useful_life_missing');
          const category = r.assetKind === 'real_estate' ? 'real_estate_lease' : 'movable_lease', vendor = { ...entity, vatStatus: r.vendorVatStatus, vatReliefWaived: r.vendorVatReliefWaived };
          const deductible = entity.vatStatus === 'general' && r.inputVatTreatment === 'deductible';
          const schedule = r.paymentSchedule.map((s, index) => {
            const expectedMonth = new Date(Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1 + index, 1)).toISOString().slice(0, 7);
            requireValue(s.dueDate === dayInMonth(expectedMonth) && typeof s.actuallyPaid === 'boolean', 'agency_lease_monthly_schedule_invalid');
            const price = splitAgencyOriginalPrice({ entity: vendor, category, originalUnitPrice: s.amount, units: '1', priceIncludesVat: s.priceIncludesVat, date: s.dueDate, invoiceKind: s.invoiceKind, vatReliefWaived: s.vatReliefWaived ?? r.vatReliefWaived });
            if (s.actuallyPaid) requireValue(typeof s.paymentReference === 'string' && s.paymentReference.length > 0 && cents(s.actualPaid) === cents(price.gross), 'agency_lease_payment_original_missing');
            return { ...s, ...price, liabilityPayment: deductible ? cents(price.net) : cents(price.gross) };
          });
          const count = schedule.length, rate = BigInt(r.monthlyDiscountBasisPoints), factor = 10000n + rate;
          const denominator = factor ** BigInt(count), numerator = schedule.reduce((n, s, index) => n + s.liabilityPayment * 10000n ** BigInt(index + 1) * factor ** BigInt(count - index - 1), 0n), pv = roundRatio(numerator, denominator);
          requireValue(pv > 0n, 'agency_lease_value_invalid'); journal({ ...r, date: start }, 'lease_initial', [line('1621', pv, 0n), line('2801', 0n, pv)], '新租赁准则：实际可供使用日按未付租金现值确认使用权资产及租赁负债，不套出租人直线收入');
          let liability = pv, classifiedCurrent = 0n; const depreciationMonths = r.ownershipTransfers ? r.assetUsefulLifeMonths : Math.min(r.assetUsefulLifeMonths, count);
          for (let index = 0; index < count; index++) {
            const s = schedule[index], month = s.dueDate.slice(0, 7); if (month > scope.period) break;
            const interest = roundRatio(liability * rate, 10000n);
            if (interest) journal({ ...r, date: s.dueDate }, `lease_interest:${month}`, [line('6603', interest, 0n), line('2801', 0n, interest)], '按已核折现率及期初租赁负债确定本月利息');
            liability += interest;
            if (s.actuallyPaid) {
              if (deductible) requireValue(s.invoiceCertified === true && cents(s.invoiceTax) === cents(s.tax), 'agency_lease_input_invoice_unverified');
              const amount = s.liabilityPayment; requireValue(amount <= liability + 1n, 'agency_lease_payment_exceeds_liability');
              const adjustment = index === count - 1 ? liability - amount : 0n;
              const entries = [line('2801', liability < amount ? liability : amount, 0n), ...(deductible && cents(s.tax) ? [line('tax', cents(s.tax), 0n, '已认证租赁进项税额')] : []), line('bank', 0n, cents(s.gross))];
              if (adjustment < 0n) entries.push(line('6603', -adjustment, 0n));
              journal({ ...r, date: s.dueDate }, `lease_payment:${month}`, entries, '按实际银行付款核销租赁负债；可抵扣进项须当期发票认证原件'); liability -= amount; if (liability < 0n) liability = 0n;
              if (index === count - 1 && liability > 0n) { requireValue(liability <= 1n, 'agency_lease_terminal_rounding_excess'); journal({ ...r, date: s.dueDate }, `lease_rounding:${month}`, [line('2801', liability, 0n), line('6603', 0n, liability)], '租赁末期不超过一分的现值/分期舍入尾差冲回利息'); liability = 0n; }
            }
            let forecast = liability, nextPrincipal = 0n;
            for (let f = index + 1; f < Math.min(count, index + 13); f++) { const futureInterest = roundRatio(forecast * rate, 10000n), principal = schedule[f].liabilityPayment > futureInterest ? schedule[f].liabilityPayment - futureInterest : 0n; nextPrincipal += principal; forecast += futureInterest - schedule[f].liabilityPayment; }
            if (nextPrincipal > liability) nextPrincipal = liability;
            const classify = nextPrincipal - classifiedCurrent; if (classify) journal({ ...r, date: s.dueDate }, `lease_current:${month}`, classify > 0n ? [line('2801', classify, 0n), line('2802', 0n, classify)] : [line('2802', -classify, 0n), line('2801', 0n, -classify)], '按未来12个月应偿还本金重分类一年内到期租赁负债，保持总负债不变'); classifiedCurrent = nextPrincipal;
          }
          const events=[];
          for(let index=0;index<depreciationMonths;index++){
            const month=new Date(Date.UTC(Number(start.slice(0,4)),Number(start.slice(5,7))-1+index,1)).toISOString().slice(0,7);if(month>scope.period)break;
            const depreciation=roundRatio(pv*BigInt(index+1),BigInt(depreciationMonths))-roundRatio(pv*BigInt(index),BigInt(depreciationMonths));if(!depreciation)continue;
            if(r.use==='production'){
              const rows=(r.productionAllocations??[]).filter(a=>a.period===month);
              requireValue(r.productionAllocationEvidenceVerified===true&&rows.length>0&&new Set(rows.map(a=>stable([a.jobId,a.allocationDate]))).size===rows.length,'agency_lease_production_allocation_missing');
              for(const a of rows)requireValue(a.jobId&&validateDate(a.allocationDate).slice(0,7)===month&&a.allocationDate>=r.date&&quantity(a.machineHours)>0n,'agency_lease_production_driver_invalid');
              const hours=rows.reduce((n,a)=>n+quantity(a.machineHours),0n);let cumulativeHours=0n,allocated=0n;
              for(const [part,a] of rows.entries()){cumulativeHours+=quantity(a.machineHours);const target=roundRatio(depreciation*cumulativeHours,hours),amount=target-allocated;allocated=target;if(!amount)continue;const event={...r,id:`${r.id}/depreciation/${month}/${part}`,type:'agency_lease_depreciation',date:a.allocationDate,sequence:a.sequence??-1,jobId:a.jobId,depreciation:money(amount),depreciationSuffix:`lease_depreciation:${month}:${part}`};derivedLeaseEvents.add(event);events.push(event);}
            }else{const event={...r,id:`${r.id}/depreciation/${month}`,type:'agency_lease_depreciation',date:dayInMonth(month),depreciation:money(depreciation),depreciationSuffix:`lease_depreciation:${month}`};derivedLeaseEvents.add(event);events.push(event);}
          }
          const pending=[...workQueue.slice(cursor+1),...events].sort((a,b)=>a.date.localeCompare(b.date)||(a.sequence??0)-(b.sequence??0)||a.id.localeCompare(b.id));workQueue.splice(cursor+1,workQueue.length-cursor-1,...pending);
          break;
        }
        case 'agency_lease_depreciation':{
          requireValue(derivedLeaseEvents.has(r),'agency_derived_lease_event_untrusted');const depreciation=cents(r.depreciation);
          journal(r,r.depreciationSuffix,[line(r.use==='production'?'productionCost':r.use==='transport'?'mainCost':'adminExpense',depreciation,0n),line('1622',0n,depreciation)],'使用权资产折旧独立于付款期，所有权确定转移按使用寿命持续计提；生产用途按原机时/任务归集');
          if(r.use==='production')carryJob(r,depreciation,'production','overhead');
          break;
        }
        case 'deposit': {
          requireValue(['received', 'refunded'].includes(r.direction) && r.refundable === true, 'agency_deposit_terms_missing'); const amount = positive(cents(r.amount), 'agency_deposit_amount_invalid'); journal(r, 'deposit', r.direction === 'received' ? [line('bank', amount, 0n), line('otherPayable', 0n, amount)] : [line('otherPayable', amount, 0n), line('bank', 0n, amount)], '可退押金单列负债，收款不自动确认为租赁收入'); break;
        }
        case 'owner_capital': {
          requireValue(individual && ['contribution', 'withdrawal', 'personal_expense'].includes(r.direction), 'agency_owner_capital_scope_invalid'); const amount = positive(cents(r.amount), 'agency_owner_amount_invalid');
          journal(r, 'owner_capital', r.direction === 'contribution' ? [line('bank', amount, 0n), line('capital', 0n, amount)] : [line('capital', amount, 0n), line('bank', 0n, amount)], '个体业主投入/提款及个人家庭支出直接列业主投资，不混入经营费用及税前扣除'); break;
        }
        case 'collection': case 'supplier_payment': {
          requireValue(typeof r.relatedFactId === 'string' && typeof r.bankAccountId === 'string' && typeof r.bankReference === 'string' && r.bankReference.length > 0, 'agency_settlement_source_missing');
          const cashKey = stable([r.bankAccountId, r.bankReference]); requireValue(!cashIdentities.has(cashKey), 'agency_cash_movement_already_allocated');
          const source = currentRows.find(x => x.id === r.relatedFactId && x.date <= r.date), amounts = r.type === 'collection' ? receivables : payables;
          requireValue(source && (r.type === 'collection' ? ['sale', 'service_complete', 'transport_complete', 'property_service_complete', 'construction_billing', 'rental','property_disposal'].includes(source.type) || source.type === 'opening_balance' && source.accountCode === '1122' : ['purchase', 'expense','vehicle_acquisition','property_acquisition'].includes(source.type) || source.type === 'opening_balance' && source.accountCode === '2202'), 'agency_settlement_wrong_business_kind');
          const amount = positive(cents(r.amount), 'agency_settlement_amount_invalid'), outstanding = amounts.get(r.relatedFactId); requireValue(outstanding !== undefined && outstanding >= amount, 'agency_settlement_exceeds_open_balance');
          journal(r, 'settlement', r.type === 'collection' ? [line('bank', amount, 0n), line('receivable', 0n, amount)] : [line('payable', amount, 0n), line('bank', 0n, amount)], '原始银行账户/流水唯一核销对应应收应付剩余余额，不以相关ID存在就重复收付'); amounts.set(r.relatedFactId, outstanding - amount); cashIdentities.add(cashKey); break;
        }
        case 'payroll': {
          requireValue(Array.isArray(r.components) && r.components.length && ['admin', 'production', 'transport', 'service', 'contract'].includes(r.use), 'agency_payroll_components_missing');
          const gross = total(r.components, 'amount'); requireValue(gross >= 0n, 'agency_payroll_amount_invalid'); const role = ['production', 'contract'].includes(r.use) ? 'productionCost' : r.use === 'admin' ? 'adminExpense' : 'mainCost';
          if (gross) journal(r, 'salary_accrual', [line(role, gross, 0n), line('wages', 0n, gross)], '按考勤/工资原始组成计提人工，生产/工程按工时任务归集'); if (['production', 'contract'].includes(r.use)) carryJob(r, gross, r.use, 'labor');
          const noticeRows=officialContributions.calculations.filter(c=>c.employeeId===r.employeeId&&c.assessmentPeriod===r.date.slice(0,7)),employer=noticeRows.reduce((n,c)=>n+cents(c.employer),0n);
          if(employer){journal({...r,sourceRefs:[...r.sourceRefs,...noticeRows.flatMap(n=>n.sourceRefs)]},'official_employer_contribution',[line(role,employer,0n),line('wages',0n,employer)],'按官方核定通知逐人逐险种汇总单位负担，按实际受益岗位计入费用/产品/工程成本；不伪称地方费率已核');if(['production','contract'].includes(r.use))carryJob(r,employer,r.use,'labor');}
          const union=unionByFact.get(r.id),unionAmount=union?cents(union.due):0n;if(unionAmount){journal({...r,sourceRefs:union.sourceRefs},'union_accrual',[line(role,unionAmount,0n),line('wages',0n,unionAmount)],'已建会按原工资组成及已核劳动受益期2%预提，实际拨缴基数另按真实工资支付月核对；不以银行支付日倒灌费用');if(['production','contract'].includes(r.use))carryJob(r,unionAmount,r.use,'overhead');}
          if(r.paid===true){const paymentDate=validateDate(r.paymentDate??r.date);requireValue(paymentDate>=r.date,'agency_salary_advance_requires_original_classification');if(paymentDate<=dayInMonth(scope.period)&&!noticeRows.length){const social=cents(r.employeeSocial),housing=cents(r.employeeHousing),tax=cents(r.taxWithheld),paid=cents(r.netPaid);requireValue(gross-social-housing-tax===paid&&paid>=0n,'agency_salary_payment_mismatch');journal({...r,date:paymentDate},'salary_paid',[line('wages',gross,0n),...(paid?[line('bank',0n,paid)]:[]),...(social+housing?[line('otherPayable',0n,social+housing,'代扣个人社保/公积金')]:[]),...(tax?[line('tax',0n,tax,'代扣个人所得税')]:[])],'按实际银行支付日期核销原应付工资；原计提日与所得取得日分开，原扣款不证明法定义务已算完');}}
          break;
        }
        case 'inventory_count': { const s = lots.get(r.itemId), expected = s?.layers.reduce((n, l) => n + l.quantity, 0n) ?? 0n; if (quantity(r.countedQuantity) !== expected) issue(r, 'stocktake_difference', '实盘数量与进销存不符，核损耗/盘亏/漏单原因及批准依据，不自动全作成本'); break; }
        default: issue(r, 'business_fact_uncovered', `原始事实类型${r.type}暂无已核会计处理；保留资料及规则缺口供企业特例/公共规则人工选择`);
      }
    } catch (error) {
      if (!error.code) throw error;
      // 单个无效业务事实不能泄露部分分录或消耗存货层。
      const restore = (target, values) => { target.clear(); for (const [key, value] of values) target.set(key, value); };
      restore(lots, snapshot.lots); restore(jobs, snapshot.jobs); restore(sales, snapshot.sales); restore(contracts, snapshot.contracts); restore(receivables, snapshot.receivables); restore(payables, snapshot.payables); cashIdentities.clear(); snapshot.cashIdentities.forEach(x => cashIdentities.add(x)); restore(balances, snapshot.balances); restore(yearFlows, snapshot.yearFlows); vouchers.length = snapshot.count; vatTransactions.length = snapshot.vat;assetCardDrafts.length=snapshot.assetCards;pendingAssetDisposals.length=snapshot.disposals;
      issue(r, error.code ?? 'agency_business_rule_failure', '补充或核对该原始业务事实及规则适用条件，当前分支未生成分录');
    }
  }
  for(const row of officialContributions.calculations.filter(c=>c.assessmentPeriod>=replayFrom&&c.assessmentPeriod<=scope.period))if(!currentRows.some(r=>r.type==='payroll'&&r.employeeId===row.employeeId&&r.date.slice(0,7)===row.assessmentPeriod))issue(null,'contribution_beneficiary_missing','官方单位缴费需对应原劳动/工资岗位及受益对象归集，缺失不能忽略该成本或默认管理费');
  if(!document.nativeAssetContext)for(const draft of assetCardDrafts)if(draft.card.start_period<=scope.period)issue(null,'agency_core_asset_context_required','需显式只读目标库核core资产卡片及已过账计提；纯原件不把缺折旧当零，不信JSON posted');
  const profileAccounts = profile.coa.map(a => ({ ...a }));
  const amounts = [...balances].map(([code, v]) => { requireValue(v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER), 'agency_report_amount_overflow'); return { code, netMinor: Number(v) }; });
  const flows = [...yearFlows].filter(([code]) => profile.coa.some(a => a.code === code && a.category === '损益')).map(([code, v]) => { requireValue(v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER), 'agency_report_amount_overflow'); return { code, netMinor: Number(v) }; });
  const revenueCodes = new Set([roles.mainRevenue, roles.otherRevenue]);
  const yearRevenue = [...yearFlows].reduce((n, [code, amount]) => n - (revenueCodes.has(code) ? amount : 0n), 0n);
  const profitBeforeTax = flows.filter(a => !['5801', '6801'].includes(a.code)).reduce((n, a) => n - BigInt(a.netMinor), 0n);
  const coverage = records.filter(r => r.type === 'period_coverage'), months = Array.from({ length: Number(scope.period.slice(5)) }, (_, i) => `${scope.period.slice(0, 4)}-${String(i + 1).padStart(2, '0')}`).filter(m => m >= replayFrom);
  const accountingCoverageVerified = months.every(m => coverage.filter(r => r.period === m && r.complete === true && r.accountsCovered === true && r.unbilledSalesCovered === true && r.bankCovered === true).length === 1);
  const taxYearFrom = entity.businessStartDate.slice(0,7) > `${scope.period.slice(0,4)}-01` ? entity.businessStartDate.slice(0,7) : `${scope.period.slice(0,4)}-01`;
  const taxMonths = Array.from({length:Number(scope.period.slice(5))},(_,i)=>`${scope.period.slice(0,4)}-${String(i+1).padStart(2,'0')}`).filter(m=>m>=taxYearFrom);
  const yearCoverageVerified = replayFrom <= taxYearFrom && taxMonths.every(m=>coverage.filter(r=>r.period===m&&r.complete===true&&r.accountsCovered===true&&r.unbilledSalesCovered===true&&r.bankCovered===true).length===1);
  const openingVat = records.find(r => r.type === 'opening_vat');
  return { version: AGENCY_ACCOUNTING_RULE_VERSION, scope, profileId: profile.id, status: issues.length ? 'incomplete' : 'draft', vouchers: vouchers.filter(v => v.period === scope.period), historicalVouchers: vouchers.filter(v => v.period < scope.period), vatTransactions,returnCostTrace,assetCardDrafts,pendingAssetDisposals,issues,
    inventory: [...lots.values()].map(s => ({ itemId: s.itemId, inventoryType: s.inventoryType, quantityUnits: s.layers.reduce((n, l) => n + l.quantity, 0n).toString(), cost: money(s.layers.reduce((n, l) => n + l.cost, 0n)), layers: s.layers.map(l => ({ quantityUnits: l.quantity.toString(), cost: money(l.cost), sourceRefs: l.sourceRefs })) })),
    contractState: [...contracts].map(([id, c]) => ({ contractId: id, revenue: money(c.revenue), billed: money(c.billed), sourceRefs: c.sourceRefs })),
    workInProgress: [...jobs.values()].map(j => ({ jobId: j.id, kind: j.kind, cost: money(j.cost), sourceRefs: j.sourceRefs })),
    replayFrom, yearRevenue: money(yearRevenue), yearProfitBeforeTax: money(profitBeforeTax), yearCoverageVerified, accountingCoverageVerified, openingVatVerified: openingVat?.declarationVerified === true, openingVatCredit: openingVat?.amount ?? null,
    reportDraftInputs: { accounts: profileAccounts, accountRoles:clone(accountCode), amounts, incomeAmounts: flows },
    reports: { balanceSheet: evaluateAccountingStatement(profile.id, { kind: 'balance-sheet', accounts: profileAccounts, amounts }), incomeStatement: evaluateAccountingStatement(profile.id, { kind: 'income-statement', accounts: profileAccounts, amounts: flows }) },
    sources: AGENCY_ACCOUNTING_SOURCES, submittable: false, periodComplete: false, authorizesExecution: false };
}

/** 仅加入程序推导、借贷平衡的规则分录；不接收客户预制分录。 */
export function applyAgencyDerivedJournals(accounting, journals) {
  const result = clone(accounting), profile = getAccountingProfile(result.profileId);
  const amounts = new Map(result.reportDraftInputs.amounts.map(a => [a.code, BigInt(a.netMinor)]));
  const flows = new Map(result.reportDraftInputs.incomeAmounts.map(a => [a.code, BigInt(a.netMinor)]));
  for (const voucher of journals) {
    requireValue(total(voucher.entries, 'debit') === total(voucher.entries, 'credit') && voucher.sourceRefs?.length > 0, 'agency_derived_journal_invalid');
    for (const entry of voucher.entries) {
      const account = profile.coa.find(a => a.code === entry.code); requireValue(account, 'agency_profile_account_missing');
      const delta = cents(entry.debit) - cents(entry.credit); amounts.set(entry.code, (amounts.get(entry.code) ?? 0n) + delta);
      if (voucher.period.slice(0, 4) === result.scope.period.slice(0, 4) && account.category === '损益') flows.set(entry.code, (flows.get(entry.code) ?? 0n) + delta);
    }
    (voucher.period === result.scope.period ? result.vouchers : result.historicalVouchers).push(clone(voucher));
  }
  const mapped = values => [...values].map(([code, value]) => { requireValue(value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER), 'agency_report_amount_overflow'); return { code, netMinor: Number(value) }; });
  result.reportDraftInputs.amounts = mapped(amounts); result.reportDraftInputs.incomeAmounts = mapped(flows);
  result.yearProfitBeforeTax = money([...flows].filter(([code]) => !['5801', '6801'].includes(code)).reduce((n, [, v]) => n - v, 0n));
  result.reports = { balanceSheet: evaluateAccountingStatement(profile.id, { kind: 'balance-sheet', accounts: profile.coa, amounts: result.reportDraftInputs.amounts }), incomeStatement: evaluateAccountingStatement(profile.id, { kind: 'income-statement', accounts: profile.coa, amounts: result.reportDraftInputs.incomeAmounts }) };
  return result;
}

/** 已登记的简易方法采用法定现金账；复式分录仅用于内部核对投影。 */
export function buildAgencyBookkeeping(document, accounting) {
  if(document.entity.kind!=='individual_business')return {method:'double_entry',internalProjection:false};
  const method=document.entity.bookkeepingMethod, rows=[],receipts=[],expenses=[],purchases=[],owners=[],otherCash=[];
  const vouchers=[...accounting.historicalVouchers,...accounting.vouchers].filter(v=>v.period.startsWith(document.scope.period.slice(0,4))), facts=new Map(document.records.map(r=>[r.id,r]));
  let receipt=0n,operating=0n,purchaseCash=0n;
  for(const voucher of vouchers){
    const raw=facts.get(voucher.factId),cash=voucher.entries.filter(e=>['1001','1002'].includes(e.code)).reduce((n,e)=>n+cents(e.debit)-cents(e.credit),0n);if(!cash)continue;
    let category='other_cash';
    if(raw?.type==='owner_capital')category='owner_movement';
    else if(raw?.type==='deposit')category='deposit';
    else if(cash>0n&&['sale','service_complete','transport_complete','property_service_complete','collection','platform_settlement'].includes(raw?.type))category='business_receipt';
    else if(cash<0n&&(raw?.type==='purchase'||raw?.type==='supplier_payment'&&facts.get(raw.relatedFactId)?.type==='purchase'))category='purchase_payment';
    else if(cash<0n&&(raw?.type==='expense'||raw?.type==='supplier_payment'&&facts.get(raw.relatedFactId)?.type==='expense'||raw?.type==='payroll'||voucher.derived?.kind==='payment'&&voucher.derived.obligationId!=='business_income'))category='operating_payment';
    else if(voucher.derived?.kind==='payment'&&voucher.derived.obligationId==='business_income')category='owner_income_tax';
    let income=cash>0n&&category==='business_receipt'?cash:0n,expense=cash<0n&&category==='operating_payment'?-cash:0n;
    // 平台扣款在银行中体现为一次资金变动；现金账分别列出收款总额与代扣费用。
    if(raw?.type==='platform_settlement'){income=cents(raw.orderReceipts)-cents(raw.refunds);expense=cents(raw.platformFee);}
    const row={period:voucher.period,date:voucher.date,category,receipt:money(income),expense:money(expense),purchase:money(category==='purchase_payment'?-cash:0n),actualCashChange:money(cash),sourceVoucherId:voucher.sourceVoucherId,sourceRefs:voucher.sourceRefs};
    rows.push(row);if(income){receipts.push(row);receipt+=income;}if(expense){expenses.push(row);operating+=expense;}if(category==='purchase_payment'){purchases.push(row);purchaseCash-=cash;}if(category.startsWith('owner_'))owners.push(row);else if(['other_cash','deposit'].includes(category))otherCash.push(row);
  }
  const inventoryScope=accounting.inventory.length>0,stocktakeComplete=!inventoryScope||accounting.inventory.every(item=>document.records.some(r=>r.type==='inventory_count'&&r.itemId===item.itemId&&r.date.slice(0,7)===document.scope.period)&&!accounting.issues.some(i=>i.code==='stocktake_difference'));
  const inventories=accounting.inventory.map(item=>({itemId:item.itemId,quantityUnits:item.quantityUnits,cost:item.cost,sourceRefs:item.layers.flatMap(l=>l.sourceRefs)}));
  return {method,legalBasis:'个体工商户建账管理暂行办法第9条',statutoryProduct:method==='simple'?'简易收支账（经营收入/费用/购进/盘点/利润表）':'复式语义账簿内部会计核对底稿',internalProjection:method==='simple',projectionLimitation:method==='simple'?'同一账套复式凭证仅辅助核对，不作为复式制度法定报表；现金收付只记录一次':null,rows,receipts,expenses,purchases,ownerMovements:owners,otherCash,stocktake:{complete:stocktakeComplete,items:inventories},profitStatement:{cashBusinessReceipts:money(receipt),cashOperatingPayments:money(operating),cashPurchasePayments:money(purchaseCash),cashSurplusBeforeInventory:money(receipt-operating-purchaseCash),accrualOperatingProfit:accounting.yearProfitBeforeTax,accrualMinusCashSurplus:money(cents(accounting.yearProfitBeforeTax)-receipt+operating+purchaseCash),status:stocktakeComplete?'cash_book_with_accrual_reconciliation':'stocktake_pending',reason:'收付实现的简易账与查账经营所得权责发生差异分别列示；购进不是自动当期成本，期末盘点/存货成本另核'},accountantApproval:'pending',submittable:false,periodComplete:false};
}

/** 固定顺序：业务 → 非所得税税费/减免 → 所得税；历史月份重放原始事实。 */
export function replayAgencyFinancials(document, { annual = false } = {}) {
  if(annual){
    const taxStart=document.entity.businessStartDate.slice(0,7)>`${document.scope.period.slice(0,4)}-01`?document.entity.businessStartDate.slice(0,7):`${document.scope.period.slice(0,4)}-01`;
    if(document.entity.accountingReplayFrom&&document.entity.accountingReplayFrom>taxStart){
      const startsBefore=document.entity.businessStartDate.slice(0,7)<taxStart, opening=document.records.filter(r=>['opening_balance','opening_inventory'].includes(r.type)&&r.asOfPeriod===taxStart);
      requireValue(!startsBefore||opening.length>0,'agency_tax_year_opening_material_required');
      document={...document,entity:{...document.entity,accountingReplayFrom:taxStart},records:document.records.filter(r=>!['opening_balance','opening_inventory'].includes(r.type)||r.asOfPeriod===taxStart||!r.asOfPeriod&&r.date<`${taxStart}-01`)};
    }
  }
  const replayStart = document.entity.accountingReplayFrom ?? (document.entity.businessStartDate.slice(0,7) < '2026-01' ? '2026-01' : document.entity.businessStartDate.slice(0,7));
  const year = document.scope.period.slice(0, 4), earliest = document.records.filter(r => r.date.slice(0,7) >= replayStart && r.date.slice(0, 7) <= document.scope.period && /^202[67]-/.test(r.date)).map(r => r.date.slice(0, 7)).sort()[0] ?? document.scope.period;
  const startIndex = Number(earliest.slice(0, 4)) * 12 + Number(earliest.slice(5)) - 1, endIndex = Number(year) * 12 + Number(document.scope.period.slice(5)) - 1;
  const journals = [], cumulative = new Map(), unresolvedTaxes=new Map(),periodCalculations = []; let accounting, tax;
  const journalFrom = (row, month, entries = row.entries) => {
    const key = [document.scope.enterpriseKey, document.scope.accountSetId, 'derived-national-tax', row.obligationId, row.kind, month, row.paymentId ?? 'accrual'];
    const result = { sourceVoucherId: `agency:${hash(stable(key))}`, factId: `tax:${row.obligationId}:${row.paymentId ?? month}`, period: month, date: row.date??dayInMonth(month), summary: row.reason, entries, sourceRefs: clone(row.sourceRefs), ruleVersion: AGENCY_ACCOUNTING_RULE_VERSION, derived: { obligationId: row.obligationId, kind: row.kind, cumulative: row.cumulative,...(row.assetFactId?{assetFactId:row.assetFactId}:{}) } };
    result.contentDigest = hash(stable(result)); return result;
  };
  for (let index = startIndex; index <= endIndex; index++) {
    const month = `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`; if (month.endsWith('-01')) {cumulative.clear();unresolvedTaxes.clear();}
    const scope = { ...document.scope, period: month }, raw = evaluateAgencyAccounting({ ...document, scope });
    let withPrior = applyAgencyDerivedJournals(raw, journals);withPrior.unresolvedTaxDependencies=[...unresolvedTaxes.values()];
    const preliminary = calculateAgencyObligations({ scope, entity: document.entity, accounting: withPrior, records: document.records });
    const nonIncome = preliminary.entries.filter(e => !e.cumulative).map(e => journalFrom(e, month));
    for(const d of raw.pendingAssetDisposals.filter(d=>d.period===month||nonIncome.some(v=>v.derived.assetFactId===d.factId))){
      const charges=nonIncome.filter(v=>v.derived.assetFactId===d.factId).reduce((n,v)=>n+v.entries.filter(e=>e.code==='1606').reduce((sum,e)=>sum+cents(e.debit)-cents(e.credit),0n),0n),gain=(d.period===month?cents(d.netProceeds)-cents(d.bookNet):0n)-charges;
      if(gain)nonIncome.push(journalFrom({obligationId:'asset_disposal_result',kind:'asset_disposal_result',paymentId:hash(stable(d.originalBusinessIdentity)),assetFactId:d.factId,cumulative:false,reason:'小企业原固定资产清理扣除账面净值及本次相关已核税费后，净收益/损失转营业外收支；不将税务评估扣除当账面成本',sourceRefs:d.sourceRefs,entries:gain>0n?[{code:'1606',debit:money(gain),credit:'0.00'},{code:'5301',debit:'0.00',credit:money(gain)}]:[{code:'5711',debit:money(-gain),credit:'0.00'},{code:'1606',debit:'0.00',credit:money(-gain)}]},month));
    }
    const beforeIncome = applyAgencyDerivedJournals(withPrior, nonIncome);beforeIncome.unresolvedTaxDependencies=withPrior.unresolvedTaxDependencies;
    tax = calculateAgencyObligations({ scope, entity: document.entity, accounting: beforeIncome, records: document.records });
    for(const o of tax.obligations)if(['vat','social_insurance','housing_fund','property','stamp','disability_fund','urban_maintenance','education_surcharge','local_education','consumption','resource','water_resource','environment','union_funds','cultural_construction','land_appreciation','urban_land','vehicle_vessel','deed','farmland_occupation','vehicle_purchase','customs','tobacco','vessel_tonnage'].includes(o.obligationId)&&['missing','unknown','uncovered'].includes(o.status))unresolvedTaxes.set(`${month}:${o.obligationId}`,{period:month,obligationId:o.obligationId,status:o.status,reason:o.reason,sourceRefs:o.sourceRefs});
    const income = [];
    for (const row of tax.entries.filter(e => e.cumulative)) {
      const desired = cents(row.entries[0].debit), previous = cumulative.get(row.obligationId) ?? 0n, delta = desired - previous; cumulative.set(row.obligationId, desired);
      if (!delta) continue;
      const entries = delta > 0n ? [{ ...row.entries[0], debit: money(delta) }, { ...row.entries[1], credit: money(delta) }] : [{ ...row.entries[0], debit: '0.00', credit: money(-delta) }, { ...row.entries[1], debit: money(-delta), credit: '0.00' }];
      income.push(journalFrom(row, month, entries));
    }
    // 前期为正、本期计算为零时属于真实减少，不是规则分支缺失。
    for (const id of ['corporate_income', 'business_income']) {
      const row = tax.obligations.find(o => o.obligationId === id && o.status === 'calculated');
      if (row && cents(row.due) === 0n && (cumulative.get(id) ?? 0n) > 0n) {
        const amount = cumulative.get(id), prior = journals.findLast(v => v.derived?.obligationId === id && v.derived.cumulative);
        if (prior) income.push(journalFrom({ obligationId: id, kind: prior.derived.kind, cumulative: true, reason: row.reason, sourceRefs: prior.sourceRefs }, month, [{ code: prior.entries[0].code, debit: '0.00', credit: money(amount) }, { code: '2221', debit: money(amount), credit: '0.00' }])); cumulative.set(id, 0n);
      }
    }
    journals.push(...nonIncome, ...income); accounting = applyAgencyDerivedJournals(raw, journals);accounting.unresolvedTaxDependencies=[...unresolvedTaxes.values()];
    accounting.issues.push(...tax.issues.filter(i=>['agency_personal_payment_actual_mismatch','contribution_personal_clearing_missing'].includes(i.code)));
    periodCalculations.push({ period: month, obligations: tax.obligations, taxableProfitWorkpaper: tax.taxableProfitWorkpaper, issues: tax.issues });
  }
  let yearEndAdjustments = [];
  if (annual) {
    tax = calculateAgencyObligations({ scope: document.scope, entity: document.entity, accounting, records: document.records, annual: true });
    yearEndAdjustments = tax.entries.filter(e => e.cumulative).map(row => { const desired = cents(row.entries[0].debit), accrued = cumulative.get(row.obligationId) ?? 0n, delta = desired - accrued; return { obligationId: row.obligationId, annualDue: money(desired), prepaymentAccrued: money(accrued), adjustment: money(delta), sourceRefs: row.sourceRefs, entries: delta === 0n ? [] : delta > 0n ? [{ ...row.entries[0], debit: money(delta) }, { ...row.entries[1], credit: money(delta) }] : [{ ...row.entries[0], debit: '0.00', credit: money(-delta) }, { ...row.entries[1], debit: money(-delta), credit: '0.00' }] }; });
  }
  return { accounting, tax, periodCalculations, yearEndAdjustments };
}

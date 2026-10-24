// Deterministic national calculations. Regional values are deliberately not caller rates.
import { parseMoney, formatCents } from './money.mjs';
import { hash, stable, requireValue } from './offline-material-adapters.mjs';
import { getAccountingRoles } from './accounting-profiles.mjs';

export const AGENCY_TAX_RULE_VERSION = 'agency-national-tax/1';
export const TAX_SOURCES = Object.freeze({
  vat: { url: 'https://shanghai.chinatax.gov.cn/zcfw/zcfgk/zzs/202412/t474694.html', title: '中华人民共和国增值税法', locator: '第9、10、11、21、23、28条', from: '2026-01-01' },
  vatRelief: { url: 'https://shanghai.chinatax.gov.cn/zcfw/zcfgk/zzs/202602/t479283.html', title: '财政部 税务总局公告2026年第10号', locator: '一、三（三）6', from: '2026-01-01', through: '2027-12-31' },
  smallRelief: { url: 'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5210453/content.html', title: '财政部 税务总局公告2023年第12号', locator: '一至五', from: '2023-01-01', through: '2027-12-31' },
  income: { url: 'https://www.chinatax.gov.cn/n810219/n810744/n3752930/n3752974/c3970366/content.html', title: '中华人民共和国个人所得税法', locator: '第3、6、12条及税率表', from: '2019-01-01' },
  withholding: { url: 'https://www.chinatax.gov.cn/chinatax/n810341/n810765/n3359382/201812/c4182700/content.html', title: '国家税务总局公告2018年第61号', locator: '第6、8条及附件预扣率表', from: '2019-01-01' },
  owners: { url: 'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5202702/content.html', title: '财税〔2000〕91号', locator: '附件1第2至5条；旧费用限额不沿用', from: '2000-01-01' },
  stamp: { url: 'https://shanghai.chinatax.gov.cn/zcfw/zcfgk/yhs/202106/t458595.html', title: '中华人民共和国印花税法', locator: '第5至12条及税目税率表', from: '2022-07-01' },
  disability: { url: 'https://hq.mof.gov.cn/tongzhitonggao/202303/t20230330_3876218.htm', title: '财政部公告2023年第8号', locator: '一至三', from: '2023-01-01', through: '2027-12-31' },
  social: { url: 'https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/bgt/art/2023/art_e81d115419b4463ebb59ec46467fb136.html', title: '中华人民共和国社会保险法', locator: '基本养老、基本医疗、工伤、失业、生育保险各章；基数费率须地区核定', from: '2011-07-01' },
  corporate: { url: 'https://12366.chinatax.gov.cn/bzds/050/050-4-1.html', title: '中华人民共和国企业所得税法', locator: '第4、5、10、18、28、54条', from: '2008-01-01' },
  corporateRules: { url: 'https://12366.chinatax.gov.cn/bzds/054/054-5-2.html', title: '中华人民共和国企业所得税法实施条例', locator: '第40至44条', from: '2008-01-01' },
  educationRelief: { url: 'https://www.chinatax.gov.cn/chinatax/n810356/n3255681/c5164622/content.html', title: '财税〔2016〕12号免征销售额官方答复', locator: '月不超过10万元/季不超过30万元', from: '2016-02-01' },
  prepayment: { url: 'https://www.mof.gov.cn/jrttts/202602/P020260203333755634194.pdf', title: '增值税预缴税款管理办法（2026年第14号附件）', locator: '建筑服务及不动产预缴章节', from: '2026-01-01' },
  individualRules: { url: 'https://fgk.chinatax.gov.cn/zcfgk/c100011/c5196330/content.html', title: '个体工商户个人所得税计税办法（2018修订、全文有效）', locator: '第5至7、15至29条', from: '2018-06-15' },
  property: { url: 'https://xzfg.moj.gov.cn/law/download?LawID=764&type=pdf', title: '中华人民共和国房产税暂行条例', locator: '第1至4条；从价1.2%、从租12%，地方决定原值扣除10%-30%', from: '1986-10-01' },
  housingProperty: { url: 'https://www.chinatax.gov.cn/chinatax/n810356/n3255681/c5169754/content.html', title: '总局住房租赁房产税政策答复', locator: '2021年第24号：单位向个人/专业化规模化住房租赁企业出租住房4%', from: '2021-10-01' },
  propertyVatBase: { url: 'https://www.chinatax.gov.cn/chinatax/n810341/n810765/n1990035/n1990077/c2192930/content.html', title: '财税〔2016〕43号', locator: '二、五：房产税租金不含VAT；免征VAT时不扣VAT', from: '2016-05-01' },
  sixTaxProcedure: {url:'https://12366.chinatax.gov.cn/bzds/002/002-5-18.html',title:'国家税务总局公告2022年第3号',locator:'一般纳税人小型微利资格申报窗口、新设首次汇算前后、逾期/更正',from:'2022-01-01'},
  rentalWithholding: {url:'https://qingdao.chinatax.gov.cn/ssfg2019/cjwt/cjwtqt/202505/t20250507_94232.html',title:'青岛税务个人出租房屋所得税说明',locator:'仅取财产租赁PIT费用/已缴税费/修缮扣除及住房10%；不沿用其中旧VAT口径',from:'2025-05-07'},
  leaseTax: {url:'https://www.chinatax.gov.cn/n810341/n810765/n812176/n812748/c1193046/content.html',title:'企业所得税实施条例租赁扣除及资产计税基础',locator:'仅第47、58条；不沿用页面其他旧扣除比例',from:'2008-01-01'},
  tobacco: {url:'https://zhejiang.chinatax.gov.cn/art/2017/12/27/art_25716_82709.html',title:'中华人民共和国烟叶税法',locator:'合法收购烤烟叶、晾晒烟叶的单位；一般零售卷烟不是此税触发',from:'2018-07-01'},
  vesselTonnage: {url:'https://zhejiang.chinatax.gov.cn/art/2018/10/26/art_25716_82710.html',title:'中华人民共和国船舶吨税法',locator:'境外港口进入境内港口船舶、海关征收',from:'2018-07-01'},
  vatElection: {url:'https://zhejiang.chinatax.gov.cn/art/2026/2/2/art_8409_84409.html',title:'国家税务总局公告2026年第4号',locator:'四：小规模可对部分应税交易放弃减税；2023年第1号已废止',from:'2026-01-01'},
  prepaymentSurcharge: {url:'https://www.mof.gov.cn/gp/xxgkml/szs/201609/t20160906_2510615.htm',title:'财税〔2016〕74号',locator:'一、二：预缴地就预缴税款、机构所在地就扣除预缴后实际缴税计附加',from:'2016-05-01'},
  sixTaxExamples:{url:'https://www.chinatax.gov.cn/chinatax/n810341/n810760/c5173292/content.html',title:'2022年第3号总局官方解读',locator:'例2/6/8/9：普通税费属期窗口、新设首次、逾期与更正原窗口',from:'2022-01-01'},
  businessAdvance:{url:'https://12366.chinatax.gov.cn/bzds/072/072.html',title:'经营所得A表及填报说明',locator:'投资者预缴费用按实际经营月份；年度扣除与预缴区别',from:'2019-01-01'},
  rentFreeProperty:{url:'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5203544/content.html',title:'财税〔2010〕121号',locator:'二免租期按房产原值、三原值包括地价',from:'2010-12-29'},
  vehiclePurchase:{url:'https://fgk.chinatax.gov.cn/zcfgk/c100009/c5193038/content.html',title:'中华人民共和国车辆购置税法',locator:'第1至6、9、12条：自用、一次征收、不含VAT计价、10%',from:'2019-07-01'},
  electricVehicle:{url:'https://www.miit.gov.cn/zwgk/zcwj/wjfb/gg/art/2023/art_4a6f9849758d4d47b0ffa6592958447d.html',title:'2023年第10号新能源汽车车购税优惠',locator:'2026—2027减半，新能源乘用车减税每辆不超过15000',from:'2026-01-01',through:'2027-12-31'},
  electricVehicle2026:{url:'https://shanghai.chinatax.gov.cn/bsfw/nszx/hdfk/202602/t479413.html',title:'2026—2027新能源汽车目录与技术要求官方答复',locator:'2025年第24号技术要求及2026有效减免目录，不自动沿用2025旧车型',from:'2026-01-01',through:'2027-12-31'},
  cultural:{url:'https://tianjin.chinatax.gov.cn/11200000000/0300/030004/03000418/20260813155010984.shtml',title:'财税〔2016〕25号',locator:'一/三/七/九：实际广告服务主体、含税计费扣合法实付发布费、3%、小规模2万/6万、预算归属',from:'2016-05-01'},
  culturalEntertainment:{url:'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5194648/content.html',title:'财税〔2016〕60号',locator:'娱乐含税全额3%，未达增值税起征点免征；不沿用疫情已到期免征',from:'2016-05-01'},
  culturalRelief:{url:'https://szs.mof.gov.cn/zt/mlqd_8464/2013yljfcs/202502/t20250212_3958361.htm',title:'财税〔2025〕7号',locator:'中央收入减50%，地方减征幅度另核',from:'2025-01-01',through:'2027-12-31'},
  union:{url:'https://www.mohrss.gov.cn/xxgk2020/fdzdgknr/zcfg/fl/202011/t20201102_394624.html?jump=true',title:'中华人民共和国工会法（2021修正）',locator:'第43条：已建会单位月全部职工工资总额2%；非地区税务代收比例',from:'2022-01-01'},
  wageTotal:{url:'https://www.stats.gov.cn/gk/tjfg/xzfg/202302/P020230206361243611824.pdf',title:'关于工资总额组成的规定',locator:'第3、4、11条：直接支付、六类工资及排除项，包含个人代扣部分',from:'1990-01-01'},
  landAppreciation:{url:'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5193703/content.html',title:'土地增值税暂行条例实施细则',locator:'第7/8/10条：旧房确认评估、土地及相关税金、项目分别计算、四档速扣',from:'1995-01-27'},
  landAppreciation2026:{url:'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5246543/content.html',title:'国家税务总局公告2026年第3号',locator:'原受理适用边界、预征及清算所属期、印花/地方教育可扣、尾盘；不取代地方预征率',from:'2026-01-01'},
  landSubject:{url:'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5193049/content.html',title:'国税地字〔1988〕15号（现行部分）',locator:'四：权利人、异地代管/实际使用、权属不明及共有分别纳税；不沿用其他已废止条款',from:'1988-10-24'},
  localEducation:{url:'https://sx.mof.gov.cn/bszn/zhengcefagui/201011/t20101123_355143.htm',title:'财综〔2010〕98号',locator:'二：地方教育附加全国统一实际VAT/消费税2%；不沿用营业税，特殊经批准减免另核',from:'2011-01-01'},
});
export const cents = (v, label = 'amount') => { const p = parseMoney(v, { allowEmpty: false, allowNegative: true, label }); requireValue(p.ok && !p.subCent, 'agency_amount_invalid'); return p.cents; };
export const money = formatCents;
export const roundRatio = (n, d) => { requireValue(d > 0n, 'agency_divisor_invalid'); return n < 0n ? -roundRatio(-n, d) : (n + d / 2n) / d; };
export const rateAmount = (amount, numerator, denominator = 10000) => roundRatio(amount * BigInt(numerator), BigInt(denominator));
export function quantity(v) { requireValue(typeof v === 'string' && /^(0|[1-9]\d{0,9})(\.\d{1,6})?$/.test(v), 'agency_quantity_invalid'); const [a, b = ''] = v.split('.'); return BigInt(a) * 1000000n + BigInt(b.padEnd(6, '0')); }
const positive = n => n > 0n ? n : 0n;
const sum = (records, field) => records.reduce((n, r) => n + cents(r[field]), 0n);
const src = keys => keys.map(k => ({ sourceId: k, ...TAX_SOURCES[k] }));
const issue = (code, request, factId = null) => ({ code, request, factId, state: 'missing' });
const progressive = (base, brackets) => {
  let previous = 0n, tax = 0n;
  for (const [limit, rate] of brackets) { const top = limit === null ? base : BigInt(limit) * 100n; const part = positive((base < top ? base : top) - previous); tax += rateAmount(part, rate); if (base <= top) break; previous = top; }
  return tax;
};
const businessBrackets = [[30000, 500], [90000, 1000], [300000, 2000], [500000, 3000], [null, 3500]];
const salaryBrackets = [[36000, 300], [144000, 1000], [300000, 2000], [420000, 2500], [660000, 3000], [960000, 3500], [null, 4500]];
const stampRates = Object.freeze({ sale: 3, processing: 3, construction: 3, transport: 3, technology: 3, lease: 10, storage: 10, custody: 10, insurance: 10, loan: 0.5, property_transfer: 5, capital_books: 2.5 });
export const OBLIGATION_IDS = Object.freeze(['vat', 'vat_prepayment', 'corporate_income', 'business_income', 'salary_withholding', 'other_withholding', 'urban_maintenance', 'education_surcharge', 'local_education', 'stamp', 'property', 'urban_land', 'vehicle_vessel', 'consumption', 'resource', 'water_resource', 'environment', 'deed', 'land_appreciation', 'farmland_occupation', 'vehicle_purchase', 'customs', 'cultural_construction', 'union_funds', 'tobacco', 'vessel_tonnage', 'social_insurance', 'housing_fund', 'disability_fund']);

/** Output rates follow the transaction, never an industry-wide default. */
export function calculateAgencyOutputVat({ entity, category, net, date, invoiceKind, vatReliefWaived = entity.vatReliefWaived }) {
  const base = cents(net); requireValue(base >= 0n && /^202[67]-\d\d-\d\d$/.test(date), 'agency_vat_scope_unverified');
  requireValue(['ordinary', 'special', 'unissued'].includes(invoiceKind), 'agency_invoice_kind_missing');
  const general = { goods: 1300, processing: 1300, movable_lease: 1300, transport: 900, construction: 900, real_estate_lease: 900, service: 600, catering: 600, property_management: 600 };
  requireValue(Object.hasOwn(general, category), 'agency_vat_category_uncovered');
  if (entity.vatStatus === 'general') return { tax: money(rateAmount(base, general[category])), rateBasisPoints: general[category], sources: src(['vat']) };
  requireValue(entity.vatStatus === 'small', 'agency_vat_status_missing');
  if (category === 'real_estate_lease') return { tax: money(rateAmount(base, 300)), rateBasisPoints: 300, sources: src(['vat', 'vatRelief']) };
  requireValue(typeof vatReliefWaived === 'boolean', 'agency_vat_relief_election_required');
  const rate = vatReliefWaived ? 300 : 100;
  return { tax: money(rateAmount(base, rate)), rateBasisPoints: rate, sources: src(['vat', 'vatRelief', 'vatElection']) };
}
export function splitAgencyOriginalPrice({ entity, category, originalUnitPrice, units, priceIncludesVat, date, invoiceKind, vatReliefWaived }) {
  requireValue(typeof priceIncludesVat === 'boolean', 'agency_price_tax_inclusion_missing');
  const original = roundRatio(cents(originalUnitPrice) * quantity(units), 1000000n);
  const rate = calculateAgencyOutputVat({ entity, category, net: '0.00', date, invoiceKind, vatReliefWaived }).rateBasisPoints;
  const net = priceIncludesVat ? roundRatio(original * 10000n, BigInt(10000 + rate)) : original, tax = priceIncludesVat ? original - net : rateAmount(net, rate);
  return { originalAmount: money(original), priceIncludesVat, net: money(net), tax: money(tax), gross: money(net + tax), rateBasisPoints: rate };
}
export function calculateAgencyRentalPrice({entity,lease,amount,priceIncludesVat,date,invoiceKind}) {
  const scenario=lease.vatScenario??'ordinary';
  if(scenario==='ordinary'){
    requireValue(!(lease.housing===true&&entity.kind==='individual_business'&&entity.vatStatus==='small'),'agency_housing_vat_scenario_missing');
    return {...splitAgencyOriginalPrice({entity,category:lease.assetKind==='real_estate'?'real_estate_lease':'movable_lease',originalUnitPrice:amount,units:'1',priceIncludesVat,date,invoiceKind,vatReliefWaived:lease.vatReliefWaived}),relief:'0.00',simplifiedMethod:entity.vatStatus==='small'};
  }
  requireValue(lease.assetKind==='real_estate'&&typeof priceIncludesVat==='boolean'&&['ordinary','special','unissued'].includes(invoiceKind)&&/^202[67]-/.test(date),'agency_rental_vat_facts_missing');
  let statutory,actual;
  if(scenario==='personal_housing'){
    requireValue(entity.kind==='individual_business'&&entity.vatStatus==='small'&&lease.housing===true,'agency_personal_housing_eligibility_missing');statutory=300;actual=150;
  }else if(scenario==='housing_lease_enterprise'){
    requireValue(entity.kind==='company'&&entity.housingLeaseEnterpriseQualified===true&&lease.housing===true&&lease.tenantKind==='natural'&&lease.simplifiedElection===true,'agency_housing_enterprise_eligibility_missing');statutory=500;actual=150;
  }else if(scenario==='old_real_estate_simple'){
    requireValue(entity.vatStatus==='general'&&lease.oldPropertySimplifiedElection===true&&/^20\d\d-\d\d-\d\d$/.test(lease.propertyAcquiredDate??'')&&lease.propertyAcquiredDate<'2016-05-01','agency_old_property_simple_eligibility_missing');statutory=500;actual=500;
  }else requireValue(false,'agency_rental_vat_scenario_uncovered');
  const original=cents(amount),net=priceIncludesVat?roundRatio(original*10000n,BigInt(10000+statutory)):original,gross=priceIncludesVat?original:net+rateAmount(net,statutory),tax=rateAmount(net,actual);
  return {originalAmount:money(original),priceIncludesVat,net:money(net),tax:money(tax),gross:money(gross),relief:money(gross-net-tax),rateBasisPoints:statutory,actualRateBasisPoints:actual,simplifiedMethod:true,scenario,sources:src(['vat','vatRelief'])};
}

// No regional rules are preinstalled. This is a truthful registry, not a mechanism
// that promotes arbitrary user-supplied rates or URLs into verified law.
export function listAgencyRegionalRules() { return []; }
export function determineAgencySixTaxRelief({scope,entity,records}) {
  if(entity.vatStatus==='small'||entity.kind==='individual_business')return {eligible:true,basis:'2023年第12号：小规模或个体身份',sourceRefs:[]};
  if(entity.kind!=='company')return {eligible:false,basis:'一般纳税人非企业所得税小型微利企业且非个体',sourceRefs:[]};
  const context=records.find(r=>r.type==='filing_context'&&r.assessmentPeriod===scope.period),declaredOn=context?.declaredOn;
  if(!/^20\d\d-\d\d-\d\d$/.test(declaredOn??''))return {eligible:null,reason:'六税两费须核税费所属期及原申报日期；普通汇算按所属期窗口，新设首次前另核申报期快照'};
  const facts=records.filter(r=>r.type==='six_tax_relief_qualification'&&r.date<=declaredOn),normal=facts.filter(q=>q.basis==='annual_filed_return'&&q.filedOn<=declaredOn&&q.returnReceiptNumber);
  const priorFirstFiling=context.originalReturnReceiptNumber&&/^20\d\d-\d\d-\d\d$/.test(context.originalDeclaredOn??'')&&normal.some(q=>q.firstFinal&&context.originalDeclaredOn<(q.originalFiledOn??(q.filedOn>`${Number(q.returnYear)+1}-05-31`?`${Number(q.returnYear)+1}-05-31`:q.filedOn)));
  for(const q of normal.sort((a,b)=>b.filedOn.localeCompare(a.filedOn))){
    if(priorFirstFiling)continue;
    if(!/^20\d\d$/.test(q.returnYear??'')||typeof q.firstFinal!=='boolean')return {eligible:null,reason:'汇算原件须所属年度及是否首次，不能按更正/逾期提交年份移动减免窗口'};
    const original=q.correctsReceiptNumber?normal.find(old=>old.returnReceiptNumber===q.correctsReceiptNumber&&old.returnYear===q.returnYear):q;
    if(!original)return {eligible:null,reason:'更正汇算须原申报回执/所属年及首次办理历史，缺原链不能重开减免窗口'};
    const statutoryDeadline=`${Number(q.returnYear)+1}-05-31`,originalFiledOn=original.originalFiledOn??original.filedOn,effectiveFirst=originalFiledOn>statutoryDeadline?statutoryDeadline:originalFiledOn;
    const from=q.firstFinal?new Date(Date.UTC(Number(effectiveFirst.slice(0,4)),Number(effectiveFirst.slice(5,7)),1)).toISOString().slice(0,10):`${Number(q.returnYear)+1}-07-01`,through=`${Number(q.returnYear)+2}-06-30`,taxDate=`${scope.period}-01`;
    const alreadyFiledBeforeFirst=q.firstFinal&&context.originalReturnReceiptNumber&&context.originalDeclaredOn&&context.originalDeclaredOn<effectiveFirst;
    if(alreadyFiledBeforeFirst)continue;
    if(!(taxDate>=from&&taxDate<=through||q.firstFinal&&declaredOn>=effectiveFirst&&scope.period<=effectiveFirst.slice(0,7)&&scope.period>=entity.businessStartDate.slice(0,7)))continue;
    if(typeof q.restrictedIndustry!=='boolean'||q.taxableIncomeReported===undefined||q.staffAverageReported===undefined||q.assetsAverageReported===undefined)return {eligible:null,reason:'原汇算回执及表内应纳税所得额/平均人数/资产/行业不完整'};
    const eligible=!q.restrictedIndustry&&cents(q.taxableIncomeReported)<=300000000n&&quantity(q.staffAverageReported)<=300000000n&&cents(q.assetsAverageReported)<=5000000000n;
    return {eligible,basis:'普通按税费所属期及原汇算年度窗口；首次按原办理/法定截止，逾期更正不移动原窗口',from,through,taxPeriod:scope.period,returnReceiptNumber:q.returnReceiptNumber,returnYear:q.returnYear,correctionImpact:q.correctsReceiptNumber||q.filedOn>statutoryDeadline?{previousReceipt:q.correctsReceiptNumber??null,affectedFrom:from,affectedThrough:through,reviewRequired:true}:null,sourceRefs:[...context.sourceRefs,...q.sourceRefs,...(original!==q?original.sourceRefs:[])]};
  }
  const q=facts.find(q=>q.basis==='new_enterprise_before_first_final'&&q.noFirstFinalYet===true);
  if(q&&(priorFirstFiling||!normal.some(n=>n.filedOn<=declaredOn))){
    const snapshotDeclaredOn=priorFirstFiling?context.originalDeclaredOn:declaredOn,establishmentMonth=entity.businessStartDate.slice(0,7),snapshot=snapshotDeclaredOn.slice(0,7)===establishmentMonth?entity.businessStartDate:new Date(Date.UTC(Number(snapshotDeclaredOn.slice(0,4)),Number(snapshotDeclaredOn.slice(5,7))-1,0)).toISOString().slice(0,10);
    if(q.snapshotAsOf!==snapshot||!Number.isSafeInteger(q.staffCount)||q.staffCount<0||q.assetsOriginalAmount===undefined||typeof q.restrictedIndustry!=='boolean')return {eligible:null,reason:'新设首次汇算前须核申报期上月末人数/资产，设立当月按设立时；缺项不能默认满足'};
    return {eligible:!q.restrictedIndustry&&q.staffCount<=300&&cents(q.assetsOriginalAmount)<=5000000000n,basis:priorFirstFiling?'首次汇算前已按规定申报不追溯改变；保留当时申报期快照':'新设一般纳税人首次汇算前，按原上月末/设立时人数和资产核资格',snapshotAsOf:snapshot,sourceRefs:[...context.sourceRefs,...q.sourceRefs]};
  }
  return {eligible:null,reason:'一般纳税人小型微利六税两费资格缺对应有效汇算窗口/首次汇算事实；逾期或更正资料未核不得猜定'};
}
/** Official assessed amounts are original documents, distinct from an unverified regional-rate trial. */
export function calculateAgencyContributionNotices({scope,entity,records}) {
  const notices=records.filter(r=>r.type==='contribution_notice'&&r.date.slice(0,7)<=scope.period), calculations=[],payments=[],issues=[];
  const seen=new Set(),seenLines=new Set();
  for(const n of notices){
    if(!n.noticeNumber||!['tax_authority','social_insurance_agency','housing_fund_center'].includes(n.issuerType)||!n.issuerName||!entity.registrationNumber||n.registrationNumber!==entity.registrationNumber||n.region!==entity.region||!/^20\d\d-\d\d$/.test(n.assessmentPeriod)||!Array.isArray(n.lines)||!n.lines.length){issues.push(issue('contribution_notice_identity_missing','核官方当期核定单发文机关、企业登记号、地区、所属期及人员险种明细',n.id));continue;}
    const identity=stable([n.issuerName,n.noticeNumber]);requireValue(!seen.has(identity),'agency_contribution_notice_duplicate');seen.add(identity);
    let total=0n;
    for(const l of n.lines){
      requireValue(l.employeeId&&['pension','medical','unemployment','injury','maternity','housing'].includes(l.component),'agency_contribution_notice_line_invalid');
      const lineKey=stable([n.assessmentPeriod,l.employeeId,l.component]);requireValue(!seenLines.has(lineKey),'agency_contribution_notice_component_duplicate');seenLines.add(lineKey);
      const employee=cents(l.employeeAmount),employer=cents(l.employerAmount);requireValue(employee>=0n&&employer>=0n,'agency_contribution_notice_amount_invalid');total+=employee+employer;
      calculations.push({noticeNumber:n.noticeNumber,issuerName:n.issuerName,assessmentPeriod:n.assessmentPeriod,employeeId:l.employeeId,component:l.component,employee:money(employee),employer:money(employer),total:money(employee+employer),sourceRefs:n.sourceRefs,policyVerification:'official_assessment_notice',basis:'原官方核定明细，不声称地区费率注册已核'});
    }
    requireValue(total===cents(n.documentTotal),'agency_contribution_notice_total_mismatch');
  }
  const paidIdentities=new Set(),paidComponents=new Set();
  for(const p of records.filter(r=>r.type==='contribution_payment'&&r.date.slice(0,7)===scope.period)){
    const n=notices.find(n=>n.noticeNumber===p.noticeNumber&&n.issuerName===p.issuerName&&n.assessmentPeriod===p.assessmentPeriod), rows=calculations.filter(c=>c.noticeNumber===p.noticeNumber&&c.issuerName===p.issuerName&&c.assessmentPeriod===p.assessmentPeriod);
    if(!n||!rows.length||!p.bankAccountId||!p.paymentReference||!Array.isArray(p.components)||new Set(p.components).size!==p.components.length||p.components.some(c=>!rows.some(r=>r.component===c))){issues.push(issue('contribution_payment_notice_missing','实际缴费须关联该企业官方核定单、税费所属期、银行账户/流水及实际缴费险种；不默忽略已给付款',p.id));continue;}
    const key=stable([p.bankAccountId,p.paymentReference]);requireValue(!paidIdentities.has(key),'agency_contribution_payment_duplicate');paidIdentities.add(key);
    for(const component of p.components){const k=stable([p.issuerName,p.noticeNumber,p.assessmentPeriod,component]);requireValue(!paidComponents.has(k),'agency_contribution_notice_payment_duplicate');paidComponents.add(k);}
    const matched=rows.filter(r=>p.components.includes(r.component)),employee=matched.reduce((n,c)=>n+cents(c.employee),0n),employer=matched.reduce((n,c)=>n+cents(c.employer),0n),amount=cents(p.amount);
    if(amount!==employee+employer){issues.push(issue('contribution_payment_amount_difference','银行实缴与核定明细金额不符，保留差额待核及分配，不凭总额假定清偿',p.id));continue;}
    payments.push({id:p.id,stableIdentity:hash(key),noticeNumber:p.noticeNumber,assessmentPeriod:p.assessmentPeriod,components:p.components,amount:money(amount),employee:money(employee),employer:money(employer),sourceRefs:[...p.sourceRefs,...n.sourceRefs]});
  }
  return {version:'agency-official-contribution/1',calculations,payments,issues,policyVerification:'official_assessment_notice',regionalRateVerification:'not_inferred_from_notice'};
}
/** Formula layer only. Supplied parameters never acquire official verification. */
export function calculateAgencyContributionArithmetic({ wages, parameters, payments = [] }) {
  requireValue(Array.isArray(wages) && Array.isArray(parameters?.components), 'agency_contribution_input_invalid');
  const calculations = [];
  for (const employee of wages) {
    requireValue(typeof employee.employeeId === 'string' && Array.isArray(employee.previousYearMonthlyWages) && employee.previousYearMonthlyWages.length > 0, 'agency_contribution_wage_history_required');
    const average = roundRatio(employee.previousYearMonthlyWages.reduce((n, v) => n + cents(v), 0n), BigInt(employee.previousYearMonthlyWages.length));
    for (const component of parameters.components) {
      requireValue(['pension', 'medical', 'unemployment', 'injury', 'maternity', 'housing'].includes(component.component) && Number.isSafeInteger(component.employeeRateBasisPoints) && Number.isSafeInteger(component.employerRateBasisPoints) && component.employeeRateBasisPoints >= 0 && component.employeeRateBasisPoints <= 10000 && component.employerRateBasisPoints >= 0 && component.employerRateBasisPoints <= 10000, 'agency_contribution_parameters_invalid');
      const minimum = cents(component.minimumBase), maximum = cents(component.maximumBase); requireValue(minimum >= 0n && maximum >= minimum, 'agency_contribution_base_range_invalid'); const base = average < minimum ? minimum : average > maximum ? maximum : average;
      const personal = rateAmount(base, component.employeeRateBasisPoints) + cents(component.fixedEmployee), employer = rateAmount(base, component.employerRateBasisPoints) + cents(component.fixedEmployer), actual = payments.filter(p => p.employeeId === employee.employeeId && p.component === component.component);
      calculations.push({ employeeId: employee.employeeId, component: component.component, averageOriginalWage: money(average), base: money(base), employee: money(personal), employer: money(employer), total: money(personal + employer), paid: money(sum(actual, 'amount')), difference: money(personal + employer - sum(actual, 'amount')), state: 'parameterized_arithmetic_only', policyVerification: 'unverified', authorizesExecution: false });
    }
  }
  return { version: 'agency-contribution-arithmetic/1', calculations, employeeTotal: money(calculations.reduce((n, c) => n + cents(c.employee), 0n)), employerTotal: money(calculations.reduce((n, c) => n + cents(c.employer), 0n)), policyVerification: 'unverified', submittable: false, authorizesExecution: false };
}
export function calculateAgencyDisabilityArithmetic({ months, disabledEmploymentMonths, socialAverageAnnualWage, requiredRatio }) {
  requireValue(Array.isArray(months) && months.length === 12 && new Set(months.map(m => m.month)).size === 12, 'agency_disability_full_year_required');
  const workers12 = months.reduce((n, m) => n + quantity(m.employees), 0n), disabled12 = quantity(disabledEmploymentMonths), ratio = quantity(requiredRatio); requireValue(workers12 > 0n && ratio <= 1000000n, 'agency_disability_parameters_invalid');
  const wageTotal = months.reduce((n, m) => n + cents(m.wages), 0n), averageWage = roundRatio(wageTotal * 12000000n, workers12), cap = cents(socialAverageAnnualWage) * 2n, assessmentWage = averageWage < cap ? averageWage : cap;
  const shortage12 = positive(roundRatio(workers12 * ratio, 1000000n) - disabled12), gross = roundRatio(shortage12 * assessmentWage, 12000000n), band = disabled12 * 100n >= workers12 ? 5000 : 9000;
  return { version: 'agency-disability-arithmetic/1', averageEmployees: Number(workers12) / 12000000, averageWage: money(averageWage), wageCap: money(cap), assessmentWage: money(assessmentWage), gross: money(gross), reliefBasisPoints: band, due: money(rateAmount(gross, band)), policyVerification: 'regional_ratio_and_wage_unverified', authorizesExecution: false, submittable: false };
}
/** Current deductions/tax are derived. Only earlier periods use actual withholding evidence. */
export function calculateAgencyPayrollArithmetic({ scope, payrollRecords, contributionArithmetic }) {
  requireValue(Array.isArray(payrollRecords) && contributionArithmetic?.version === 'agency-contribution-arithmetic/1', 'agency_payroll_arithmetic_input_invalid');
  const employees = [...new Set(payrollRecords.map(r => r.employeeId))], calculations = [];
  for (const employeeId of employees) {
    const rows = payrollRecords.filter(r => r.employeeId === employeeId && r.date.slice(0, 4) === scope.period.slice(0, 4) && r.date.slice(0, 7) <= scope.period).sort((a, b) => a.date.localeCompare(b.date));
    const current = rows.find(r => r.date.slice(0, 7) === scope.period); if (!current) continue;
    requireValue(rows.every(r => r.resident === true && Number.isSafeInteger(r.employmentMonth) && Object.hasOwn(r, 'specialAdditionalDeduction') && Object.hasOwn(r, 'otherDeduction')) && new Set(rows.map(r => r.employmentMonth)).size === rows.length && rows.at(-1).employmentMonth === rows.length, 'agency_payroll_history_incomplete');
    const contributions = contributionArithmetic.calculations.filter(c => c.employeeId === employeeId), assessedPersonal = contributions.reduce((n, c) => n + cents(c.employee), 0n), employer = contributions.reduce((n, c) => n + cents(c.employer), 0n), received=rows.filter(r=>r.paid!==false&&(r.paymentDate??r.date).slice(0,7)<=scope.period),receivedCurrent=received.filter(r=>(r.paymentDate??r.date).slice(0,7)===scope.period),grossCurrent=receivedCurrent.reduce((n,r)=>n+sum(r.components,'amount'),0n),personal=grossCurrent>0n?assessedPersonal:0n;
    const prior = received.filter(r => (r.paymentDate??r.date).slice(0,7)<scope.period); requireValue(prior.every(r => Object.hasOwn(r, 'employeeSocial') && Object.hasOwn(r, 'employeeHousing') && Object.hasOwn(r, 'taxWithheld')), 'agency_payroll_actual_history_missing');
    const gross = received.reduce((n, r) => n + sum(r.components, 'amount'), 0n), priorPersonal = prior.reduce((n, r) => n + cents(r.employeeSocial) + cents(r.employeeHousing), 0n), other = rows.reduce((n, r) => n + cents(r.specialAdditionalDeduction) + cents(r.otherDeduction), 0n), base = positive(gross - priorPersonal - personal - other - 500000n * BigInt(rows.length)), dueTotal = progressive(base, salaryBrackets), withheldBefore = prior.reduce((n, r) => n + cents(r.taxWithheld), 0n), withholding = positive(dueTotal - withheldBefore), net = grossCurrent - personal - withholding;
    requireValue(net >= 0n, 'agency_payroll_deductions_exceed_wage');
    const housingPersonal = grossCurrent===0n?0n:contributions.filter(c => c.component === 'housing').reduce((n, c) => n + cents(c.employee), 0n), socialPersonal = personal - housingPersonal;
    calculations.push({ employeeId, grossCurrent: money(grossCurrent), employerContribution: money(employer), employeeSocial: money(socialPersonal), employeeHousing: money(housingPersonal), currentWithholding: money(withholding), netPay: money(net), taxableBaseDerived: money(base), cumulativeTax: money(dueTotal), priorWithheld: money(withheldBefore), sources: src(['withholding', 'social']), policyVerification: 'regional_parameters_unverified', status: 'trial_only', authorizesExecution: false,
      postingDraft: [
        { purpose: 'salary_accrual', entries: [{ role: current.use === 'production' || current.use === 'contract' ? 'productionCost' : current.use === 'admin' ? 'adminExpense' : 'mainCost', debit: money(grossCurrent + employer), credit: '0.00' }, { role: 'wages', debit: '0.00', credit: money(grossCurrent + employer) }] },
        { purpose: 'salary_payment_and_withholding', entries: [{ role: 'wages', debit: money(grossCurrent), credit: '0.00' }, { role: 'bank', debit: '0.00', credit: money(net) }, { role: 'otherPayable', debit: '0.00', credit: money(personal) }, { role: 'tax', debit: '0.00', credit: money(withholding) }] },
      ] });
  }
  return { version: 'agency-payroll-arithmetic/1', scope, calculations, policyVerification: 'regional_parameters_unverified', submittable: false, authorizesExecution: false };
}
export function calculateAgencyOfficialPayroll({scope,entity,records,official=calculateAgencyContributionNotices({scope,entity,records})}) {
  const paidNow=records.filter(r=>r.type==='payroll'&&r.paid===true&&(r.paymentDate??r.date).slice(0,7)===scope.period),current=official.calculations.filter(c=>c.assessmentPeriod===scope.period||paidNow.some(r=>r.employeeId===c.employeeId&&r.date.slice(0,7)===c.assessmentPeriod)),issues=[];
  if(!current.length)return {calculations:[],entries:[],issues,available:false};
  if(paidNow.some(r=>r.date.slice(0,4)!==scope.period.slice(0,4)))return {available:true,calculations:[],entries:[],issues:[issue('salary_prior_year_payment_history_required','跨年补发须当年任职月份及承接工资/个人社公往来原件完整核对，不能按上年计提期当已支付')]};
  const needed=['pension','medical','unemployment','injury','maternity','housing'],requiredPeriods=new Set([scope.period,...paidNow.map(r=>r.date.slice(0,7))]);
  for(const period of requiredPeriods){if(period===scope.period&&!records.some(r=>r.type==='payroll'&&r.date.slice(0,7)===period))continue;const covered=new Set(records.filter(r=>r.type==='contribution_notice'&&r.assessmentPeriod===period&&r.registrationNumber===entity.registrationNumber).flatMap(n=>n.coveredComponents??[]));if(!needed.every(c=>covered.has(c)))return {available:true,calculations:[],entries:[],issues:[issue('salary_contribution_notice_coverage_missing','实际支付工资对应各原所属期个人社公须逐项覆盖五险及公积金；缺件不当零')]};}
  const payrollRecords=records.filter(r=>r.type==='payroll'&&r.date.slice(0,4)===scope.period.slice(0,4)&&r.date.slice(0,7)<=scope.period).map(r=>{
    const rows=official.calculations.filter(c=>c.employeeId===r.employeeId&&c.assessmentPeriod===r.date.slice(0,7)),social=rows.filter(c=>c.component!=='housing').reduce((n,c)=>n+cents(c.employee),0n),housing=rows.filter(c=>c.component==='housing').reduce((n,c)=>n+cents(c.employee),0n);
    if((r.paymentDate??r.date).slice(0,7)<scope.period&&rows.length&&r.paid===true&&r.netPaid!==undefined){const actualWithheld=sum(r.components,'amount')-social-housing-cents(r.netPaid);requireValue(actualWithheld>=0n,'agency_prior_payroll_net_invalid');return {...r,employeeSocial:money(social),employeeHousing:money(housing),taxWithheld:money(actualWithheld)};}return r;
  });
  try{
    const actualContributions=current.filter(c=>paidNow.some(r=>r.employeeId===c.employeeId&&r.date.slice(0,7)===c.assessmentPeriod)),calculated=calculateAgencyPayrollArithmetic({scope,payrollRecords,contributionArithmetic:{version:'agency-contribution-arithmetic/1',calculations:actualContributions}}),entries=[];
    for(const c of calculated.calculations){
      c.policyVerification='official_assessment_notice';c.status='calculated_from_official_notice_and_wages';c.sourceRefs=[...current.filter(n=>n.employeeId===c.employeeId).flatMap(n=>n.sourceRefs),...payrollRecords.filter(r=>r.employeeId===c.employeeId).flatMap(r=>r.sourceRefs)];
      const employeeRows=payrollRecords.filter(r=>r.employeeId===c.employeeId);for(const raw of employeeRows.filter(r=>r.date.slice(0,7)===scope.period))if(typeof raw.paid!=='boolean')issues.push(issue('salary_actual_payment_state_missing','原计提与实际支付状态须明确，缺支付状态不能默认为未付或已取得所得',raw.id));const paid=employeeRows.filter(r=>r.paid===true&&(r.paymentDate??r.date).slice(0,7)===scope.period).sort((a,b)=>(a.paymentDate??a.date).localeCompare(b.paymentDate??b.date)||stable(a.businessIdentity).localeCompare(stable(b.businessIdentity))),prior=employeeRows.filter(r=>r.paid===true&&(r.paymentDate??r.date).slice(0,7)<scope.period);
      if(!paid.length){c.withholdingWhenPaid=c.currentWithholding;c.currentWithholding='0.00';c.status='unpaid_salary_no_current_withholding';continue;}
      let grossRunning=prior.reduce((n,r)=>n+sum(r.components,'amount'),0n),personalRunning=prior.reduce((n,r)=>n+cents(r.employeeSocial)+cents(r.employeeHousing),0n),withheldRunning=cents(c.priorWithheld),withheldThisPeriod=0n;const other=employeeRows.reduce((n,r)=>n+cents(r.specialAdditionalDeduction)+cents(r.otherDeduction),0n),basic=500000n*BigInt(employeeRows.length),bankKeys=new Set();
      for(const raw of paid){const paymentDate=raw.paymentDate??raw.date;requireValue(/^20\d\d-\d\d-\d\d$/.test(paymentDate)&&paymentDate>=raw.date,'agency_salary_payment_date_invalid');const personal=official.calculations.filter(n=>n.employeeId===raw.employeeId&&n.assessmentPeriod===raw.date.slice(0,7)).reduce((n,r)=>n+cents(r.employee),0n),gross=sum(raw.components,'amount');grossRunning+=gross;personalRunning+=personal;const desired=progressive(positive(grossRunning-personalRunning-other-basic),salaryBrackets),withholding=positive(desired-withheldRunning);withheldRunning+=withholding;withheldThisPeriod+=withholding;const net=gross-personal-withholding,bankKey=stable([raw.bankAccountId,raw.paymentReference]);
        if(!raw.paymentReference||!raw.bankAccountId||raw.netPaid===undefined||net<0n||cents(raw.netPaid)!==net||bankKeys.has(bankKey)){issues.push(issue('salary_payment_notice_difference','按实际支付日顺序派生累计个税及原所属期个人社公，与每笔原银行净款核对；不把未来付款记入计提月',raw.id));continue;}bankKeys.add(bankKey);
        entries.push({obligationId:'salary_withholding',period:scope.period,date:paymentDate,kind:'salary_payment',paymentId:hash(bankKey),cumulative:false,reason:'原工资计提与实际银行支付分别定位，按实际取得日期累计预扣并核销原应付工资',sourceRefs:c.sourceRefs,entries:[{code:'2211',debit:money(gross),credit:'0.00'},...(net?[{code:'1002',debit:'0.00',credit:money(net)}]:[]),...(personal?[{code:'2241',debit:'0.00',credit:money(personal)}]:[]),...(withholding?[{code:'2221',debit:'0.00',credit:money(withholding)}]:[])]});
      }
      requireValue(withheldThisPeriod===cents(c.currentWithholding),'agency_salary_current_withholding_allocation_mismatch');
    }
    for(const raw of paidNow)if(!calculated.calculations.some(c=>c.employeeId===raw.employeeId))issues.push(issue('salary_payment_employment_coverage_missing','已给实际付款不能忽略；需实际支付月任职/基本减除费用月份及历史扣款覆盖原件',raw.id));
    return {available:true,calculations:calculated.calculations,entries,issues};
  }catch(error){if(!error.code)throw error;return {available:true,calculations:[],entries:[],issues:[issue(error.code,'工资原始扣除/历史银行实付及官方缴费核定单不足，不能由客户预制本期社公扣款或个税替代')]};}
}

/** Resident payments are grouped by person/category/project/month before applying per-time deductions. */
export function calculateAgencyOtherWithholding({ scope, records }) {
  const groups = new Map(), issues = [],settledExpenses=new Set();
  for (const r of records.filter(r => r.type === 'personal_payment' && r.date.slice(0, 7) <= scope.period)) {
    if (r.resident !== true || !r.personId || !r.projectId || !['labor', 'author', 'royalty', 'dividend', 'rental_housing', 'rental_other'].includes(r.incomeCategory) || r.incomeCategory !== 'dividend' && !r.relatedExpenseFactId) { issues.push(issue('other_withholding_identity_missing', '核居民身份、所得类别、同项目归并、原始发票及对应已确认费用/分配事实', r.id)); continue; }
    const gross = cents(r.amountIncludingVat),vatKnown=r.incomeCategory==='dividend'||r.invoiceOriginalVerified===true||r.originalAmountExcludesVat===true,vat=r.incomeCategory==='dividend'||r.originalAmountExcludesVat===true?0n:vatKnown?cents(r.invoiceTax):0n;
    if(!vatKnown){issues.push(issue('other_withholding_vat_base_missing','缺发票不消灭扣缴义务；需原合同/付款资料明确非VAT金额，含税金额无法分离则列该金额缺项',r.id));continue;} requireValue(gross >= vat && vat >= 0n, 'agency_personal_invoice_invalid');
    const expense = records.find(e => e.id === r.relatedExpenseFactId && e.type === 'expense' && e.settlement === 'unpaid' && e.date <= r.date);
    if (r.incomeCategory !== 'dividend' && (!expense || cents(expense.gross) !== gross || cents(expense.invoiceTax) !== vat) || r.incomeCategory === 'dividend' && (r.distributionApproved!==true||!r.resolutionNumber||!r.paymentReference)) { issues.push(issue('other_withholding_expense_binding_missing', '本版按原发票全额清偿：需原费用应付及VAT匹配，股息需利润分配决议；部分支付另补完整核销事实', r.id)); continue; }
    if(r.incomeCategory!=='dividend'){if(settledExpenses.has(r.relatedExpenseFactId)){issues.push(issue('other_withholding_expense_already_settled','同一原费用已全额核销，不能通过不同内部付款ID再付一遍',r.id));continue;}settledExpenses.add(r.relatedExpenseFactId);}
    if(['labor','author','royalty'].includes(r.incomeCategory)&&!['one_off','continuous_same_project'].includes(r.incomeContinuity)){issues.push(issue('other_withholding_continuity_missing','依原合同核一次性所得或同项目连续性收入；仅后者按月归并，不能仅项目ID相同就默认连续',r.id));continue;}
    const event=r.incomeCategory==='dividend'?[r.bankAccountId??r.personId,r.paymentReference]:r.incomeContinuity==='one_off'?(r.incomeEventId??r.paymentReference):'monthly';
    if(!event){issues.push(issue('other_withholding_income_event_missing','一次性所得需原合同/实际支付对应的一次收入身份',r.id));continue;}
    const key = stable([r.date.slice(0, 7), r.personId, r.incomeCategory, r.incomeCategory==='dividend'?null:r.projectId, event]); if (!groups.has(key)) groups.set(key, { period: r.date.slice(0, 7), personId: r.personId, category: r.incomeCategory, projectId: r.projectId, originalGross: 0n, income: 0n, sourceRefs: [], records: [] });
    const group = groups.get(key); group.originalGross += gross; group.income += gross - vat; group.sourceRefs.push(...r.sourceRefs); group.records.push(r);
  }
  const repairBalances = new Map();
  const calculations = [...groups.values()].sort((a,b) => a.period.localeCompare(b.period)).map(g => {
    const rental = g.category.startsWith('rental_'); let deductibleTaxes = 0n, repairDeduction = 0n, repairClosing = 0n;
    if (rental) {
      if (g.records.some(r => r.rentIncomeLevyMethod !== 'actual_expense' || r.landlordIsNaturalPerson !== true || r.taxBorneByTenant !== false)) issues.push(issue('rental_pit_assessment_or_grossup_unverified', '核个人出租房屋、按实征收及未包税合同；地方核定/包税倒算未核不能套全国按实扣除', g.records[0].id));
      const key = stable([g.personId, g.projectId]); const prior = repairBalances.get(key) ?? { balance: 0n, seen: new Set(), refs: [] };
      for (const repair of records.filter(r => r.type === 'rental_repair' && r.personId === g.personId && r.projectId === g.projectId && r.date.slice(0,7) <= g.period)) {
        const identity = stable([repair.receiptIssuer, repair.receiptNumber]);
        if (!repair.receiptIssuer || !repair.receiptNumber || repair.landlordActuallyPaid !== true) { issues.push(issue('rental_repair_original_missing', '修缮扣除需出租人实际负担的修缮发票/支付原件', repair.id)); continue; }
        if (!prior.seen.has(identity)) { prior.seen.add(identity); prior.balance += cents(repair.amount); prior.refs.push(...repair.sourceRefs); }
      }
      deductibleTaxes = records.filter(r => r.type === 'personal_rental_tax' && r.personId === g.personId && r.projectId === g.projectId && r.assessmentPeriod === g.period && r.date.slice(0,7) <= g.period && r.actuallyPaid === true && ['property','urban_maintenance','education_surcharge','local_education','stamp'].includes(r.obligationId)).reduce((n,r)=>n+cents(r.amount),0n);
      repairDeduction = prior.balance < 80000n ? prior.balance : 80000n; prior.balance -= repairDeduction; repairClosing = prior.balance; repairBalances.set(key, prior); g.sourceRefs.push(...prior.refs);
    }
    const afterActualCosts = positive(g.income - deductibleTaxes - repairDeduction);
    let base = g.category === 'dividend' ? afterActualCosts : positive(afterActualCosts <= 400000n ? afterActualCosts - 80000n : rateAmount(afterActualCosts, 8000));
    if (g.category === 'author') base = rateAmount(base, 7000);
    const tax = g.category === 'labor' ? progressive(base, [[20000, 2000], [50000, 3000], [null, 4000]]) : rateAmount(base, g.category === 'rental_housing' ? 1000 : 2000);
    return { period: g.period, personId: g.personId, incomeCategory: g.category, projectId: g.projectId, originalGross: money(g.originalGross), incomeExcludingOriginalInvoiceVat: money(g.income), deductibleActuallyPaidTaxes: money(deductibleTaxes), repairDeduction: money(repairDeduction), repairCarryForward: money(repairClosing), base: money(base), withholding: money(tax), netToRecipient: money(g.originalGross - tax), relatedExpenseFactIds: g.records.map(r => r.relatedExpenseFactId), paymentFactIds: g.records.map(r => r.id), stablePaymentIdentity: hash(stable(g.records.map(r => [r.bankAccountId ?? r.personId, r.paymentReference, r.projectId]).sort())), sourceRefs: g.sourceRefs };
  }).filter(c => c.period === scope.period);
  return { calculations, due: money(calculations.reduce((n, c) => n + cents(c.withholding), 0n)), issues, sources: src(['income', 'withholding','rentalWithholding']) };
}

/** 2026/2027 national prepayment ledger replay, per project and locality. */
export function calculateAgencyVatPrepayments({ scope, entity, records }) {
  const receipts = records.filter(r => r.type === 'construction_cash' || r.type === 'construction_tax_trigger').map(r=>({...r,prepaymentKind:'construction'})), subcontract = records.filter(r => r.type === 'subcontract_payment');
  const issues=[];
  for(const lease of records.filter(r=>r.type==='rental'&&r.crossRegion===true)){
    if(lease.assetKind!=='real_estate'||lease.role!=='lessor'||!lease.propertyId||!lease.localityKey||!Array.isArray(lease.collectionSchedule)){issues.push(issue('vat_prepayment_rental_facts_missing','异地出租需不动产权属/项目、所在地及原租约收款税点；不能仅行业标签确定预缴',lease.id));continue;}
    for(const [i,row] of lease.collectionSchedule.entries()){
      try{const price=calculateAgencyRentalPrice({entity,lease,amount:row.amount,priceIncludesVat:row.priceIncludesVat,date:row.dueDate,invoiceKind:row.invoiceKind});receipts.push({...lease,id:`${lease.id}/collection/${i}`,date:row.dueDate,projectId:lease.propertyId,contractEvidence:true,taxMethod:price.simplifiedMethod?'simple':'general',simplifiedBasisVerified:price.simplifiedMethod,amountIncludingVat:price.gross,prepaymentKind:'rental',rentalPrice:price});}
      catch(error){if(!error.code)throw error;issues.push(issue(error.code,'异地出租预缴需已核租赁主体/房屋性质/原征收率及简易选择',lease.id));}
    }
  }
  const calculations = [], balances = new Map(), seen = new Set(), advances = new Map(), monthEnd = scope.period;
  const bucket=r=>entity.vatPeriod==='quarterly'?`${r.date.slice(0,4)}-${String(Math.ceil(Number(r.date.slice(5,7))/3)*3).padStart(2,'0')}`:r.date.slice(0,7);
  const months = [...new Set([...receipts, ...subcontract].filter(r=>r.date.slice(0,7)<=monthEnd).map(bucket))].sort();
  for (const month of months) {
    const rows = receipts.filter(r => bucket(r) === month && r.date.slice(0,7)<=monthEnd).sort((a,b)=>a.date.localeCompare(b.date)), groups = new Map(), localitySales = new Map();
    for (const r of rows) {
      if (!r.projectId || !r.localityKey || !r.contractEvidence || !['general', 'simple'].includes(r.taxMethod) || r.taxMethod === 'simple' && entity.vatStatus === 'general' && r.simplifiedBasisVerified !== true) { issues.push(issue('vat_prepayment_project_facts_missing', '核工程项目、预缴地、建筑合同、计税方法及简易资格原件', r.id)); continue; }
      requireValue(!seen.has(r.id), 'agency_prepayment_receipt_duplicate'); seen.add(r.id);
      const key = stable([r.projectId, r.localityKey, r.taxMethod,r.prepaymentKind]), gross = cents(r.amountIncludingVat); requireValue(gross >= 0n, 'agency_prepayment_negative_receipt');
      let amount = gross;
      if (r.type === 'construction_cash' && r.nature === 'advance') advances.set(r.id, { key, gross, used: false });
      else if (r.type === 'construction_tax_trigger') {
        requireValue(Array.isArray(r.advanceReceiptIds) && new Set(r.advanceReceiptIds).size === r.advanceReceiptIds.length, 'agency_prepayment_advance_links_required');
        for (const id of r.advanceReceiptIds) { const a = advances.get(id); requireValue(a && a.key === key && !a.used, 'agency_prepayment_advance_already_used_or_missing'); amount -= a.gross; a.used = true; }
        requireValue(amount >= 0n, 'agency_prepayment_advance_exceeds_billing');
      } else requireValue(r.type === 'construction_cash' && r.nature === 'advance' || r.crossRegion === true, 'agency_prepayment_trigger_unverified');
      const vatRate=r.prepaymentKind==='rental'?r.rentalPrice.rateBasisPoints:entity.vatStatus==='small'?100:r.taxMethod==='simple'?300:900;
      if (!groups.has(key)) groups.set(key, { projectId: r.projectId, localityKey: r.localityKey, taxMethod: r.taxMethod,prepaymentKind:r.prepaymentKind,vatRate,preRate:r.prepaymentKind==='rental'?(entity.kind==='individual_business'&&r.housing===true?r.rentalPrice.actualRateBasisPoints:entity.vatStatus==='small'?300:r.taxMethod==='simple'?500:300):entity.vatStatus==='small'?100:r.taxMethod==='simple'?300:200, gross: 0n, sourceRefs: [] });
      const group = groups.get(key); group.gross += amount; group.sourceRefs.push(...r.sourceRefs);
      requireValue(group.vatRate===vatRate,'agency_prepayment_project_rate_conflict');
      localitySales.set(r.localityKey, (localitySales.get(r.localityKey) ?? 0n) + roundRatio(amount*10000n,BigInt(10000+vatRate)));
    }
    for (const r of subcontract.filter(r => bucket(r) === month && r.date.slice(0,7)<=monthEnd)) {
      const key = stable([r.projectId, r.localityKey, r.taxMethod,'construction']); if (!groups.has(key)) groups.set(key, { projectId: r.projectId, localityKey: r.localityKey, taxMethod: r.taxMethod,prepaymentKind:'construction',vatRate:entity.vatStatus==='small'?100:r.taxMethod==='simple'?300:900,preRate:entity.vatStatus==='small'?100:r.taxMethod==='simple'?300:200,gross: 0n, sourceRefs: [] });
      if (r.invoiceCountyAndProjectVerified !== true || !r.invoiceNumber || !r.paymentReference) { issues.push(issue('vat_prepayment_subcontract_document_missing', '分包扣除需实际支付、分包合同及注明县/项目的发票原件', r.id)); continue; }
      const group = groups.get(key); group.subcontract = (group.subcontract ?? 0n) + cents(r.amount); group.sourceRefs.push(...r.sourceRefs);
    }
    for (const [key, group] of groups) {
      const input = group.gross - (group.subcontract ?? 0n) - (balances.get(key) ?? 0n),vatRate=group.vatRate,preRate=group.preRate;
      const siteSales = localitySales.get(group.localityKey) ?? 0n;
      const exempt = entity.vatStatus === 'small' && siteSales < (entity.vatPeriod==='quarterly'?30000000n:10000000n); const due = exempt ? 0n : roundRatio(positive(input) * BigInt(preRate), BigInt(10000 + vatRate));
      balances.set(key, positive(-input));
      calculations.push({ month, projectId: group.projectId, localityKey: group.localityKey, taxMethod: group.taxMethod,prepaymentKind:group.prepaymentKind,vatRateBasisPoints:vatRate,preRateBasisPoints:preRate, gross: money(group.gross), subcontractPaid: money(group.subcontract ?? 0n), priorDeductionCarry: money((group.gross - (group.subcontract ?? 0n)) - input), currentDeductionCarry: money(balances.get(key)), localSalesExcludingVat: money(siteSales), exemptBelowThreshold: exempt,status:month>scope.period?'pending_period_end':'calculated', due: money(due), sourceRefs: group.sourceRefs });
    }
  }
  return { version: 'agency-vat-prepayment/1', calculations, issues,pendingPeriodEnd:calculations.some(c=>c.status==='pending_period_end'), currentDue: money(calculations.filter(c => c.month === scope.period).reduce((n, c) => n + cents(c.due), 0n)), closingDeductionBalances: [...balances].map(([key, amount]) => ({ projectLocalityMethod: JSON.parse(key), amount: money(amount) })), sources: src(['prepayment', 'vatRelief']), submittable: false };
}
function regional(ruleId, entity, period) {
  const rule = listAgencyRegionalRules().find(r => r.ruleId === ruleId && r.region === entity.region && period >= r.from && period <= r.through && r.entityKinds.includes(entity.kind));
  return rule ?? null;
}

/** Original vehicle invoice and qualified model evidence; never a caller-prepared tax. */
export function calculateAgencyVehicleAcquisition({entity,record:r,records=[]}){
  requireValue(r.type==='vehicle_acquisition'&&r.selfUse===true&&r.ownershipVerified===true&&r.businessUseConfirmed===true&&r.acquisitionMethod==='purchase'&&['car','tram','trailer','motorcycle'].includes(r.vehicleKind)&&typeof r.alreadyTaxed==='boolean'&&r.specialExemption==='none','agency_vehicle_acquisition_facts_missing');
  requireValue(typeof r.vin==='string'&&r.vin.length===17&&r.invoiceOriginalVerified===true&&r.invoiceNumber&&r.invoiceIssuedOn===r.date&&['paid','unpaid'].includes(r.settlement)&&['deductible','non_deductible'].includes(r.inputVatTreatment),'agency_vehicle_invoice_missing');
  const gross=cents(r.invoiceGross),vat=cents(r.invoiceVat),base=gross-vat;requireValue(base>0n&&vat>=0n,'agency_vehicle_invoice_invalid');
  let normal=rateAmount(base,1000),relief=0n,reason='境内购买自用应税车辆按原发票不含VAT金额×10%';
  if(r.vehicleKind==='motorcycle')requireValue(Number.isSafeInteger(r.engineCapacityMl),'agency_vehicle_engine_capacity_missing');
  if(r.alreadyTaxed||r.vehicleKind==='motorcycle'&&r.engineCapacityMl<=150){normal=0n;reason=r.alreadyTaxed?'原已征车购税凭证及车辆身份已核，一次性征收不重复征':'排量不超过150毫升摩托车不属车购税应税车辆';}
  else{requireValue(typeof r.newEnergy==='boolean','agency_vehicle_energy_type_missing');if(r.newEnergy){const catalogue=records.find(c=>c.type==='vehicle_catalogue_entry'&&c.model===r.vehicleModel&&c.edition==='2026-2027'&&c.issuedBy==='MIIT'&&c.publicationNumber&&c.validFrom<=r.date&&c.validThrough>=r.date&&c.technicalRequirements2025No24Met===true);requireValue(catalogue&&r.vehicleCertificateModel===r.vehicleModel&&typeof r.passengerVehicle==='boolean','agency_vehicle_current_catalogue_missing');relief=roundRatio(normal,2n);if(r.passengerVehicle&&relief>1500000n)relief=1500000n;reason='2026—2027有效目录车型及合格证匹配，法定车购税减半，新能源乘用车减税上限每辆15000';}}
  if(r.alreadyTaxed)requireValue(r.priorTaxReceiptNumber&&r.priorTaxReceiptVerified===true,'agency_vehicle_prior_tax_receipt_missing');
  const due=normal-relief,deductible=entity.vatStatus==='general'&&r.inputVatTreatment==='deductible',assetCost=base+(deductible?0n:vat)+due;
  return {factId:r.id,vin:r.vin,base:money(base),invoiceGross:money(gross),invoiceVat:money(vat),normalTax:money(normal),relief:money(relief),due:money(due),deductibleInputVat:money(deductible?vat:0n),assetCost:money(assetCost),reason,sourceRefs:r.sourceRefs,sources:src(['vehiclePurchase','electricVehicle','electricVehicle2026'])};
}

/** Already established unions: statutory allocation is distinct from tax-office collection. */
export function calculateAgencyUnionFees({scope,records,basis='payment'}){
  requireValue(['payment','service_accrual'].includes(basis),'agency_union_basis_invalid');
  const organizations=records.filter(r=>r.type==='union'&&r.date.slice(0,7)<=scope.period),calculations=[],issues=[],payments=records.filter(r=>r.type==='union_payment'&&r.date.slice(0,7)===scope.period);
  if(!organizations.length&&!payments.length)return {calculations,issues,due:'0.00',payments:[]};
  if(organizations.length!==1||organizations[0].established!==true||!organizations[0].organizationNumber){issues.push(issue('union_establishment_or_regional_preparation_missing','已有原付款必须保留；建会/筹备及归属未核，不能忽略银行支出或全国套2%',payments[0]?.id));return {calculations,issues,due:null,payments};}
  const organization=organizations[0];
  for(const r of records.filter(r=>r.type==='payroll'&&(basis==='service_accrual'?r.date.slice(0,7)===scope.period:r.paid===true&&(r.paymentDate??r.date).slice(0,7)===scope.period))){
    if(basis==='service_accrual'&&(r.paid!==true||(r.paymentDate??r.date).slice(0,7)!==r.date.slice(0,7))){const a=r.unionAccrualAllocation,located=a&&(r.originalRefs?.some(ref=>ref.locator===a.originalLocator)||r.sourceRefs?.some(ref=>ref.locator===a.originalLocator));if(!(a?.serviceVerified===true&&a.benefitPeriod===scope.period&&a.use===r.use&&(!['production','contract'].includes(r.use)||a.jobId===r.jobId)&&a.reason?.trim()&&located)){issues.push(issue('union_service_accrual_allocation_missing','未付/跨月工资的工会会计预提须原劳动/考勤岗位受益期定位及判断理由；拨缴月不代替成本归属，缺项不能倒灌已记期间',r.id));continue;}}
    if(!r.components.every(c=>['included','excluded'].includes(c.unionWageTreatment)&& (c.unionWageTreatment==='included'||c.exclusionReason))){issues.push(issue('union_wage_components_missing','按原工资组成核统计工资总额纳入/排除性质；个人税社公代扣不扣出基数，不能使用净薪或客户预制工资总额',r.id));continue;}
    const wage=r.components.filter(c=>c.unionWageTreatment==='included').reduce((n,c)=>n+cents(c.amount),0n);calculations.push({factId:r.id,employeeId:r.employeeId,use:r.use,jobId:r.jobId??null,organizationNumber:organization.organizationNumber,basis,benefitPeriod:basis==='service_accrual'?scope.period:null,paymentPeriod:r.paid===true?(r.paymentDate??r.date).slice(0,7):null,wages:money(wage),due:money(rateAmount(wage,200)),sourceRefs:[...r.sourceRefs,...organization.sourceRefs]});
  }
  // One aggregate statutory base; deterministic cumulative differences distribute cents.
  calculations.sort((a,b)=>String(a.employeeId).localeCompare(String(b.employeeId))||a.factId.localeCompare(b.factId));
  let running=0n,allocated=0n;for(const c of calculations){running+=cents(c.wages);const target=rateAmount(running,200);c.due=money(target-allocated);allocated=target;}
  for(const p of payments)if(p.organizationNumber!==organization.organizationNumber||!p.paymentReference||!p.bankAccountId||!/^20\d\d-\d\d$/.test(p.assessmentPeriod??'')||cents(p.amount)<0n)issues.push(issue('union_payment_evidence_missing','实拨须工会组织、所属期、银行流水及合法工会收入收据/税务代收凭证；返还不自动冲企业费用',p.id));
  return {calculations,issues,due:issues.length?null:money(allocated),knownCalculatedSubtotal:money(allocated),payments,organizationNumber:organization.organizationNumber};
}

export function calculateAgencyOldPropertyAppreciation({record:r}){
  requireValue(r.type==='property_disposal'&&r.disposalKind==='old_commercial_property'&&r.transferIsPaid===true&&r.assetOwnershipVerified===true&&r.domesticStateOwnedLand===true&&r.specialRelief==='none'&&r.finalTaxMethod==='assessed_appraisal','agency_land_appreciation_method_missing');
  requireValue(r.saleInvoiceOriginalVerified===true&&r.saleInvoiceNumber&&r.appraisal?.assessmentConfirmationNumber&&r.appraisal?.issuerApproved===true&&r.appraisal?.confirmedByTaxAuthority===true&&Array.isArray(r.landPayments)&&r.landPayments.length>0&&r.landPayments.every(p=>p.originalDocumentNumber&&p.actuallyPaid===true)&&Array.isArray(r.relatedTaxReceipts),'agency_land_appreciation_originals_missing');
  requireValue(new Set(r.landPayments.map(p=>p.originalDocumentNumber)).size===r.landPayments.length&&r.landPayments.every(p=>cents(p.amount)>=0n)&&new Set(r.relatedTaxReceipts.map(p=>p.receiptNumber)).size===r.relatedTaxReceipts.length,'agency_land_appreciation_original_duplicate_or_negative');
  const income=cents(r.saleGross)-cents(r.saleInvoiceVat),condition=quantity(r.appraisal.conditionRatio),replacement=cents(r.appraisal.replacementCost);requireValue(income>=0n&&condition<=1000000n&&replacement>=0n,'agency_land_appreciation_amount_invalid');
  const land=r.landPayments.reduce((n,p)=>n+cents(p.amount),0n),appraisal=roundRatio(replacement*condition,1000000n);let taxes=0n;
  for(const p of r.relatedTaxReceipts){requireValue(['urban_maintenance','education_surcharge','local_education','stamp'].includes(p.obligationId)&&p.receiptNumber&&p.actuallyPaid===true&&p.relatedToThisProperty===true&&cents(p.amount)>=0n,'agency_land_appreciation_tax_receipt_invalid');taxes+=cents(p.amount);}
  const deduction=land+appraisal+taxes,increment=income-deduction;requireValue(deduction>0n&&land>=0n,'agency_land_appreciation_deduction_invalid');let rate=3000,quick=0;
  if(increment>deduction*2n){rate=6000;quick=3500;}else if(increment>deduction){rate=5000;quick=1500;}else if(increment*2n>deduction){rate=4000;quick=500;}
  const due=increment<=0n?0n:roundRatio(increment*BigInt(rate)-deduction*BigInt(quick),10000n);
  return {factId:r.id,propertyId:r.propertyId,projectId:r.projectId,income:money(income),landPaid:money(land),confirmedAppraisal:money(appraisal),relatedActuallyPaidTaxes:money(taxes),deduction:money(deduction),increment:money(increment),rateBasisPoints:rate,quickDeductionBasisPoints:quick,due:money(due),rounding:'法定速扣式合并后仅在最终税额舍入到分',sourceRefs:r.sourceRefs,sources:src(['landAppreciation','landAppreciation2026'])};
}

/** A tax assessment object is established by original scope evidence, never projectId alone. */
export function calculateAgencyLandAppreciationUnits({scope,records}) {
  const globalParts=new Map();
  const transfers=records.filter(r=>r.type==='property_disposal'&&r.date.slice(0,7)<=scope.period),units=records.filter(r=>r.type==='land_appreciation_unit'&&r.date.slice(0,7)<=scope.period),calculations=[],allocations=[],issues=[],interim=[],claimed=new Set();
  const located=(r,p)=>typeof p==='string'&&p.length>0&&(Array.isArray(r.originalRefs)?r.originalRefs.some(x=>x.locator===p):r.sourceRefs?.some(x=>x.locator===p));
  const keys=xs=>[...new Set(xs)].sort(),same=(a,b)=>stable(keys(a))===stable(keys(b));
  for(const u of units){try{
    requireValue(u.unitId&&u.projectId&&u.scopeBasis==='tax_authority_confirmed_basic_object'&&u.confirmedByTaxAuthority===true&&u.documentNumber&&located(u,u.originalLocator)&&u.classificationReason?.trim()&&u.inventoryReason?.trim()&&u.inventoryComplete===true&&Array.isArray(u.propertyIds)&&u.propertyIds.length&&Array.isArray(u.transferFactIds)&&u.transferFactIds.length&&new Set(u.transferFactIds).size===u.transferFactIds.length,'agency_land_basic_unit_scope_missing');
    const final=u.finalAssessment;requireValue(final?.basis==='competent_tax_authority_written_final_assessment'&&final.noticeNumber&&final.authorityName&&/^202[67]-(0[1-9]|1[0-2])$/.test(final.period??'')&&located(u,final.originalLocator)&&/^https:\/\/[^/]+\.gov\.cn\//.test(final.legalReference??'')&&final.reason?.trim(),'agency_land_final_assessment_basis_missing');
    const members=transfers.filter(r=>u.transferFactIds.includes(r.id));requireValue(members.every(r=>r.projectId===u.projectId&&u.propertyIds.includes(r.propertyId)&&!claimed.has(r.id)),'agency_land_basic_unit_membership_conflict');members.forEach(r=>claimed.add(r.id));
    if(scope.period<final.period){const d=u.interimDeterminations?.find(d=>d.period===scope.period);requireValue(d&&d.authorityDocumentNumber&&located(u,d.originalLocator)&&d.reason?.trim()&&['no_prepayment_required','official_prepayment_notice'].includes(d.determination),'agency_land_interim_obligation_unresolved');const due=d.determination==='no_prepayment_required'?0n:cents(d.notifiedDue);requireValue(due>=0n,'agency_land_interim_amount_invalid');interim.push({unitId:u.unitId,projectId:u.projectId,period:scope.period,due:money(due),reason:d.reason,authorityDocumentNumber:d.authorityDocumentNumber,sourceRefs:u.sourceRefs});continue;}
    requireValue(members.length===u.transferFactIds.length&&same(members.map(r=>r.propertyId),u.propertyIds)&&!transfers.some(r=>r.landAppreciationUnitId===u.unitId&&!u.transferFactIds.includes(r.id)),'agency_land_basic_unit_transfer_inventory_incomplete');
    const parts=new Map(),docs=new Map();let income=0n;
    const addPart=(kind,number,detail,properties,amount,originalLocator,basisDetails=null)=>{requireValue(number&&Array.isArray(properties)&&properties.length&&properties.every(id=>u.propertyIds.includes(id))&&located(u,originalLocator)&&amount>=0n,'agency_land_deduction_original_scope_missing');const documentKey=stable([kind,number]),key=stable([kind,number,detail??'document-total']),value={kind,number,detail:detail??null,properties:keys(properties),amount:money(amount),basisDetails},old=parts.get(key),other=docs.get(documentKey)??[];requireValue(!old||stable(old)===stable(value),'agency_land_deduction_original_conflict');requireValue(!other.some(x=>(x.detail===null||value.detail===null)&&x.detail!==value.detail),'agency_land_deduction_total_and_lines_overlap');const global=globalParts.get(key);requireValue(!global||global.unitId===u.unitId&&stable(global.value)===stable(value),'agency_land_deduction_cross_unit_scope_conflict');globalParts.set(key,{unitId:u.unitId,value});parts.set(key,value);if(!old){other.push(value);docs.set(documentKey,other);}};
    for(const r of members){calculateAgencyOldPropertyAppreciation({record:r});income+=cents(r.saleGross)-cents(r.saleInvoiceVat);for(const p of r.landPayments)addPart('land',p.originalDocumentNumber,p.detailKey,p.propertyIds,cents(p.amount),p.originalLocator);const a=r.appraisal;addPart('appraisal',a.assessmentConfirmationNumber,a.detailKey,a.propertyIds,roundRatio(cents(a.replacementCost)*quantity(a.conditionRatio),1000000n),a.originalLocator,{replacementCost:a.replacementCost,conditionRatio:a.conditionRatio});for(const p of r.relatedTaxReceipts)addPart('tax',p.receiptNumber,p.detailKey,p.propertyIds,cents(p.amount),p.originalLocator);}
    requireValue(same([...parts.values()].filter(p=>p.kind==='land').map(p=>p.number),u.landDocumentNumbers??[])&&same([...parts.values()].filter(p=>p.kind==='appraisal').map(p=>`${p.number}#${p.detail??'document-total'}`),u.appraisalLineIdentities??[])&&same([...parts.values()].filter(p=>p.kind==='tax').map(p=>`${p.number}#${p.detail??'document-total'}`),u.taxReceiptLineIdentities??[]),'agency_land_basic_unit_deduction_inventory_incomplete');
    const deduction=[...parts.values()].reduce((n,p)=>n+cents(p.amount),0n),increment=income-deduction;requireValue(deduction>0n&&income>=0n,'agency_land_appreciation_deduction_invalid');let rate=3000,quick=0;if(increment>deduction*2n){rate=6000;quick=3500;}else if(increment>deduction){rate=5000;quick=1500;}else if(increment*2n>deduction){rate=4000;quick=500;}const due=increment<=0n?0n:roundRatio(increment*BigInt(rate)-deduction*BigInt(quick),10000n);
    let running=0n,allocated=0n;const shares=[];for(const r of [...members].sort((a,b)=>stable(a.businessIdentity).localeCompare(stable(b.businessIdentity)))){const net=cents(r.saleGross)-cents(r.saleInvoiceVat);running+=net;const target=income?roundRatio(due*running,income):0n,part=target-allocated;allocated=target;shares.push({factId:r.id,propertyId:r.propertyId,projectId:u.projectId,unitId:u.unitId,period:final.period,due:money(part),sourceRefs:[...u.sourceRefs,...r.sourceRefs]});}
    calculations.push({unitId:u.unitId,projectId:u.projectId,propertyIds:keys(u.propertyIds),period:final.period,income:money(income),deduction:money(deduction),increment:money(increment),rateBasisPoints:rate,quickDeductionBasisPoints:quick,due:money(due),deductionOriginals:[...parts.values()],allocations:shares,rounding:'原基本核算对象先汇总速扣，按原净收入稳定累计差分分摊，分笔负收益不单独归零',finalAssessment:final,sourceRefs:[...u.sourceRefs,...members.flatMap(r=>r.sourceRefs)]});if(final.period===scope.period)allocations.push(...shares);
  }catch(error){if(!error.code)throw error;issues.push(issue(error.code,'原基本核算对象/权属范围、完整收入扣除清单、分期义务或主管最终所属期依据不足/冲突；不按projectId猜并或逐笔计算',u.id));}}
  for(const r of transfers.filter(r=>!claimed.has(r.id))){if(units.some(u=>u.transferFactIds?.includes(r.id)))continue;if(transfers.filter(t=>t.projectId===r.projectId||t.propertyId===r.propertyId).length>1||r.landAppreciationUnitId||transfers.some(t=>t!==r&&((t.landPayments??[]).some(p=>(r.landPayments??[]).some(q=>q.originalDocumentNumber===p.originalDocumentNumber))||t.appraisal?.assessmentConfirmationNumber===r.appraisal?.assessmentConfirmationNumber))){issues.push(issue('agency_land_basic_unit_scope_missing','多原出售事实须原基本项目/对象确认及完整清单；同projectId不能证明合并，同对象不能逐笔独立归零',r.id));continue;}try{const c={...calculateAgencyOldPropertyAppreciation({record:r}),unitId:`property:${r.propertyId}`,period:r.date.slice(0,7)};calculations.push(c);if(c.period===scope.period)allocations.push(c);}catch(error){if(!error.code)throw error;issues.push(issue(error.code,'单体旧商房原收入、确认评估、土地及实际相关税原件不完整',r.id));}}
  return {calculations,allocations,interim,issues};
}

export function calculateAgencyCulturalFee({scope,entity,accounting,records}){
  const from=entity.vatPeriod==='quarterly'?`${scope.period.slice(0,4)}-${String(Math.floor((Number(scope.period.slice(5))-1)/3)*3+1).padStart(2,'0')}`:scope.period,activities=records.filter(r=>['advertising','entertainment'].includes(r.type)&&r.date.slice(0,7)>=from&&r.date.slice(0,7)<=scope.period),calculations=[],issues=[],usedRevenue=new Set(),usedPublicationPayments=new Set(),taxpayerSales=accounting.vatTransactions.filter(t=>t.date.slice(0,7)>=from&&t.date.slice(0,7)<=scope.period).reduce((n,t)=>n+cents(t.net),0n);
  for(const r of activities){
    if(!['monthly','quarterly'].includes(entity.vatPeriod)){issues.push(issue('cultural_tax_period_unverified','文建随VAT纳税期限，缺原认定月/季不默认月度',r.id));continue;}
    if(r.direction==='purchased'){calculations.push({factId:r.id,status:'not_applicable',reason:'本企业仅采购广告/娱乐服务，不因自身支付费用成为提供方文建缴费人',due:'0.00',sourceRefs:r.sourceRefs});continue;}
    if(r.type==='advertising'&&entity.kind==='individual_business'){calculations.push({factId:r.id,status:'not_applicable',reason:'个体提供广告服务不属财税2016第25号广告媒介单位范围；与娱乐服务单位和个人范围区别',due:'0.00',sourceRefs:r.sourceRefs});continue;}
    if(r.direction!=='provided'||r.type==='advertising'&&!(r.contractServiceClassificationVerified===true&&['media','outdoor','advertising_agency'].includes(r.advertisingServiceKind))){issues.push(issue('cultural_service_scope_missing','根据原合同确认媒介/户外/广告代理；第12条包含广告代理单位，纯设计不能凭名称推定，采购与提供分开',r.id));continue;}
    requireValue(Array.isArray(r.revenueFactIds)&&r.revenueFactIds.length>0&&new Set(r.revenueFactIds).size===r.revenueFactIds.length,'agency_cultural_revenue_link_invalid');
    const priorActivity=records.find(a=>['advertising','entertainment'].includes(a.type)&&a.direction==='provided'&&a.date.slice(0,7)<from&&(a.revenueFactIds??[]).some(id=>r.revenueFactIds.includes(id)));
    if(priorActivity){issues.push(issue('cultural_revenue_already_consumed','同一原收入已由历史税期activity消费；补件须回原VAT义务税期更正重放，不能换activity在新税期再征',r.id));continue;}
    if(r.revenueFactIds.some(id=>usedRevenue.has(id))){issues.push(issue('cultural_revenue_already_consumed','同一原收入不能挂到不同activity重复计费',r.id));continue;}r.revenueFactIds.forEach(id=>usedRevenue.add(id));
    const transactions=accounting.vatTransactions.filter(t=>r.revenueFactIds.includes(t.factId)&&t.date.slice(0,7)>=from&&t.date.slice(0,7)<=scope.period);
    if(transactions.length!==r.revenueFactIds.length){issues.push(issue('cultural_revenue_original_missing','文建收入应与本企业原合同/验收/含税价及已核VAT原事实逐项关联，不接受调用方直接给计费销售总额',r.id));continue;}
    const gross=transactions.reduce((n,t)=>n+cents(t.net)+cents(t.tax),0n),sales=transactions.reduce((n,t)=>n+cents(t.net),0n),publication=(r.publicationPayments??[]);let deducted=0n;
    if(r.type==='advertising')for(const p of publication){
      const expense=records.find(e=>e.id===p.expenseFactId&&e.type==='expense');if(!(p.legalPublicationInvoiceVerified===true&&p.invoiceNumber&&p.publisherIdentity&&expense))continue;
      const bankRows=expense.settlement==='paid'?[{...expense,amount:expense.gross,bankReference:expense.bankReference??expense.businessIdentity?.documentNumber}]:records.filter(e=>e.type==='supplier_payment'&&e.relatedFactId===p.expenseFactId),selected=bankRows.filter(b=>b.date.slice(0,7)<=scope.period&&(!p.paymentReferences||p.paymentReferences.includes(b.bankReference)));
      if(p.paymentReferences&&(!Array.isArray(p.paymentReferences)||new Set(p.paymentReferences).size!==p.paymentReferences.length||p.paymentReferences.some(ref=>!selected.some(b=>b.bankReference===ref)))){issues.push(issue('cultural_publication_payment_reference_missing','按原银行流水选实际分期支付，不能自报可扣总额',r.id));continue;}
      for(const bank of selected){const identity=stable([bank.bankAccountId??expense.businessIdentity?.issuerKey,bank.bankReference]);const priorUse=records.some(a=>a.type==='advertising'&&a.date.slice(0,7)<from&&bank.date.slice(0,7)<from&&(a.publicationPayments??[]).some(prior=>prior.expenseFactId===p.expenseFactId&&(!prior.paymentReferences||prior.paymentReferences.includes(bank.bankReference))));if(usedPublicationPayments.has(identity)||priorUse){issues.push(issue('cultural_publication_payment_reused','同一实际支付不能跨activity/期间再次扣除，分期按各原银行流水唯一分配',r.id));continue;}usedPublicationPayments.add(identity);deducted+=cents(bank.amount);}
      requireValue(selected.reduce((n,b)=>n+cents(b.amount),0n)<=cents(expense.gross),'agency_cultural_publication_paid_excess');
    }
    requireValue(deducted<=gross&&new Set(publication.map(p=>p.expenseFactId)).size===publication.length,'agency_cultural_deduction_duplicate_or_excess');
    const base=gross-deducted,normal=rateAmount(base,300),smallExempt=entity.vatStatus==='small'&&(r.type==='advertising'?taxpayerSales<=(entity.vatPeriod==='quarterly'?6000000n:2000000n):taxpayerSales<(entity.vatPeriod==='quarterly'?30000000n:10000000n));
    const failedSales=accounting.issues.some(i=>['sale','sale_return','platform_settlement','service_complete','transport_complete','property_service_complete','construction_billing','rental','property_disposal'].includes(records.find(f=>f.id===i.factId)?.type));
    if(failedSales||smallExempt&&(!accounting.accountingCoverageVerified||from<accounting.replayFrom)){issues.push(issue('cultural_tax_period_sales_incomplete','销售/未开票及税期覆盖存在缺件或会计失败，已知销售小计不能断言纳税人整期免征；补件原税期重放',r.id));calculations.push({factId:r.id,status:'trial_only',base:money(base),normalFee:money(normal),due:null,sourceRefs:r.sourceRefs});continue;}
    if(smallExempt){calculations.push({factId:r.id,status:'calculated',base:money(base),normalFee:money(normal),due:'0.00',reason:r.type==='advertising'?'广告小规模单位月销售额≤2万/季≤6万免征':'No60未达VAT起征点，结合2026No10月10万/季30万严格未达；不是疫情优惠',sourceRefs:[...r.sourceRefs,...transactions.flatMap(t=>t.sourceRefs)]});continue;}
    if(r.budgetAttribution!=='central'||r.budgetAttributionBasis!=='official_budget_classification_notice'||!r.budgetNoticeNumber){issues.push(issue('cultural_budget_or_local_relief_missing','法定3%初始计费额已算；预算归属须原认定，娱乐不得仅按企业中央属性猜中央收入；地方减征幅度另核，不假定减半/无减免',r.id));calculations.push({factId:r.id,status:'trial_only',base:money(base),normalFee:money(normal),due:null,sourceRefs:r.sourceRefs});continue;}
    calculations.push({factId:r.id,status:'calculated',base:money(base),gross:money(gross),publicationDeduction:money(deducted),normalFee:money(normal),due:null,budgetAttribution:'central',budgetNoticeNumber:r.budgetNoticeNumber,reason:'原预算归属为中央收入，2025—2027按全国规定减征50%；不将中央股东身份单独充作预算认定',sourceRefs:[...r.sourceRefs,...transactions.flatMap(t=>t.sourceRefs),...publication.flatMap(p=>records.find(e=>e.id===p.expenseFactId)?.sourceRefs??[])]});
  }
  // Taxpayer-period and budget bucket are the assessment unit, not each Agent activity.
  // Allocate rounded aggregate cents by deterministic cumulative differences.
  const central=calculations.filter(c=>c.status==='calculated'&&c.budgetAttribution==='central').sort((a,b)=>a.factId.localeCompare(b.factId));
  let aggregateBase=0n,allocatedNormal=0n,allocatedDue=0n;
  for(const c of central){aggregateBase+=cents(c.base);const normal=rateAmount(aggregateBase,300),due=roundRatio(normal,2n);c.normalFee=money(normal-allocatedNormal);c.due=money(due-allocatedDue);c.rounding='纳税人同税期同预算收入先汇总3%计费、再减半，按稳定事实顺序累计差分分配到分';allocatedNormal=normal;allocatedDue=due;}
  const knownCalculatedSubtotal=money(calculations.filter(c=>c.due!==null).reduce((n,c)=>n+cents(c.due),0n));
  return {calculations,issues,due:issues.length?null:knownCalculatedSubtotal,knownCalculatedSubtotal,allNotApplicable:calculations.length>0&&calculations.every(c=>c.status==='not_applicable'),pendingPeriodEnd:entity.vatPeriod==='quarterly'&&Number(scope.period.slice(5))%3!==0&&activities.some(r=>r.direction==='provided')};
}

/** accounting is produced by evaluateAgencyAccounting, not customer taxable income. */
export function calculateAgencyObligations({ scope, entity, accounting, records, annual = false }) {
  const obligations = [], issues = [], payroll = [], entries = [];
  const current = records.filter(r => r.date?.slice(0, 7) <= scope.period && r.date?.slice(0, 4) === scope.period.slice(0, 4));
  const periodRows = current.filter(r => r.date.slice(0, 7) === scope.period);
  const add = (id, status, reason, values = {}, sourceKeys = []) => { const row = { obligationId: id, status, reason, ...values, sources: src(sourceKeys), sourceRefs: values.sourceRefs ?? [] }; obligations.push(row); if (['missing', 'unknown', 'uncovered'].includes(status)) issues.push(issue(`${id}_${status}`, reason, id)); return row; };
  const inventory = records.find(r => r.type === 'obligation_inventory');
  const answer = id => inventory?.activities?.[id];
  const refs = rows => rows.flatMap(r => r.sourceRefs ?? []);
  const absent = (id, trigger, reason) => { const a = answer(id); if (trigger || a?.present === true) return false; if (a?.present === false && typeof a.reason === 'string' && a.reason.length && a.sourceRefs?.length) { add(id, 'not_applicable', a.reason, { sourceRefs: a.sourceRefs }); return true; } add(id, 'missing', reason ?? `提供${id}对应资产、交易、用工及适用情况的原始资料，未答不能当不适用`); return true; };
  const paidRows = periodRows.filter(r => r.type === 'tax_payment');
  const payment = (id, cumulative = false) => (cumulative ? current : paidRows).filter(r => r.type === 'tax_payment' && r.obligationId === id && (cumulative ? r.assessmentYear === scope.period.slice(0, 4) : r.assessmentPeriod === scope.period));
  const settlement = (id, due, sourceKeys, reason, extra = {}) => {
    const unallocated = paidRows.filter(r => r.obligationId === id && (extra.cumulative ? !/^20\d\d$/.test(r.assessmentYear ?? '') : !/^20\d\d-\d\d$/.test(r.assessmentPeriod ?? '')));
    if (unallocated.length) issues.push(issue(`${id}_payment_allocation_missing`, '原完税/缴费凭证须税款所属期或所属年度及预缴项目；付款日不能代替税期，未分配金额不抵本期应缴', id));
    const paid = sum(payment(id, extra.cumulative === true), 'amount');
    return add(id, 'calculated', reason, { due: money(due), paid: money(paid), difference: money(due - paid), paymentState: payment(id, extra.cumulative === true).length ? paid === due ? 'matched' : 'difference' : 'payment_evidence_missing', ...extra }, sourceKeys);
  };
  const qStart = `${scope.period.slice(0, 4)}-${String(Math.floor((Number(scope.period.slice(5)) - 1) / 3) * 3 + 1).padStart(2, '0')}`;
  const vatFrom = entity.vatPeriod === 'quarterly' ? qStart : scope.period, vatOutput = accounting.vatTransactions.filter(t => t.date.slice(0, 7) >= vatFrom && t.date.slice(0, 7) <= scope.period);
  const output = vatOutput;
  const totalNet = output.reduce((n, t) => n + cents(t.net), 0n), outputTax = output.reduce((n, t) => n + cents(t.tax), 0n);
  let vatDue = null,vatLiabilityReplay=[];
  const outputKinds=new Set(['sale','sale_return','platform_settlement','service_complete','transport_complete','property_service_complete','construction_billing','rental','property_disposal']);
  const vatScopeUnknown = accounting.issues.some(i => i.code === 'agency_vat_transaction_scope_unverified'||outputKinds.has(records.find(r=>r.id===i.factId)?.type)) || current.some(r => r.type === 'import_export' || r.crossBorder === true || r.specialVatTreatment && r.specialVatTreatment !== 'ordinary');
  if (vatScopeUnknown) add('vat', 'missing', '原件存在跨境/进出口/零税率/免税/差额/特殊简易标记或境内发生事实未核，不能套普通税率；关联附加与所得税影响待核', {}, ['vat']);
  else if (!absent('vat', output.length > 0 || ['small', 'general'].includes(entity.vatStatus), '补齐销售、未开票、红字、视同销售、进口和适用免税交易资料')) {
    if (!['monthly', 'quarterly'].includes(entity.vatPeriod)) add('vat', 'missing', '提供主管税务机关核定月/季计税期间，不由行业猜定', { sourceRefs: refs(output) }, ['vat']);
    else if (entity.vatPeriod === 'quarterly' && Number(scope.period.slice(5)) % 3 !== 0) add('vat', 'pending_period_end', '已归集季度销售事实，待本季全部原件齐备后按季计算，不以单月推报季度', { taxableSalesSoFar: money(totalNet), sourceRefs: refs(output) }, ['vat', 'vatRelief']);
    else if (!accounting.accountingCoverageVerified || vatFrom < accounting.replayFrom || !current.some(r => r.type === 'period_coverage' && r.period === scope.period && r.complete === true)) add('vat', 'missing', '补齐计税期间销售/未开票/银行及来源覆盖证据，缺原件不能当零', {}, ['vat']);
    else if (entity.vatStatus === 'small') {
      const special = output.filter(t => t.invoiceKind === 'special').reduce((n, t) => n + cents(t.tax), 0n);
      const threshold = entity.vatPeriod === 'quarterly' ? 30000000n : 10000000n; vatDue = totalNet < threshold ? special : outputTax;
      const step=entity.vatPeriod==='quarterly'?3:1;
      for(let end=step;end<=Number(scope.period.slice(5));end+=step){const from=`${scope.period.slice(0,4)}-${String(end-step+1).padStart(2,'0')}`,through=`${scope.period.slice(0,4)}-${String(end).padStart(2,'0')}`;if(from<accounting.replayFrom)continue;const tx=accounting.vatTransactions.filter(t=>t.date.slice(0,7)>=from&&t.date.slice(0,7)<=through),net=sum(tx,'net'),due=net<threshold?sum(tx.filter(t=>t.invoiceKind==='special'),'tax'):sum(tx,'tax');vatLiabilityReplay.push({from,through,due:money(due)});}
      settlement('vat', vatDue, ['vat', 'vatRelief'], '2026月10万元/季30万元未达到起征点免征；达到全额计算，专票不随普通免税默认免征', { taxableSales: money(totalNet), initialOutput: money(outputTax), exemption: money(outputTax - vatDue), sourceRefs: refs(output), vatPeriodFrom: vatFrom, vatPeriodThrough: scope.period });
    } else if (entity.vatStatus === 'general') {
      const inputs = records.filter(r => ['purchase', 'expense', 'input_vat_adjustment'].includes(r.type) && r.date.slice(0, 7) <= scope.period);
      for(const lease of records.filter(r=>r.type==='lease_lessee'&&r.inputVatTreatment==='deductible'))for(const [index,s] of (lease.paymentSchedule??[]).entries())if(s.invoiceCertified===true&&(s.certifiedDate??s.dueDate).slice(0,7)<=scope.period)inputs.push({id:`${lease.id}/invoice/${index}`,type:'lease_invoice',date:s.dueDate,inputVatTreatment:'deductible',certifiedDate:s.certifiedDate,invoiceTax:s.invoiceTax,sourceRefs:lease.sourceRefs});
      for(const r of records.filter(r=>r.type==='vehicle_acquisition'&&r.inputVatTreatment==='deductible'&&r.date.slice(0,7)<=scope.period))inputs.push({id:r.id,type:'vehicle_invoice',date:r.date,inputVatTreatment:'deductible',certifiedDate:r.certifiedDate,invoiceTax:r.invoiceVat,sourceRefs:r.sourceRefs});
      const creditFrom=accounting.replayFrom > `${scope.period.slice(0,4)}-01` ? accounting.replayFrom : `${scope.period.slice(0,4)}-01`;
      const openings = records.filter(r => r.type === 'opening_vat' && r.asOfPeriod === creditFrom);
      if (inputs.some(r => r.invoiceTax===undefined||!['deductible', 'non_deductible', 'transfer_out'].includes(r.inputVatTreatment) || r.inputVatTreatment === 'deductible' && !/^20\d\d-\d\d-\d\d$/.test(r.certifiedDate ?? '')) || openings.length !== 1 || openings[0].declarationVerified !== true) add('vat', 'missing', '一般纳税人需要逐票抵扣资格/用途/认证日期，以及留抵重放起点的已核期初申报资料；按认证期完整滚算，不重复使用开账额', {}, ['vat']);
      else {
        let carry = cents(openings[0].amount); requireValue(carry >= 0n, 'agency_opening_vat_negative'); const replay = [];
        const step = entity.vatPeriod === 'quarterly' ? 3 : 1;
        for (let end = step; end <= Number(scope.period.slice(5)); end += step) {
          if(end<Number(creditFrom.slice(5)))continue;
          const from = `${scope.period.slice(0, 4)}-${String(end - step + 1).padStart(2, '0')}`, through = `${scope.period.slice(0, 4)}-${String(end).padStart(2, '0')}`;
          const transactions = accounting.vatTransactions.filter(t => t.date.slice(0, 7) >= from && t.date.slice(0, 7) <= through), eligible = inputs.filter(r => r.inputVatTreatment === 'deductible' && r.certifiedDate.slice(0, 7) >= from && r.certifiedDate.slice(0, 7) <= through), transfers = inputs.filter(r => r.inputVatTreatment === 'transfer_out' && r.date.slice(0, 7) >= from && r.date.slice(0, 7) <= through);
          const out = sum(transactions, 'tax'),simpleOutput=transactions.filter(t=>t.simplifiedMethod===true).reduce((n,t)=>n+cents(t.tax),0n),generalOutput=out-simpleOutput,certified = sum(eligible, 'invoiceTax'), transfer = sum(transfers, 'invoiceTax'), available = carry + certified - transfer, due = positive(generalOutput - available)+simpleOutput, closing = positive(available - generalOutput);
          replay.push({ from, through, openingCredit: money(carry), outputTax: money(out),generalOutputTax:money(generalOutput),simplifiedOutputTax:money(simpleOutput),certifiedInput: money(certified), transferOut: money(transfer), due: money(due), closingCredit: money(closing), sourceRefs: [...refs(transactions), ...refs(eligible), ...refs(transfers)] }); carry = closing;
        }
        vatLiabilityReplay=replay;const last = replay.at(-1); vatDue = cents(last.due); settlement('vat', vatDue, ['vat'], '按税期完整重放年初留抵、各期销项、按认证日期归属的进项及转出；上期已用留抵不重复扣减', { outputTax: last.outputTax, inputCredit: money(cents(last.openingCredit) + cents(last.certifiedInput) - cents(last.transferOut)), closingCredit: last.closingCredit, replay, sourceRefs: [...openings[0].sourceRefs, ...replay.flatMap(p => p.sourceRefs)] });
      }
    } else add('vat', 'missing', '补充主管税务机关登记的一般/小规模纳税人身份');
  }
  const pre=calculateAgencyVatPrepayments({scope,entity,records});
  if (!absent('vat_prepayment', pre.issues.length>0||pre.calculations.some(c=>c.month===scope.period||c.status==='pending_period_end')||periodRows.some(r => r.type === 'construction_billing' && r.crossRegion === true))) {
    if (pre.issues.length) add('vat_prepayment', 'missing', '预缴项目/原件扣除资料不完整', { calculations: pre.calculations, issues: pre.issues }, ['prepayment', 'vatRelief']);
    else if(pre.pendingPeriodEnd)add('vat_prepayment','pending_period_end','按季预缴地销售归集未到季末；提前收款预缴需逐笔核实际申报期限，不以月10万替代季30万',{calculations:pre.calculations},['prepayment','vatRelief']);
    else settlement('vat_prepayment', cents(pre.currentDue), ['prepayment', 'vatRelief'], '按项目/预缴地重放实际收款、预收、分包支付与负额续抵；异地租赁按法定征收率分离原含税租金，预收已预缴部分不二次预缴', { calculations: pre.calculations, closingDeductionBalances: pre.closingDeductionBalances });
  }
  const prepaidReceipts=current.filter(r=>r.type==='tax_payment'&&r.obligationId==='vat_prepayment'),prepaidIssues=[];
  const prepaidIdentities=new Set();
  for(const r of prepaidReceipts){const identity=stable([r.receiptIssuer,r.prepaymentReceiptNumber]);if(!r.projectId||!r.localityKey||!r.receiptIssuer||!r.prepaymentReceiptNumber||r.taxReceiptVerified!==true||!/^20\d\d-\d\d$/.test(r.assessmentPeriod??'')||cents(r.amount)<0n||prepaidIdentities.has(identity))prepaidIssues.push(issue('vat_prepaid_receipt_unverified','抵减仅采用已核原预缴完税凭证，需所属期/项目/预缴地/征收机关/凭证号且不能重复',r.id));prepaidIdentities.add(identity);}
  if(vatDue!==null&&(prepaidReceipts.length||records.some(r=>r.type==='opening_vat_prepayment'))){
    const opening=records.filter(r=>r.type==='opening_vat_prepayment'&&r.asOfPeriod===accounting.replayFrom);
    if(opening.length>1||opening.some(r=>r.declarationVerified!==true||cents(r.amount)<0n)||prepaidReceipts.some(r=>r.date.slice(0,7)<accounting.replayFrom)&&opening.length!==1)prepaidIssues.push(issue('vat_prepaid_opening_missing','承接前预缴不能再直接抵减；需要该起点已核尚未抵扣的预缴结转凭证'));
    if(prepaidIssues.length){const row=obligations.find(o=>o.obligationId==='vat');row.status='missing';row.reason='原预缴抵减凭证/承接未核，不能把其当零或重复抵减';delete row.due;delete row.difference;issues.push(...prepaidIssues);vatDue=null;}
    else{
      let carry=opening.length?cents(opening[0].amount):0n;const replay=[];
      for(const p of vatLiabilityReplay){const paid=prepaidReceipts.filter(r=>r.date.slice(0,7)>=p.from&&r.date.slice(0,7)<=p.through),available=carry+sum(paid,'amount'),liability=cents(p.due),credit=available<liability?available:liability;carry=available-credit;replay.push({from:p.from,through:p.through,liability:p.due,availablePrepaid:money(available),credited:money(credit),headOfficeDue:money(liability-credit),closingPrepaidCredit:money(carry),sourceRefs:refs(paid)});}
      const row=obligations.find(o=>o.obligationId==='vat'),last=replay.at(-1);vatDue=cents(last.headOfficeDue);Object.assign(row,{taxBeforePrepayment:row.due,due:money(vatDue),difference:money(vatDue-cents(row.paid)),paymentState:payment('vat').length?cents(row.paid)===vatDue?'matched':'difference':'payment_evidence_missing',prepaymentCredit:last.credited,closingPrepaidCredit:money(carry),prepaymentReplay:replay});row.sourceRefs.push(...refs(prepaidReceipts));row.sources.push(...src(['prepayment']));
    }
  }
  const sixTaxRelief=determineAgencySixTaxRelief({scope,entity,records}),half=sixTaxRelief.eligible;
  // An explicit statutory location is still a fact requiring evidence.
  const consumptionExcluded = answer('consumption')?.present === false;
  if (vatDue !== null && consumptionExcluded) {
    const a = records.find(r => r.type === 'tax_location'&&!r.localityKey),sitePaid=prepaidReceipts.filter(r=>r.date.slice(0,7)>=vatFrom),siteBases=sitePaid.map(r=>({receipt:r,location:records.find(l=>l.type==='tax_location'&&l.localityKey===r.localityKey)}));
    const siteLocationMissing=siteBases.some(x=>!['city','county_town','other'].includes(x.location?.classification));
    if (!a || !['city', 'county_town', 'other'].includes(a.classification)) add('urban_maintenance', 'missing', '提供纳税人所在地的市区/县城镇/其他地区事实及证明，法定税率分别7%/5%/1%');
    else if(siteLocationMissing)add('urban_maintenance','missing','异地预缴附加需各预缴地市区/县城镇/其他地区原始证明，机构所在地税率不能代替');
    else if(half===null&&(vatDue>0n||sum(sitePaid,'amount')>0n))add('urban_maintenance','missing',sixTaxRelief.reason,{eligibility:sixTaxRelief});
    else{const rate=l=>BigInt({city:700,county_town:500,other:100}[l.classification]),divisor=half?20000n:10000n,calculations=[{locality:'head_office',base:money(vatDue),rateBasisPoints:Number(rate(a)),due:money(roundRatio(vatDue*rate(a),divisor))},...siteBases.map(x=>({locality:x.receipt.localityKey,base:x.receipt.amount,rateBasisPoints:Number(rate(x.location)),due:money(roundRatio(cents(x.receipt.amount)*rate(x.location),divisor)),receiptNumber:x.receipt.prepaymentReceiptNumber}))];settlement('urban_maintenance',sum(calculations,'due'),['smallRelief','prepaymentSurcharge'],'预缴地按实际预缴税款、机构所在地仅按抵预缴后的实际税额分别计算城建，不重复用总部率',{calculations,sourceRefs:[...a.sourceRefs,...refs(sitePaid),...siteBases.flatMap(x=>x.location.sourceRefs)]});}
    const educationExempt = totalNet <= (entity.vatPeriod === 'quarterly' ? 30000000n : 10000000n);
    if(!educationExempt&&half===null&&(vatDue>0n||sum(sitePaid,'amount')>0n))add('education_surcharge','missing',sixTaxRelief.reason,{eligibility:sixTaxRelief});
    else settlement('education_surcharge', educationExempt ? 0n : roundRatio((vatDue+sum(sitePaid,'amount')) * 300n, half ? 20000n : 10000n), ['educationRelief', 'smallRelief','prepaymentSurcharge'], educationExempt ? '财税2016第12号月销售额不超过10万元/季不超过30万元免征；边界含等号，区别于2026VAT起征点' : '预缴地实际税额与总部抵减后税额分开，教育附加3%及已核身份减半计算', { sourceRefs: [...refs(output),...refs(sitePaid)] });
    if (educationExempt) settlement('local_education', 0n, ['educationRelief'], '月销售额不超过10万元/季不超过30万元，全国免征条件明确，不需猜地区费率', { sourceRefs: refs(output) });
    else if(half===null&&(vatDue>0n||sum(sitePaid,'amount')>0n))add('local_education','missing',sixTaxRelief.reason,{eligibility:sixTaxRelief});
    else settlement('local_education',roundRatio((vatDue+sum(sitePaid,'amount'))*200n,half?20000n:10000n),['localEducation','smallRelief','prepaymentSurcharge'],'通常地方教育附加全国统一2%，按已核六税两费减征；预缴地及机构所在地仅各自实际税额，不混用尚未生效征求意见',{sourceRefs:[...refs(output),...refs(sitePaid)]});
  } else for (const id of ['urban_maintenance', 'education_surcharge', 'local_education']) add(id, 'unknown', 'VAT或消费税基础未完成，关联附加待核');

  const staff = current.filter(r => r.type === 'payroll');
  const official=calculateAgencyContributionNotices({scope,entity,records}),officialPayroll=calculateAgencyOfficialPayroll({scope,entity,records,official});
  const currentNoticeRows=official.calculations.filter(c=>c.assessmentPeriod===scope.period);
  const contributionParameters = records.find(r => r.type === 'contribution_parameters' && r.from <= scope.period && r.through >= scope.period && r.region === entity.region);
  let contributionTrial = null, payrollTrial = null;
  if (contributionParameters) {
    try { contributionTrial = calculateAgencyContributionArithmetic({ wages: records.filter(r => r.type === 'contribution_wage_history'), parameters: contributionParameters, payments: periodRows.filter(r => r.type === 'contribution_payment') }); payrollTrial = calculateAgencyPayrollArithmetic({ scope, payrollRecords: staff, contributionArithmetic: contributionTrial }); }
    catch (error) { issues.push(issue(error.code ?? 'contribution_arithmetic_invalid', '工资原始历史/参数范围/当期扣除资料不完整，不能由客户预制当期税额代替')); }
  }
  if (!absent('salary_withholding', staff.length > 0)) {
    if(officialPayroll.available&&!official.issues.length&&!officialPayroll.issues.length){
      payroll.push(...officialPayroll.calculations);entries.push(...officialPayroll.entries);const paidEmployees=payroll.filter(c=>staff.some(r=>r.employeeId===c.employeeId&&(r.paymentDate??r.date).slice(0,7)===scope.period&&r.paid===true));
      settlement('salary_withholding',paidEmployees.reduce((n,c)=>n+cents(c.currentWithholding),0n),['withholding'],'原始工资/扣除与官方核定的个人社公负担派生累计个税，实际支付银行净额已核；未付工资不冒称已预扣',{employees:payroll,sourceRefs:payroll.flatMap(p=>p.sourceRefs)});
    }else{
    const employees = new Set(staff.map(r => r.employeeId));
    for (const employeeId of employees) {
      const rows = staff.filter(r => r.employeeId === employeeId).sort((a, b) => a.date.localeCompare(b.date));
      const historical = rows.filter(r => r.date.slice(0, 7) < scope.period), currentRow = rows.find(r => r.date.slice(0, 7) === scope.period);
      if (rows.some(r => r.resident !== true || !Number.isSafeInteger(r.employmentMonth) || !Object.hasOwn(r, 'specialAdditionalDeduction') || !Object.hasOwn(r, 'otherDeduction')) || historical.some(r => !Object.hasOwn(r, 'employeeSocial') || !Object.hasOwn(r, 'employeeHousing') || !Object.hasOwn(r, 'taxWithheld'))) { issues.push(issue('salary_cumulative_evidence_missing', '提供居民身份、任职月份、当期工资组成及原始扣除事实；仅既往月份需实际个人扣款和已扣税凭证', employeeId)); continue; }
      const received=rows.filter(r=>r.paid===true&&(r.paymentDate??r.date).slice(0,7)<=scope.period),gross = received.reduce((n, r) => n + sum(r.components, 'amount'), 0n); const months = new Set(rows.map(r => r.employmentMonth));
      if (months.size !== rows.length || rows.at(-1).employmentMonth !== rows.length) { issues.push(issue('salary_history_gap', '补齐当年在本单位任职每月工资扣除和实际预扣凭证', employeeId)); continue; }
      const trial = payrollTrial?.calculations.find(p => p.employeeId === employeeId);
      payroll.push({ employeeId, grossCumulative: money(gross), grossCurrent: currentRow ? money(sum(currentRow.components, 'amount')) : null, currentWithholding: null, observedCurrentStatement: currentRow ? { employeeSocial: currentRow.employeeSocial ?? null, employeeHousing: currentRow.employeeHousing ?? null, taxWithheld: currentRow.taxWithheld ?? null } : null, arithmeticTrial: trial ?? null, sourceRefs: refs(rows) });
      issues.push(issue('salary_contribution_policy_unverified', '先按原始工资及已核地区参数计算法定社保/公积金扣除，再计算本期累计个税；当前地区尚未核实，试算不能作为正式应缴', employeeId));
    }
    add('salary_withholding', 'missing', '由工资组成和地区规则派生当期个人社保/公积金后计算累计个税；当期未核地区分支待核，客户无须预制当期扣款或税额', { employees: payroll, arithmeticTrial: payrollTrial,officialNoticeIssues:officialPayroll.issues }, ['withholding']);
    }
  }
  if (!absent('other_withholding', periodRows.some(r => r.type === 'personal_payment'))) {
    const result = calculateAgencyOtherWithholding({ scope, records });
    if (result.issues.length) add('other_withholding', 'missing', '非工资支付身份/所得类别/同项目归并未完成，不按工资计算', result, ['income', 'withholding']);
    else settlement('other_withholding', cents(result.due), ['income', 'withholding'], '居民一次性劳务/稿酬/特许按次，已证同项目连续收入才按月；财产租赁按月、股息按支付次计算，不冒充年度最终税额', result);
  }
  for (const id of ['social_insurance', 'housing_fund']) if (!absent(id, staff.length > 0)) {
    const components=id==='social_insurance'?['pension','medical','unemployment','injury','maternity']:['housing'];
    const notices=records.filter(r=>r.type==='contribution_notice'&&r.assessmentPeriod===scope.period&&r.registrationNumber===entity.registrationNumber);
    const rows=currentNoticeRows.filter(c=>components.includes(c.component));
    const complete=components.every(component=>notices.some(n=>n.coveredComponents?.includes(component)))&&staff.filter(r=>r.date.slice(0,7)===scope.period).every(r=>components.every(component=>rows.some(c=>c.employeeId===r.employeeId&&c.component===component)));
    if(complete&&!official.issues.length){
      const due=rows.reduce((n,c)=>n+cents(c.total),0n),paid=official.payments.filter(p=>p.assessmentPeriod===scope.period).reduce((n,p)=>n+currentNoticeRows.filter(c=>c.noticeNumber===p.noticeNumber&&components.includes(c.component)&&p.components.includes(c.component)).reduce((v,c)=>v+cents(c.total),0n),0n);
      add(id,'calculated','按官方当期核定明细逐人逐险种汇总单位/个人负担并核实际银行缴费；这不是地区费率公式已核',{due:money(due),paid:money(paid),difference:money(due-paid),calculationBasis:'official_assessment_notice',regionalRuleVerification:'not_inferred',calculations:rows,sourceRefs:rows.flatMap(r=>r.sourceRefs)},id==='social_insurance'?['social']:[]);
    }else{
    const rule = regional(entity[`${id}RuleId`], entity, scope.period);
    if (!rule) add(id, 'unknown', '存在用工，必须逐项核当地险种/基数上下限/单位个人费率/公积金适用主体；参数试算不等于官方核定，不授权入账/缴费；工资中扣款不能替代法定应缴', { arithmeticTrial: contributionTrial, payrollTrial, observedPayroll: staff.map(r => ({ employeeId: r.employeeId, observedDeduction: r[id === 'social_insurance' ? 'employeeSocial' : 'employeeHousing'], sourceRefs: r.sourceRefs })) }, id === 'social_insurance' ? ['social'] : []);
    }
  }
  for(const p of official.payments){
    const personalRows=official.calculations.filter(c=>c.noticeNumber===p.noticeNumber&&c.assessmentPeriod===p.assessmentPeriod&&p.components.includes(c.component)&&cents(c.employee)>0n);
    if(personalRows.some(c=>!records.some(r=>r.type==='payroll'&&r.employeeId===c.employeeId&&r.date.slice(0,7)===c.assessmentPeriod&&r.paid===true&&(r.paymentDate??r.date).slice(0,7)<=scope.period))){issues.push(issue('contribution_personal_clearing_missing','已实际缴个人社公但对应工资尚未实付：需单位垫付/后续扣回原件和期初往来核对，不将未代扣金额记成已清偿代扣往来',p.id));continue;}
    entries.push({obligationId:'contribution_payment',period:scope.period,kind:'contribution_payment',paymentId:p.stableIdentity,cumulative:false,reason:'按原官方核定单汇总单位/个人及银行实缴，单位部分核销职工薪酬、个人部分核销代扣往来，不重复费用',sourceRefs:p.sourceRefs,entries:[...(cents(p.employer)?[{code:'2211',debit:p.employer,credit:'0.00'}]:[]),...(cents(p.employee)?[{code:'2241',debit:p.employee,credit:'0.00'}]:[]),{code:'1002',debit:'0.00',credit:p.amount}]});
  }
  const contracts = periodRows.filter(r => r.type === 'contract');
  if (!absent('stamp', contracts.length > 0)) {
    const work = [];
    for (const c of contracts) {
      const rate = stampRates[c.stampCategory];
      if (rate === undefined || typeof c.separatelyStatedVat !== 'boolean' || c.separatelyStatedVat && !Object.hasOwn(c, 'invoiceTax')) { issues.push(issue('stamp_contract_missing', '核合同税目以及是否列明VAT；已明确未列明的按合同全额计算', c.id)); continue; }
      const base = cents(c.amountIncludingVat) - (c.separatelyStatedVat ? cents(c.invoiceTax) : 0n), rateNumerator = BigInt(Math.round(rate * 2)); const tax = roundRatio(base * rateNumerator, 20000n * (half ? 2n : 1n)); work.push({ factId: c.id, base: money(base), due: money(tax), sourceRefs: c.sourceRefs });
    }
    if (issues.some(i => i.code === 'stamp_contract_missing')) add('stamp', 'missing', '应税合同税目/金额资料不完整', { calculations: work }, ['stamp']);
    else if(half===null&&work.some(w=>cents(w.due)>0n))add('stamp','missing',sixTaxRelief.reason,{calculations:work,eligibility:sixTaxRelief},['stamp']);
    else settlement('stamp', work.reduce((n, w) => n + cents(w.due), 0n), ['stamp', 'smallRelief'], '合同列明金额减列明VAT，逐税目计算后适用已核身份减半；运输合同万分之三', { calculations: work });
  }
  const evidenceLocated=(r,p)=>typeof p==='string'&&(Array.isArray(r.originalRefs)?r.originalRefs.some(x=>x.locator===p):r.sourceRefs?.some(x=>x.locator===p));
  const verifiedHoldingEnd=r=>{const value=r.ownershipTerminationVerified===true?r.ownershipTerminatedOn:r.disposalEvidenceVerified===true?r.disposedDate:null;if(typeof value!=='string'||!/^20\d\d-\d\d-\d\d$/.test(value))return null;const date=new Date(`${value}T00:00:00Z`);return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value?value:null;};
  const subjectExcluded=(r,id)=>{const source=r.taxSubjectEvidence?r:records.find(x=>x.type==='land_asset'&&x.propertyId&&x.propertyId===r.propertyId&&x.taxSubjectEvidence),e=source?.taxSubjectEvidence;if(!(e&&e.obligationId===id&&e.liableEnterpriseKey&&e.liableEnterpriseKey!==scope.enterpriseKey&&e.documentNumber&&e.reason?.trim()&&evidenceLocated(source,e.originalLocator)))return false;if(e.basis==='competent_tax_authority_written_subject_determination')return /^https:\/\/[^/]+\.gov\.cn\//.test(e.legalReference??'');return id==='urban_land'&&e.basis==='registered_land_right_holder_and_paid_lease'&&e.holderAtLandLocation===true&&e.rightsCertain===true&&e.jointRights===false&&e.paidLease===true&&e.collectiveFreeUse===false&&e.actingAsCustodian===false&&r.landUseRightOwned!==true&&r.ownership!=='owner';};
  const propertyOwnershipClues=records.filter(r=>r.date.slice(0,7)<=scope.period&&(['property_disposal','property_acquisition'].includes(r.type)&&(r.assetOwnershipVerified===true||r.ownershipVerified===true)||r.type==='rental'&&r.assetKind==='real_estate'&&(r.ownership==='owner'||r.assetOwnershipVerified===true))&&!(verifiedHoldingEnd(r)?.slice(0,7)<scope.period));
  const propertyAssets = records.filter(r => r.type === 'property_asset' && r.date.slice(0, 7) <= scope.period && (!verifiedHoldingEnd(r)||verifiedHoldingEnd(r).slice(0,7)>=scope.period));
  if (!absent('property', propertyAssets.length > 0 || propertyOwnershipClues.length>0 || records.some(r => r.type === 'rental' && r.role === 'lessor' && r.assetKind === 'real_estate'))) {
    const calculations = [], propertyIssues = [];
    if(propertyOwnershipClues.some(c=>propertyAssets.some(a=>a.propertyId===c.propertyId&&a.ownership==='sublessor')))propertyIssues.push(issue('property_ownership_source_conflict','同一权属标的原出售/所有权与仅转租登记互相矛盾，必须核对有效来源，不能挑免税结论'));
    if(propertyOwnershipClues.some(c=>!subjectExcluded(c,'property')&&!propertyAssets.some(a=>a.propertyId===c.propertyId)))propertyIssues.push(issue('property_original_holding_scope_unverified','原取得/出售/产权已核租赁已给持有线索，税区、用途、原值及法定权利终止月仍须核；不因缺property_asset或inventory否定而作无房'));
    if (!propertyAssets.length&&(!propertyOwnershipClues.length||!propertyOwnershipClues.every(c=>subjectExcluded(c,'property')))) propertyIssues.push(issue('property_title_missing', '出租/转租收入不能证明房产税纳税义务，补充权属/代管事实及不动产所在地'));
    for (const asset of propertyAssets) {
      if(subjectExcluded(asset,'property')){calculations.push({propertyId:asset.propertyId,status:'not_applicable',reason:asset.taxSubjectEvidence.reason,due:'0.00',sourceRefs:asset.sourceRefs});continue;}
      if (asset.ownership === 'sublessor') { calculations.push({ propertyId: asset.propertyId, status: 'not_applicable', reason: '仅转租非产权所有/代管/承典人；其租金不自动构成自身房产税', due: '0.00', sourceRefs: asset.sourceRefs }); continue; }
      if (!['owner', 'custodian', 'pledgee'].includes(asset.ownership) || !['city', 'county_town', 'industrial_mining', 'rural'].includes(asset.taxArea)) { propertyIssues.push(issue('property_title_or_area_unknown', '核房产权属及城市/县城/建制镇/工矿区征税范围', asset.id)); continue; }
      if (asset.taxArea === 'rural') { calculations.push({ propertyId: asset.propertyId, status: 'not_applicable', reason: '原始地址核实不在房产税暂行条例第1条征税地域范围', due: '0.00', sourceRefs: asset.sourceRefs }); continue; }
      if (asset.use === 'self_use') { propertyIssues.push(issue('property_regional_deduction_unverified', '从价全国1.2%已核，原值扣除比例须按地区核定，不能全国默认30%', asset.id)); continue; }
      const leases = records.filter(r => r.type === 'rental' && r.propertyId === asset.propertyId && r.role === 'lessor'&&r.startDate<=`${scope.period}-31`&&r.endDate>=`${scope.period}-01`);
      if (asset.use !== 'rented' || !leases.length || typeof asset.housing !== 'boolean') { propertyIssues.push(issue('property_rental_facts_missing', '补租赁合同、住房用途、承租人身份及租金时段', asset.id)); continue; }
      if(leases.some(r=>r.rentFreeDays>0&&r.startDate.slice(0,7)<=scope.period&&r.endDate.slice(0,7)>=scope.period)){propertyIssues.push(issue('property_rent_free_original_value_required','合同有免租期：需原免租起止、含地价房产原值及当地原值扣除/征期；免租期间须从价，不能用会计直线摊租计从租税',asset.id));continue;}
      const ids = new Set(leases.map(r => r.id)), revenueCode = getAccountingRoles(accounting.profileId).mainRevenue;
      let base = accounting.vouchers.filter(v => ids.has(v.factId)).reduce((n, v) => n + v.entries.filter(e => [revenueCode,accounting.profileId==='enterprise-2019-general-basic-v1'?'6117':'5301'].includes(e.code)).reduce((sum, e) => sum + cents(e.credit) - cents(e.debit), 0n), 0n);
      if (obligations.find(o => o.obligationId === 'vat')?.exemption && totalNet < (entity.vatPeriod === 'quarterly' ? 30000000n : 10000000n)) base += output.filter(t => ids.has(t.factId) && t.invoiceKind === 'ordinary').reduce((n, t) => n + cents(t.tax), 0n);
      const fourPercent = asset.housing && (entity.kind === 'individual_business' || asset.tenantKind === 'natural' || asset.tenantKind === 'specialized_scaled_housing_enterprise' && asset.tenantQualificationVerified === true);
      const due = roundRatio(base * BigInt(fourPercent ? 400 : 1200), half ? 20000n : 10000n); calculations.push({ propertyId: asset.propertyId, base: money(base), rateBasisPoints: fourPercent ? 400 : 1200, reliefApplied: half, due: money(due), sourceRefs: [...asset.sourceRefs, ...refs(leases)] });
    }
    if (propertyIssues.length) add('property', 'missing', '权属/地域/从价地区扣除或适用租金条件未完成，不能当零', { calculations, issues: propertyIssues }, ['property', 'housingProperty']);
    else if(half===null&&calculations.some(c=>cents(c.due)>0n))add('property','missing',sixTaxRelief.reason,{calculations,eligibility:sixTaxRelief},['property']);
    else settlement('property', calculations.reduce((n, c) => n + cents(c.due), 0n), ['property', 'housingProperty', 'propertyVatBase', 'smallRelief'], '按权属及原始租赁事实判从租12%/住房4%，再适用已核六税两费减半；转租不自动负担产权人税', { calculations });
  }
  const employees = records.find(r => r.type === 'annual_employment');
  if (!absent('disability_fund', staff.length > 0 || employees !== undefined)) {
    if (!employees || !Array.isArray(employees.months) || employees.months.length !== 12 || new Set(employees.months.map(m => m.month)).size !== 12) add('disability_fund', 'missing', '残保金需上年完整12个月在职人数、工资总额、残疾人数认定；当月人数不能冒充年度平均');
    else { const head12 = employees.months.reduce((n, m) => n + quantity(m.employees), 0n); if (entity.kind !== 'individual_business' && head12 <= 360000000n) settlement('disability_fund', 0n, ['disability'], '完整上年平均在职人数≤30人的企业免征；个体不按企业免征条款猜定', { sourceRefs: employees.sourceRefs }); else { const parameters = records.find(r => r.type === 'disability_parameters' && r.region === entity.region && r.assessmentYear === scope.period.slice(0, 4)); let arithmeticTrial = null; if (parameters) arithmeticTrial = calculateAgencyDisabilityArithmetic({ months: employees.months, disabledEmploymentMonths: employees.disabledEmploymentMonths, socialAverageAnnualWage: parameters.socialAverageAnnualWage, requiredRatio: parameters.requiredRatio }); add('disability_fund', 'unknown', '全国两倍社会年平均工资上限与50%/90%分档公式已实现；所在地安置比例、上年工资及残疾人数认定须核，参数试算不授权缴费', { arithmeticTrial }, ['disability']); } }
  }
  if(!absent('vehicle_purchase',current.some(r=>r.type==='vehicle_acquisition'))){const calculations=[],missing=[];for(const r of current.filter(r=>r.type==='vehicle_acquisition'))try{calculations.push({...calculateAgencyVehicleAcquisition({entity,record:r,records}),period:r.date.slice(0,7)});}catch(error){if(!error.code)throw error;missing.push(issue(error.code,'核车辆自用/应税范围、原发票、已征/减免及2026有效车型目录，未知不能默认零',r.id));}if(missing.length)add('vehicle_purchase','missing','车辆购置原件或适用条件未核',{calculations,issues:missing},['vehiclePurchase','electricVehicle','electricVehicle2026']);else settlement('vehicle_purchase',calculations.filter(c=>c.period===scope.period).reduce((n,c)=>n+cents(c.due),0n),['vehiclePurchase','electricVehicle','electricVehicle2026'],'原车价及依法计算购税资本化，按车辆一次征收/已征不重复，核实际税票所属期',{calculations,sourceRefs:refs(current.filter(r=>r.type==='vehicle_acquisition'))});}
  if(!absent('cultural_construction',current.some(r=>['advertising','entertainment'].includes(r.type)))){const result=calculateAgencyCulturalFee({scope,entity,accounting,records});if(result.issues.length)add('cultural_construction','missing','原实际广告/娱乐服务、计费/预算与减免尚未全核',{...result},['cultural','culturalEntertainment','culturalRelief']);else if(result.allNotApplicable)add('cultural_construction','not_applicable','原资料明确仅采购/非广告征收主体',{calculations:result.calculations,sourceRefs:refs(current.filter(r=>['advertising','entertainment'].includes(r.type)))});else if(result.pendingPeriodEnd)add('cultural_construction','pending_period_end','文建按VAT同一税期归集，按季资料未到季末',{calculations:result.calculations},['cultural']);else settlement('cultural_construction',cents(result.due),['cultural','culturalEntertainment','culturalRelief'],'依原实际服务、含税价、合法实付发布费和已核预算归属计算文建，不以公司中央属性猜预算',{calculations:result.calculations,sourceRefs:refs(current.filter(r=>['advertising','entertainment'].includes(r.type)))});}
  if(!absent('union_funds',current.some(r=>r.type==='union'||r.type==='union_payment'))){const result=calculateAgencyUnionFees({scope,records}),paid=result.payments.filter(p=>p.assessmentPeriod===scope.period).reduce((n,p)=>n+cents(p.amount),0n);if(result.issues.length)add('union_funds','missing','建会/工资组成/实际拨付资料未核，地区筹备及代收不按全国2%猜定',result,['union','wageTotal']);else{const unionJournals=[...accounting.historicalVouchers,...accounting.vouchers].filter(v=>v.summary.startsWith('已建会按原工资')&&v.period.startsWith(scope.period.slice(0,4))),accrued=unionJournals.reduce((n,v)=>n+cents(v.entries[0].debit),0n),currentAccrued=unionJournals.filter(v=>v.period===scope.period).reduce((n,v)=>n+cents(v.entries[0].debit),0n),openingRows=records.filter(r=>r.type==='opening_balance'&&r.accountCode==='2211'),opening=openingRows.length&&!openingRows.every(r=>r.obligationId==='union_funds')?null:openingRows.reduce((n,r)=>n+cents(r.credit)-cents(r.debit),0n),paidToDate=current.filter(r=>r.type==='union_payment').reduce((n,r)=>n+cents(r.amount),0n);add('union_funds','calculated','已建会单位按原统计工资组成2%核拨缴期，劳动受益期会计预提/实际银行另列，不重复费用',{...result,paid:money(paid),difference:money(cents(result.due)-paid),accountingAccrual:money(currentAccrued),accountingAccruedCumulative:money(accrued),payableBalance:opening===null?null:money(opening+accrued-paidToDate),openingAllocation:opening===null?'mixed_salary_opening_needs_original_allocation':'verified',sourceRefs:result.calculations.flatMap(c=>c.sourceRefs)},['union','wageTotal']);for(const p of result.payments)if(cents(p.amount))entries.push({obligationId:'union_funds',period:scope.period,kind:'union_payment',paymentId:hash(stable([p.bankAccountId,p.paymentReference])),cumulative:false,reason:'按原工会收入收据/代收凭证及银行实拨核销应付职工薪酬，不把返还假作免缴',sourceRefs:p.sourceRefs,entries:[{code:'2211',debit:p.amount,credit:'0.00'},{code:'1002',debit:'0.00',credit:p.amount}]});}}
  if(!absent('land_appreciation',records.some(r=>r.type==='property_disposal'&&r.date.slice(0,7)<=scope.period))){
    const result=calculateAgencyLandAppreciationUnits({scope,records}),paymentIssues=[],seenPayments=new Set(),unitSettlements=[];
    for(const unit of [...result.calculations,...result.interim.map(u=>({...u,isInterim:true}))]){const explicit=records.find(r=>r.type==='land_appreciation_unit'&&r.unitId===unit.unitId),payments=records.filter(p=>p.type==='tax_payment'&&p.obligationId==='land_appreciation'&&p.date.slice(0,7)<=scope.period&&(!unit.isInterim||p.assessmentPeriod===unit.period)&&(p.landAppreciationUnitId===unit.unitId||!explicit&&!p.landAppreciationUnitId&&p.projectId===unit.projectId&&result.calculations.filter(c=>c.projectId===unit.projectId).length===1));
      for(const p of payments){const key=stable([p.bankAccountId??p.businessIdentity?.issuerKey,p.paymentReference]);if(seenPayments.has(key)||explicit&&(!p.taxReceiptNumber||p.taxReceiptVerified!==true||!p.receiptIssuer||!p.bankAccountId||!/^20\d\d-\d\d$/.test(p.assessmentPeriod??''))||!/^20\d\d$/.test(p.assessmentYear??'')||p.assessmentYear>unit.period.slice(0,4)||p.assessmentYear!==unit.period.slice(0,4)&&!(p.taxPaymentKind==='prepayment'&&p.taxReceiptVerified===true&&p.landAppreciationUnitId===unit.unitId))paymentIssues.push(issue('agency_land_payment_unit_allocation_missing','同unit原完税票、银行、所属期及跨年预缴性质未核或重复；不能跨独立对象串抵',p.id));seenPayments.add(key);}
      if(explicit&&!unit.isInterim&&unit.period===scope.period){const expected=explicit.taxPaymentFactIds;if(!Array.isArray(expected)||!explicit.paymentInventoryReason?.trim()||stable([...expected].sort())!==stable(payments.map(p=>p.id).sort()))paymentIssues.push(issue('agency_land_payment_inventory_incomplete','最终期须原完税/预缴和银行清单逐项覆盖同unit，不接受缺付款资料默认零',explicit.id));}
      const paid=payments.reduce((n,p)=>n+cents(p.amount),0n),difference=cents(unit.due)-paid;unitSettlements.push({unitId:unit.unitId,projectId:unit.projectId,period:unit.period,isInterim:unit.isInterim===true,due:unit.due,paid:money(paid),difference:money(difference),paymentFactIds:payments.map(p=>p.id),currentPayable:money(positive(difference)),overpaymentForReview:money(positive(-difference)),sourceRefs:[...unit.sourceRefs,...refs(payments)]});
    }
    const relevantPayments=records.filter(p=>p.type==='tax_payment'&&p.obligationId==='land_appreciation'&&p.date.slice(0,7)===scope.period);for(const p of relevantPayments)if(!unitSettlements.some(u=>u.paymentFactIds.includes(p.id)))paymentIssues.push(issue('agency_land_payment_unit_allocation_missing','已给土地增值税银行付款必须绑定真实基本核算对象，不以同项目名称代替，未知不得静默忽略',p.id));
    if(result.issues.length||paymentIssues.length)add('land_appreciation','missing','原基本核算对象、完整原件或分期/最终所属期/同对象预缴依据未核',{...result,issues:[...result.issues,...paymentIssues],unitSettlements},['landAppreciation','landAppreciation2026']);
    else{const currentSettlements=unitSettlements.filter(u=>u.period===scope.period),due=currentSettlements.reduce((n,u)=>n+cents(u.due),0n),paid=currentSettlements.reduce((n,u)=>n+cents(u.paid),0n);add('land_appreciation','calculated','以原基本核算对象汇总收入与去重扣除后速扣；最终/此前预缴依原主管文书，预缴只抵同unit，不跨对象调剂',{due:money(due),paid:money(paid),difference:money(due-paid),currentPayable:money(currentSettlements.reduce((n,u)=>n+cents(u.currentPayable),0n)),overpaymentForReview:money(currentSettlements.reduce((n,u)=>n+cents(u.overpaymentForReview),0n)),calculations:result.allocations,assessmentUnits:result.calculations,unitSettlements,interim:result.interim,sourceRefs:[...result.calculations,...result.interim].flatMap(c=>c.sourceRefs)},['landAppreciation','landAppreciation2026']);}
  }

  const triggers = { urban_land: ['land_asset'], vehicle_vessel: ['vehicle','vehicle_acquisition'], consumption: ['excise_product'], resource: ['extraction'], water_resource: ['water_extraction'], environment: ['pollutant_discharge'], deed: ['property_acquisition'], farmland_occupation: ['farmland_use'], customs: ['import_export'], tobacco: ['tobacco_leaf_purchase'], vessel_tonnage: ['foreign_port_vessel_entry'] };
  for(const [id,types]of Object.entries(triggers)){const relevant=(['urban_land','vehicle_vessel'].includes(id)?records.filter(r=>r.date.slice(0,7)<=scope.period&&!(verifiedHoldingEnd(r)?.slice(0,7)<scope.period)):current).filter(r=>types.includes(r.type)),clues=id==='urban_land'?[...relevant,...propertyOwnershipClues]:relevant,exclusions=clues.filter(r=>subjectExcluded(r,id));if(clues.length&&exclusions.length===clues.length){add(id,'not_applicable','按原权属登记/有偿租约与法定纳税主体条件或原主管书面认定，税费由不同主体承担；非任意verified布尔',{sourceRefs:refs(exclusions)},id==='urban_land'?['landSubject']:[]);continue;}if(!absent(id,clues.some(r=>!subjectExcluded(r,id))))add(id,'uncovered',`${id}存在尚未解决的本期/持续持有权属线索；不臆测已出售或同户必应纳，须核适用主体/标的/有效期间/地区及减免`,{sourceRefs:refs(clues)});}

  const expenses = current.filter(r => r.type === 'expense');
  const taxAdjustments = [];
  const unionAccrued=[...accounting.historicalVouchers,...accounting.vouchers].filter(v=>v.period.startsWith(scope.period.slice(0,4))&&v.summary.startsWith('已建会按原工资')).reduce((n,v)=>n+cents(v.entries[0].debit),0n),unionPaid=current.filter(r=>r.type==='union_payment'&&r.legalIncomeReceiptNumber&&r.deductionVoucherValid===true).reduce((n,r)=>n+cents(r.amount),0n);
  if(unionAccrued||unionPaid)taxAdjustments.push({factId:'union_funds_year',amount:money(unionAccrued-(unionPaid<unionAccrued?unionPaid:unionAccrued)),reason:'工会经费年度按合规实际拨缴且不超过工资薪金2%扣除；计提未拨/缺合法凭证不能默认扣除，预缴实际利润不在此纳调',accrued:money(unionAccrued),eligibleActuallyPaid:money(unionPaid),sourceRefs:refs(current.filter(r=>r.type==='union_payment'||r.type==='union'))});
  const entertainment = expenses.filter(e => e.taxNature === 'entertainment'), entertainmentTotal = entertainment.reduce((n, e) => n + cents(e.gross), 0n), entertainmentCap = rateAmount(cents(accounting.yearRevenue), 50), entertainmentDeduction = rateAmount(entertainmentTotal, 6000) < entertainmentCap ? rateAmount(entertainmentTotal, 6000) : entertainmentCap;
  let entertainmentRunning = 0n;
  for (const e of expenses) {
    if (e.taxNature === 'fine' || e.taxNature === 'personal') taxAdjustments.push({ factId: e.id, amount: money(cents(e.gross)), reason: e.taxNature === 'fine' ? '行政罚款不得税前扣除' : '投资者个人/家庭支出不得税前扣除', sourceRefs: e.sourceRefs });
    else if (e.taxNature === 'entertainment') { const amount = cents(e.gross), before = entertainmentRunning; entertainmentRunning += amount; const deductible = entertainmentTotal ? roundRatio(entertainmentDeduction * entertainmentRunning, entertainmentTotal) - roundRatio(entertainmentDeduction * before, entertainmentTotal) : 0n; taxAdjustments.push({ factId: e.id, amount: money(amount - deductible), reason: '全年全部业务招待费合并取发生额60%与全年收入0.5%较小额，再按累计比例分配，分尾不丢失', sourceRefs: e.sourceRefs }); }
    else if (e.taxNature !== 'ordinary') issues.push(issue('income_expense_nature_missing', '逐笔核明成本费用税收性质、扣除凭证及跨期归属', e.id));
  }
  for (const lease of current.filter(r => r.type === 'lease_lessee')) {
    if (lease.taxLeaseClassification !== 'operating') { issues.push(issue('income_lease_tax_classification_missing', 'CAS使用权折旧与利息不自动等于税务扣除；核原租约税务经营/融资性质，融资另需税基及折旧事实', lease.id)); continue; }
    const leaseRows = [...accounting.historicalVouchers, ...accounting.vouchers].filter(v => v.factId === lease.id && v.period.startsWith(scope.period.slice(0, 4)));
    const expenseCodes = new Set(accounting.reportDraftInputs.accounts.filter(a => a.category === '损益' && a.direction === 'debit').map(a => a.code));
    const bookExpense = leaseRows.reduce((n, v) => n + v.entries.filter(e => expenseCodes.has(e.code)).reduce((m, e) => m + cents(e.debit) - cents(e.credit), 0n), 0n);
    const schedules = lease.paymentSchedule ?? [], startMonth = lease.assetAvailableDate.slice(0, 7), elapsed = schedules.filter(s => s.dueDate.slice(0, 7) <= scope.period && s.dueDate.slice(0, 7) >= startMonth).length;
    if (!schedules.length || lease.use === 'production') { issues.push(issue('income_lease_cost_allocation_missing', '补经营租赁完整租期及制造存货已售/在产归属，不能将资本化使用权折旧全部直接扣除', lease.id)); continue; }
    const totalRent = schedules.reduce((n, s) => { const split = splitAgencyOriginalPrice({ entity: { vatStatus: lease.vendorVatStatus, vatReliefWaived: lease.vendorVatReliefWaived }, category: lease.assetKind === 'real_estate' ? 'real_estate_lease' : 'movable_lease', originalUnitPrice: s.amount, units: '1', priceIncludesVat: s.priceIncludesVat, date: s.dueDate, invoiceKind: s.invoiceKind }); return n + cents(lease.inputVatTreatment === 'deductible' ? split.net : split.gross); }, 0n);
    const priorYearMonths = schedules.filter(s => s.dueDate.slice(0, 4) < scope.period.slice(0, 4)).length, taxDeduction = roundRatio(totalRent * BigInt(elapsed), BigInt(schedules.length)) - roundRatio(totalRent * BigInt(priorYearMonths), BigInt(schedules.length));
    taxAdjustments.push({ factId: lease.id, amount: money(bookExpense - taxDeduction), reason: '所得税实施条例第47条：税务经营租赁按租期均匀扣除，与CAS使用权折旧及利息之差逐租约计算', bookExpense: money(bookExpense), taxDeduction: money(taxDeduction), sourceRefs: lease.sourceRefs });
  }
  const adjustment = taxAdjustments.reduce((n, a) => n + cents(a.amount), 0n);
  const beforeLoss = positive(cents(accounting.yearProfitBeforeTax) + (entity.kind === 'company' && !annual ? 0n : adjustment)), lossRecords = records.filter(r => r.type === 'prior_loss').sort((a, b) => a.lossYear.localeCompare(b.lossYear));
  let incomeBase = beforeLoss; const lossWorkpaper = [];
  requireValue(new Set(lossRecords.map(l=>l.lossYear)).size===lossRecords.length,'agency_prior_loss_year_version_conflict');
  for (const loss of lossRecords) {
    requireValue(/^20\d\d$/.test(loss.lossYear) && Number(loss.lossYear) < Number(scope.period.slice(0, 4)) && loss.returnEvidenceVerified === true && Array.isArray(loss.usedInPriorYears) && loss.specialCarryPeriod === false, 'agency_prior_loss_evidence_invalid');
    requireValue(cents(loss.declaredLoss)>=0n&&new Set(loss.usedInPriorYears.map(p=>p.assessmentYear)).size===loss.usedInPriorYears.length&&loss.usedInPriorYears.every(p=>/^20\d\d$/.test(p.assessmentYear)&&Number(p.assessmentYear)>Number(loss.lossYear)&&Number(p.assessmentYear)<Number(scope.period.slice(0,4))&&cents(p.amount)>=0n),'agency_prior_loss_use_history_invalid');
    const remaining = cents(loss.declaredLoss) - loss.usedInPriorYears.reduce((n, p) => n + cents(p.amount), 0n); requireValue(remaining >= 0n, 'agency_prior_loss_remaining_invalid');
    const expired = Number(scope.period.slice(0, 4)) - Number(loss.lossYear) > 5, used = expired ? 0n : remaining < incomeBase ? remaining : incomeBase; incomeBase -= used;
    lossWorkpaper.push({ lossYear: loss.lossYear, remainingBefore: money(remaining), expired, used: money(used), carryForward: money(expired ? 0n : remaining - used), sourceRefs: loss.sourceRefs });
  }
  const incomeFacts = records.find(r => r.type === 'income_evidence');
  const incomeDependencies = [...(accounting.unresolvedTaxDependencies??[]),...obligations.filter(o => ['vat','social_insurance', 'housing_fund', 'property', 'stamp', 'disability_fund', 'urban_maintenance', 'education_surcharge', 'local_education', 'consumption', 'resource', 'water_resource', 'environment', 'union_funds','cultural_construction','land_appreciation','urban_land','vehicle_vessel','deed','farmland_occupation','vehicle_purchase','customs', 'tobacco', 'vessel_tonnage'].includes(o.obligationId) && ['missing', 'unknown', 'uncovered'].includes(o.status))];
  const incomeReady = incomeDependencies.length === 0 && accounting.yearCoverageVerified && accounting.issues.length === 0 && incomeFacts?.lossCarryforwardVerified === true && (lossRecords.length > 0 || incomeFacts?.noPriorLosses === true) && incomeFacts?.otherAdjustmentsComplete === true && !issues.some(i => ['income_expense_nature_missing', 'income_lease_tax_classification_missing', 'income_lease_cost_allocation_missing'].includes(i.code));
  if (entity.kind === 'company') {
    add('business_income', 'not_applicable', '公司属于企业所得税纳税人，经营所得不套用于公司');
    if (!incomeReady) add('corporate_income', 'missing', '企业所得税需要从开业/年初至本期完整业务账、历年亏损依据、纳税调整资料，不接受客户直接提供应纳税所得额', { adjustments: taxAdjustments });
    else if (!annual && (!['monthly', 'quarterly'].includes(incomeFacts.citFilingFrequency) || incomeFacts.citPrepaymentMethod !== 'actual_profit' || incomeFacts.prepaymentAdjustmentsComplete !== true)) add('corporate_income', 'missing', '预缴须核税种认定的月/季及实际利润额方法；历史平均/其他方法需对应原始核定资料；不把年度纳调直接套到季度预缴');
    else {
      const allQuarterFacts = current.filter(r => r.type === 'quarter_profile' && r.asOfDate <= `${scope.period}-31`), quarters = allQuarterFacts.filter(q => !allQuarterFacts.some(other => other.quarter === q.quarter && other.asOfDate > q.asOfDate)), firstQuarter = entity.businessStartDate.slice(0, 4) < scope.period.slice(0, 4) ? 1 : Math.ceil(Number(entity.businessStartDate.slice(5, 7)) / 3), finalQuarter = Math.ceil(Number(scope.period.slice(5)) / 3), expectedQuarters = Array.from({ length: finalQuarter - firstQuarter + 1 }, (_, i) => `${scope.period.slice(0, 4)}-Q${firstQuarter + i}`);
      const valid = quarters.every(q => /^20\d\d-\d\d-\d\d$/.test(q.asOfDate ?? '') && q.asOfDate.slice(0, 7) === (q.quarter === `${scope.period.slice(0, 4)}-Q${finalQuarter}` ? scope.period : `${q.quarter.slice(0, 4)}-${String(Number(q.quarter.at(-1)) * 3).padStart(2, '0')}`)) && quarters.length === expectedQuarters.length && expectedQuarters.every(q => quarters.filter(x => x.quarter === q).length === 1) && quarters.every(q => Number.isSafeInteger(q.startStaff) && Number.isSafeInteger(q.endStaff) && q.startStaff >= 0 && q.endStaff >= 0);
      if (!valid || typeof incomeFacts.restrictedIndustry !== 'boolean') add('corporate_income', 'missing', '核实季度初末人数/资产和国家限制禁止行业事实后判断小型微利资格');
      else { const staff2 = quarters.reduce((n, q) => n + q.startStaff + q.endStaff, 0), assets2 = quarters.reduce((n, q) => n + cents(q.startAssets) + cents(q.endAssets), 0n); const small = !incomeFacts.restrictedIndustry && incomeBase <= 300000000n && staff2 <= 600 * quarters.length && assets2 <= 10000000000n * BigInt(quarters.length); const due = rateAmount(incomeBase, small ? 500 : 2500); settlement('corporate_income', due, ['corporate', 'corporateRules', 'smallRelief'], annual ? '年度按会计利润及全年税会差异/亏损计算年度应纳额，再核累计预缴' : '公司实际利润额法预缴不进行招待费等年度纳调，按累计实际利润减合规亏损计算；年度差异另列', { taxableBaseDerived: money(incomeBase), smallLowProfit: small, adjustments: annual ? taxAdjustments : [], annualOnlyAdjustments: annual ? [] : taxAdjustments, cumulative: true, filingDue: annual || incomeFacts.citFilingFrequency === 'monthly' || Number(scope.period.slice(5)) % 3 === 0, sourceRefs: refs(quarters) }); }
    }
  } else if (['individual_business', 'sole_proprietor', 'partnership'].includes(entity.kind)) {
    add('corporate_income', 'not_applicable', '个体及自然人独资合伙投资人经营所得，不能将独资企业与法人独资公司混同', {}, ['owners']);
    const owners = records.filter(r => r.type === 'owner').sort((a,b)=>String(a.ownerId??'').localeCompare(String(b.ownerId??'')));
    if (entity.incomeLevyMethod !== 'actual_accounts') add('business_income', 'missing', '个体简易/复式建账与所得税征收方式是两维；需原税种认定查账征收，核定征收另核原通知、方式及有效期，不能套35号令查账公式', {}, ['individualRules']);
    else if (!incomeReady || !owners.length || new Set(owners.map(o=>o.ownerId)).size!==owners.length || owners.some(o => !o.ownerId || o.personType !== 'natural' || o.otherBusinesses !== false || typeof o.hasComprehensiveIncome !== 'boolean')) add('business_income', 'missing', '需累计完整收入成本、自然人投资人/分配协议、其他经营主体、综合所得与费用扣除情况，法人合伙人不得套个税表', { adjustments: taxAdjustments }, ['income', 'owners']);
    else {
      const shares = owners.map(o => quantity(o.share)); requireValue(shares.reduce((a, b) => a + b, 0n) === 1000000n, 'agency_owner_shares_invalid');
      const operatingMonths=annual?12:Number(scope.period.slice(5))-(entity.businessStartDate.slice(0,4)===scope.period.slice(0,4)?Number(entity.businessStartDate.slice(5,7)):1)+1;
      let allocatedShares=0n; const calculations = owners.map((o, index) => { const before=allocatedShares;allocatedShares+=shares[index];const allocated = roundRatio(incomeBase * allocatedShares, 1000000n)-roundRatio(incomeBase * before, 1000000n); const deduction = o.hasComprehensiveIncome ? 0n : 500000n * BigInt(operatingMonths); const base = positive(allocated - deduction), gross = progressive(base, businessBrackets); const relief = entity.kind === 'individual_business' ? roundRatio(progressive(base < 200000000n ? base : 200000000n, businessBrackets), 2n) : 0n; return { ownerId: o.ownerId, allocationRounding: '按ownerId稳定排序，以累计份额差额分配分尾，合计严格等于利润', allocatedProfit: money(allocated), expenseDeduction: money(deduction),expenseDeductionMonths:operatingMonths,taxableBaseDerived: money(base), grossTax: money(gross), relief: money(relief), due: money(gross - relief), sourceRefs: o.sourceRefs }; });
      settlement('business_income', calculations.reduce((n, c) => n + cents(c.due), 0n), ['income', 'owners', 'smallRelief'], '查账经营所得由业务利润/税会差异派生，按自然人分配后计算；个体200万元内部分减半不推广到个人独资合伙', { calculations, adjustments: taxAdjustments, cumulative: true });
    }
  } else { add('corporate_income', 'unknown', '核实登记主体形式和纳税身份'); add('business_income', 'unknown', '核实登记主体形式和投资人身份'); }

  for (const id of OBLIGATION_IDS) requireValue(obligations.filter(o => o.obligationId === id).length === 1, 'agency_obligation_inventory_incomplete');
  const roles = getAccountingRoles(accounting.profileId), isEnterprise = accounting.profileId === 'enterprise-2019-general-basic-v1';
  const entry = (code, debit, credit) => ({ code, debit: money(debit), credit: money(credit) });
  const disposalOnly=accounting.pendingAssetDisposals?.filter(d=>d.period===scope.period).length===1&&output.length>0&&output.every(t=>t.factId===accounting.pendingAssetDisposals.find(d=>d.period===scope.period).factId)?accounting.pendingAssetDisposals.find(d=>d.period===scope.period):null;
  const addAccrual = (row, debitCode, amount, kind = 'expense', cumulative = false) => { if (amount <= 0n) return; entries.push({ obligationId: row.obligationId, period: scope.period, kind, cumulative,...(row.assetFactId?{assetFactId:row.assetFactId}:{}),...(row.paymentId?{paymentId:row.paymentId}:{}),reason: row.reason, sourceRefs: row.sourceRefs.length ? row.sourceRefs : records.flatMap(r => r.sourceRefs ?? []), entries: [entry(debitCode, amount, 0n), entry('2221', 0n, amount)] }); };
  for (const row of obligations.filter(o => o.status === 'calculated')) {
    if (['urban_maintenance', 'education_surcharge', 'local_education', 'stamp', 'property','cultural_construction'].includes(row.obligationId)) {const asset=disposalOnly&&['urban_maintenance','education_surcharge','local_education'].includes(row.obligationId);addAccrual(asset?{...row,assetFactId:disposalOnly.factId}:row,asset?'1606':isEnterprise?'6403':'5403',cents(row.due));}
    else if(row.obligationId==='land_appreciation')for(const calculation of row.calculations)addAccrual({...row,assetFactId:calculation.factId,paymentId:hash(stable(records.find(r=>r.id===calculation.factId).businessIdentity)),sourceRefs:calculation.sourceRefs},'1606',cents(calculation.due),'asset_disposal_tax');
    else if (row.obligationId === 'corporate_income') addAccrual(row, isEnterprise ? '6801' : '5801', cents(row.due), 'income_tax', true);
    else if (row.obligationId === 'business_income' && entity.kind === 'individual_business') addAccrual(row, roles.profitDistribution, cents(row.due), 'owner_income_tax', true);
    else if (row.obligationId === 'disability_fund') addAccrual(row, roles.adminExpense, cents(row.due), 'expense');
    else if (row.obligationId === 'other_withholding') for (const c of row.calculations) {
      const related = periodRows.filter(r => c.paymentFactIds.includes(r.id));
            if (!related.every(r => r.paymentReference && Object.hasOwn(r, 'actualNetPaid')) || sum(related, 'actualNetPaid') !== cents(c.netToRecipient)) { row.postingState='needs_payment_reconciliation'; issues.push(issue('agency_personal_payment_actual_mismatch', '程序预扣数与银行原始净支付核对未完成，不将试算当已代扣')); continue; }
      entries.push({ obligationId: 'other_withholding', period: scope.period, kind: 'withheld_payment', paymentId: c.stablePaymentIdentity, cumulative: false, reason: '支付居民劳务等原应付款，程序按项目归并计算代扣个税，银行实际净款逐项核对', sourceRefs: c.sourceRefs, entries: [entry(c.incomeCategory==='dividend'?roles.profitDistribution:'2202', cents(c.originalGross), 0n), ...(cents(c.withholding) ? [entry('2221', 0n, cents(c.withholding))] : []), ...(cents(c.netToRecipient) ? [entry('1002', 0n, cents(c.netToRecipient))] : [])] });
    }
    if (row.obligationId === 'vat' && row.exemption && cents(row.exemption) > 0n) entries.push({ obligationId: 'vat_exemption', period: scope.period, kind: 'vat_exemption', cumulative: false, reason: '根据免税资格已核期末，将本期初始VAT负债转入当期损益；CAS其他收益、小企业营业外收入，会计核对后记账', sourceRefs: row.sourceRefs, entries: [entry('2221', cents(row.exemption), 0n), entry(isEnterprise ? '6117' : '5301', 0n, cents(row.exemption))] });
  }
  for (const paymentRecord of periodRows.filter(r => r.type === 'tax_payment')) {
    const amount = cents(paymentRecord.amount); requireValue(amount >= 0n && typeof paymentRecord.paymentReference === 'string' && paymentRecord.paymentReference.length > 0, 'agency_tax_payment_original_required'); if (!amount) continue;
    if (['corporate_income', 'business_income'].includes(paymentRecord.obligationId)) requireValue(/^20\d\d$/.test(paymentRecord.assessmentYear), 'agency_income_payment_assessment_year_missing');
    const debit = paymentRecord.obligationId === 'business_income' && ['sole_proprietor', 'partnership'].includes(entity.kind) ? '1221' : '2221';
    if (debit === '1221') requireValue(paymentRecord.ownerId && paymentRecord.payerRole === 'on_behalf_of_owner', 'agency_owner_tax_payment_agency_evidence_required');
    entries.push({ obligationId: paymentRecord.obligationId, period: scope.period, kind: 'payment', paymentId: hash(stable([paymentRecord.bankAccountId ?? paymentRecord.businessIdentity?.issuerKey, paymentRecord.paymentReference, paymentRecord.obligationId])), cumulative: false, reason: debit === '1221' ? '企业代自然人投资者支付经营所得税列投资人往来，不作公司所得税费用' : '按实际完税/银行原件核销税费及预缴，保留税种所属期', sourceRefs: paymentRecord.sourceRefs, entries: [entry(debit, amount, 0n), entry('1002', 0n, amount)] });
  }
  return { version: AGENCY_TAX_RULE_VERSION, scope, status: issues.length ? 'incomplete' : 'draft', obligations, payroll, entries, issues, paymentReconciliation: current.filter(r => r.type === 'tax_payment').map(r => ({ obligationId: r.obligationId, paidOn: r.date, assessmentPeriod: r.assessmentPeriod ?? null, assessmentYear: r.assessmentYear ?? null, amount: r.amount, paymentReference: r.paymentReference, projectId: r.projectId ?? null, localityKey: r.localityKey ?? null, sourceRefs: r.sourceRefs })), sixTaxRelief,taxableProfitWorkpaper: { accountingProfit: accounting.yearProfitBeforeTax, adjustments: taxAdjustments, profitBeforeLoss: money(beforeLoss), losses: lossWorkpaper, derivedTaxableBase: money(incomeBase), coverageVerified: incomeReady }, accountantApproval: 'pending', submittable: false, periodComplete: false };
}

/** Annual API requires replay of twelve separately covered raw periods. */
export async function calculateAgencyAnnualAdjustments({ document }) {
  requireValue(document?.scope?.period?.endsWith('-12') && Array.isArray(document.records), 'agency_annual_input_invalid');
  const { replayAgencyFinancials } = await import('./agency-business-rules.mjs');
  const { accounting, tax, periodCalculations, yearEndAdjustments } = replayAgencyFinancials(document, { annual: true });
  return { version: AGENCY_TAX_RULE_VERSION, scope: document.scope, year: document.scope.period.slice(0, 4), status: accounting.yearCoverageVerified && !tax.issues.length ? 'annual_calculation_draft' : 'incomplete', accounting, periodCalculations, yearEndAdjustments, obligations: tax.obligations, adjustments: tax.taxableProfitWorkpaper, issues: [...accounting.issues, ...tax.issues], nextYearCarryState: { balanceAmounts: accounting.reportDraftInputs.amounts, sourceVouchers: [...accounting.historicalVouchers, ...accounting.vouchers].map(v => ({ sourceVoucherId: v.sourceVoucherId, contentDigest: v.contentDigest, period: v.period })), losses: tax.taxableProfitWorkpaper.losses, inventory: accounting.inventory, workInProgress: accounting.workInProgress, contracts: accounting.contractState, vatCredit: tax.obligations.find(o => o.obligationId === 'vat')?.closingCredit ?? null, eligibility: 'next_year_policy_and_opening_ledger_verification_required' }, accountantApproval: 'pending', submittable: false, periodComplete: false };
}

export const agencyTaxRuleDigest = () => hash(stable({ version: AGENCY_TAX_RULE_VERSION, sources: TAX_SOURCES, obligationIds: OBLIGATION_IDS }));

// Public law is selected by place, tax period and facts, never by a caller rate.
// Records describe the implemented conditions, not a claim to cover every relief.
const rule = (id, obligationId, region, from, url, title, locator, parameters, through = null) => ({ id, obligationId, region, from, through, source: { url, title, locator, from, ...(through ? { through } : {}) }, parameters });
const rules = [
  rule('BJ-land-2007', 'urban_land', 'CN-11', '2007-01-01', 'https://www.beijing.gov.cn/gongkai/zfxxgk/zc/gz/202112/t20211217_2564210.html', '北京市实施城镇土地使用税暂行条例办法（2007修订）', '第3、4、7条；地段级别仍须地址/原税源原件核对', { annualPerSquareMetre: ['30.00','24.00','18.00','12.00','3.00','1.50'], filingMonths: [4,10] }),
  rule('BJ-environment-2018', 'environment', 'CN-11', '2018-01-01', 'https://sfj.beijing.gov.cn/sfj/index/483217/517498/index1.html', '北京市人大常委会关于应税大气污染物和水污染物环保税适用税额的决定', '2017-12-01通过；第一、二项', { airPerEquivalent: '12.00', waterPerEquivalent: '14.00' }),
  rule('BJ-deed-2021', 'deed', 'CN-11', '2021-09-01', 'https://www.beijing.gov.cn/zhengce/zhengcefagui/202107/t20210731_2453282.html', '北京市人大常委会关于北京市契税具体适用税率等有关事项的决定', '第一项；个人家庭住房优惠另依全国规定', { basisPoints: 300 }),
  rule('BJ-water-2024', 'water_resource', 'CN-11', '2024-12-01', 'https://www.beijing.gov.cn/zhengce/zhengcefagui/202504/W020250429560367922969.pdf', '京财税〔2025〕66号北京市水资源税办法及附表', '第5至18、30条及公报第10页；与全国2024年第28号同步实施，不以发布日期推迟', { surface: { public_supply:'1.4', agriculture_excess:'0.06', rural_drinking:'0.1', special:'153',other:'2' }, underground:{public_supply:'2.8',agriculture_excess:'0.08',rural_drinking:'0.2',self_supply:'3.8',special:'160',other:'3.8'}, generationPerKwh:'0.005',dewateringRecovery:'0.6',dewateringDischarge:'4.3',heatPumpRechargePerThousandM3:'0.8',publicNetworkLossBasisPoints:800 }),
];
// Provincial basic business rates. Source forms are explicit; official execution
// explanations prove only the basic rate, never every provincial relief branch.
const deed = [
  ['CN-12',300,'https://fg.taxation.cn/law_data_2021/Law_data2021/2021_dffg/2021_tjs/202212/t20221217_169051.html','天津市人大决定（税务出版社法规库全文）','original_decision'],
  ['CN-13',400,'https://www.hbrd.gov.cn/system/2021/08/04/100734420.shtml','河北省人大常委会契税决定','original_decision'],
  ['CN-14',300,'https://policy.mofcom.gov.cn/claw/clawContent.shtml?id=90389','山西省人大常委会公告92号','official_legal_republication'],
  ['CN-15',300,'https://policy.mofcom.gov.cn/claw/clawContent.shtml?id=90394','内蒙古自治区人大常委会契税决定','official_legal_republication'],
  ['CN-21',300,'https://www.fuxin.gov.cn/content/2023/751805.html','辽宁省人大调整契税决定（2023起）','original_decision','2023-01-01'],
  ['CN-22',300,'https://jlrd.gov.cn/zwgk/ysjd/202108/t20210805_8170686.html','吉林财政省人大原说明与批准决定关联','official_explanation_and_approval'],
  ['CN-23',300,'https://www.hlj.gov.cn/hlj/c107857/202111/c00_30584599.shtml','黑龙江省政府发布财政厅现行执行说明','official_execution_explanation'],
  ['CN-32',300,'https://jiangsu.chinatax.gov.cn/art/2021/8/4/art_7716_32761.html','江苏省契税具体适用税率决定','original_decision'],
  ['CN-33',300,'https://policy.mofcom.gov.cn/claw/clawContent.shtml?id=93742','浙江省人大常委会公告54号','official_legal_republication'],
  ['CN-34',300,'https://jnjzq.chizhou.gov.cn/OpennessContent/show/1105295.html','安徽省人大常委会公告49号','official_legal_republication'],
  ['CN-35',300,'https://czt.fujian.gov.cn/zwgk/zfxxgk/fdzdgknr/czzjgl/zjglbf/202108/t20210812_5673792.htm','闽财税〔2021〕15号','original_execution_notice'],
  ['CN-36',300,'https://qyp.nc.gov.cn/qypqrmzf/lzyj24/202110/836f8b3bcfee461888470772def16834.shtml','江西省税务局契税实施公告','original_execution_notice'],
  ['CN-37',300,'https://www.weihai.gov.cn/art/2025/7/17/art_162816_301.html','山东契税基本率2025政府现行确认','official_execution_explanation'],
  ['CN-41',400,'https://fg.taxation.cn/law_data_2021/Law_data2021/2021_dffg/2021_hns/202212/t20221216_168973.html','河南省税务局2021年第6号公告','original_execution_notice'],
  ['CN-42',300,'https://www.hppc.gov.cn/rdgz/zyfb/jdjy/1859217551440392194.html','湖北省人大常委会契税决定','original_decision'],
  ['CN-43',400,'https://www.hnrd.gov.cn/content/2021/05/27/9406217.html','湖南省人大常委会契税决定','original_decision'],
  ['CN-44',300,'https://www.hengqin.gov.cn/lab/flfg/sfg/content/post_3508867.html','广东省人大常委会契税决定','official_legal_republication'],
  ['CN-45',300,'https://www.gxrd.gov.cn/article.php?act=subject&id=172168','广西壮族自治区人大常委会契税决定','original_decision'],
  ['CN-46',300,'https://policy.mofcom.gov.cn/claw/clawContent.shtml?id=90443','海南省人大常委会契税决定','official_legal_republication'],
  ['CN-50',300,'https://www.cqrd.gov.cn/site/article/1211401109855113216/web/content_1211401109855113216.html','重庆市人大常委会契税决定','original_decision'],
  ['CN-51',300,'https://www.scspc.gov.cn/1329/202107/167460.html','四川省人大常委会契税决定','original_decision'],
  ['CN-52',300,'https://policy.mofcom.gov.cn/claw/clawContent.shtml?id=91110','贵州省人大常委会契税决定','official_legal_republication'],
  ['CN-53',300,'https://www.ynrd.gov.cn/html/2021/changweihuigonggao_0812/13482.html','云南省人大常委会契税决定','original_decision'],
  ['CN-54',300,'https://www.xzdw.gov.cn/fbt/gsgg/202108/t20210828_193715.html','西藏自治区2021契税开征公告','official_execution_notice'],
  ['CN-61',300,'https://czt.shaanxi.gov.cn/xxgk/zdgk/jcygk/202502/P020250220575110234746.pdf','陕西财政官方法规汇编契税决定','official_legal_republication'],
  ['CN-62',300,'https://www.gsrdw.gov.cn/html/2021/zdsx_0728/20151.html','甘肃省人大常委会契税决定','original_decision'],
  ['CN-63',300,'https://qh.people.com.cn/n2/2021/0825/c389195-34883573.html','青海省税务局供稿基本率与人大批准关联','tax_authority_execution_explanation'],
  ['CN-64',300,'https://www.mof.gov.cn/zhengwuxinxi/xinwenlianbo/nixiacaizhengxinxilianbo/202105/t20210520_3705771.htm','财政部发布宁夏基本税率确认','official_execution_explanation'],
  ['CN-65',300,'https://www.xjpcsc.gov.cn/article/bbdcd57252654d5c96ec785a91887791','新疆维吾尔自治区人大契税决定','original_decision'],
];
for(const [region,basisPoints,url,title,evidenceForm,from='2021-09-01'] of deed)rules.push({...rule(`${region}-deed-${from}`,'deed',region,from,url,title,'仅第一项或基本率执行说明；企业普通购房，不涵盖征收/不可抗力/家庭住房特殊减免',{basisPoints}),evidenceForm});
rules.find(r=>r.obligationId==='deed'&&r.region==='CN-41').parameters.housingBasisPoints=300;
rules.find(r=>r.obligationId==='deed'&&r.region==='CN-41').source={...rules.find(r=>r.obligationId==='deed'&&r.region==='CN-41').source,url:'https://zwfw.zhumadian.gov.cn/tongzhigonggao/308556.jhtml',title:'河南契税省人大决定执行公告',locator:'住房3%、其他4%；不是所有房屋3%，不移入河北个人普通住房条件'};
rules.find(r=>r.obligationId==='deed'&&r.region==='CN-22').relatedSources=[{url:'https://jlrd.gov.cn/ztzl/ysjd/yssc/202108/t20210805_8170720.html',title:'吉林省人大常委会关于吉林省契税具体适用税率等事项的决定',locator:'2021批准决定，关联原财政说明'},{url:'https://czt.jl.gov.cn/zwgk/jcjggk/202209/P020220908621518335059.pdf',title:'吉林省2021执行后财政预算报告',locator:'契税适用税率3%已执行确认；不仅依赖议案'}];
rules.push({...rule('SH-deed-2021','deed','CN-31','2021-09-01','https://shanghai.chinatax.gov.cn/tax/zcfw/zcfgk/qs/202108/t459945.html','沪财发〔2021〕4号','第一项；到期后不沿用旧文件',{basisPoints:300},'2026-08-31'),evidenceForm:'original_execution_notice'});
rules.push({...rule('SH-deed-2026','deed','CN-31','2026-09-01','https://www.shanghai.gov.cn/gwk/search/content/xxfboswf0000003770','沪财发〔2026〕5号','2021年第4号基本率延续文件；不据此扩展特殊减免',{basisPoints:300}),evidenceForm:'original_extension_notice'});
rules.push(rule('BJ-car-2012','vehicle_vessel','CN-11','2012-01-01','https://www.beijing.gov.cn/zhengce/zfwj/zfwj/szfwj/201905/t20190523_72613.html','京政发〔2011〕77号及政府原附件图','原表https://www.beijing.gov.cn/fuwu/bmfw/bmzt/gmxkc/mc/201802/W020200609743282644571.png；限行期间乘用车全年减2个月，新取得不足全年减免折算待核',{passengerAnnual:['300.00','420.00','480.00','900.00','1920.00','3480.00','5280.00'],passengerDisplacementUpper:['1','1.6','2','2.5','3','4'],fullYearRestrictedTrafficMonths:2}));
const normalized = r => ({...r,ruleId:r.id,revision:'1',entityKinds:['company','individual_business','sole_proprietor','partnership'],publishedOn:null,checkedOn:'2026-10-25'});
export function listAgencyPublicRegionalRules() { return structuredClone(rules.map(normalized)); }
export function selectAgencyRegionalRule(obligationId, region, date) { const found=rules.filter(r => r.obligationId === obligationId && r.region === region && r.from <= date && (!r.through || r.through >= date));if(found.length>1)throw Object.assign(new Error('agency_regional_rule_conflict'),{code:'agency_regional_rule_conflict'});return structuredClone(found.length?normalized(found[0]):null); }

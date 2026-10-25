// One code-owned policy directory. Candidate notices never activate formula code.
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync, openSync, closeSync, writeSync, unlinkSync, fstatSync, fsyncSync } from 'node:fs';
import { resolve, dirname, join, parse, relative, isAbsolute } from 'node:path';
import { listAgencyPublicRegionalRules } from './agency-regional-rules.mjs';
const source = (url,title,locator,from) => ({url,title,locator,from});

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
  housing2019:{url:'https://gjj.beijing.gov.cn/web/zwgk61/_300587/_300688/373625/index.html',title:'住房公积金管理条例（2019修订）',documentNumber:'国务院令第262号发布、2019修订',locator:'第2、16至18、23条；旧版适用至2026-09-19，不推个体一律强制',from:'2019-03-24',through:'2026-09-19',issuedOn:'2019-03-24',publishedOn:'2019-05-20',publicationKind:'official_mirror_page',checkedOn:'2026-10-25',verification:'official_text_and_revision_dates_checked'},
  housing2026:{url:'https://www.mee.gov.cn/zcwj/gwywj/202608/t20260820_1164286.shtml',title:'住房公积金管理条例（2026修订，国务院令844号）',documentNumber:'国务院令第844号',locator:'第16、17、18、23、49条；个体/非全日制/灵活就业自愿，地方办法另核',from:'2026-09-20',issuedOn:'2026-08-10',publishedOn:'2026-08-20',publicationKind:'official_mirror_page',checkedOn:'2026-10-25',verification:'official_text_and_revision_dates_checked',replaces:['housing2019']},
});
export const AGENCY_EXTENDED_TAX_SOURCES = Object.freeze({
  urban_land: source('https://fgk.chinatax.gov.cn/zcfgk/c100010/c5194445/content.html','城镇土地使用税暂行条例（2019修订）','第2至9条；不能从国家税额幅度任选一数','2019-03-02'),
  vehicle_vessel: source('https://www.chinatax.gov.cn/n810341/n810765/n812156/n812454/c1185627/content.html','车船税法实施条例','第4至6、19至24条；第25条五年临免已届满','2012-01-01'),
  deed: source('https://tianjin.chinatax.gov.cn/11200000000/0300/030004/03000418/p20230223141633287.shtml','中华人民共和国契税法','第1至6、9条；承受权属方、不含VAT价格、差额及减免按事实','2021-09-01'),
  farmland_occupation: source('https://www.mof.gov.cn/zhengwuxinxi/caizhengxinwen/201901/t20190102_3112014.htm','中华人民共和国耕地占用税法','第2至12条；基本农田加按150%、特别设施2元/㎡、复垦退税另核','2019-09-01'),
  resource: source('https://www.mee.gov.cn/ywgz/fgbz/fl/202303/t20230314_1019553.shtml','中华人民共和国资源税法','第1至8、10至12条及税目税率表；2020新法替代旧条例','2020-09-01'),
  tobacco: source('https://www.chinatax.gov.cn/chinatax/n810341/n810765/n3359382/201807/c3730820/content.html','财税〔2018〕75号及烟叶税法','法定收购价款加统一10%价外补贴后20%，不以实际补贴替代','2018-07-01'),
  consumption: source('https://www.chinatax.gov.cn/n810341/n810765/n812171/n812680/c1190924/content.html','消费税暂行条例','第1、4至9条；税目后续调整另选有效文件','2009-01-01'),
  cosmetics: source('https://www.chinatax.gov.cn/chinatax/n810341/n810765/n1990035/201609/c2457669/content.html','财税〔2016〕103号','高档化妆品15%，普通化妆品取消；10元/毫升克或15元/片张','2016-10-01'),
  environment: source('https://tianjin.chinatax.gov.cn/11200000000/0300/030004/03000418/20260210153839770.shtml','环境保护税法（2025修正）','第7至13条及附表；VOC仅依法试点不全国猜定','2025-10-28'),
  water_resource: source('https://www.mof.gov.cn/jrttts/202410/t20241016_3945718.htm','财税〔2024〕28号水资源税改革试点实施办法','自2024-12-01全国实施；地方具体税额另核，不使用最低平均税额代替','2024-12-01'),
  customs: source('https://www.mof.gov.cn/jrttts/202404/t20240429_3933790.htm','中华人民共和国关税法','完税价格、税率适用及从价/从量/复合计税；具体年度税则另核','2024-12-01'),
  vessel_tonnage: source('https://zhejiang.chinatax.gov.cn/art/2018/10/26/art_25716_82710.html','船舶吨税法（2018修正）','第1至9、15条及税率表；每张执照而非每次入港重复征税','2018-10-26'),
  shaleGasRelief:{...source('https://www.mof.gov.cn/jrttts/202309/t20230928_3909601.htm','关于继续实施页岩气减征资源税优惠政策的公告','页岩气6%减征30%，不由specialRelief布尔取消','2023-09-20'),documentNumber:'财政部 税务总局公告2023年第46号',through:'2027-12-31',issuedOn:'2023-09-20',publishedOn:'2023-09-27',checkedOn:'2026-10-25',verification:'official_text_checked_selected_branch'},
  customs2026:{...source('https://gss.mof.gov.cn/gzdt/zhengcefabu/202512/P020251229510521217364.pdf','2026年进口商品暂定税率表','2026关税调整方案附件1；非ex完整号列，其他年度/协定/加征另核','2026-01-01'),documentNumber:'税委会公告2025年第11号附件1',through:'2026-12-31',publishedOn:'2025-12-29',checkedOn:'2026-10-25',verification:'official_attachment_selected_rows_checked'},
  euDairyCountervailing:{...source('https://www.mofcom.gov.cn/zcfb/zgdwjjmywg/art/2026/art_99c97fc35f254309aab24ec90777d5c8.html','对原产于欧盟的进口相关乳制品反补贴调查最终裁定','正文及附件2生产商税率；终裁前保证金追溯另核，不按未知厂商猜税率','2026-02-13'),documentNumber:'商务部公告2026年第9号',through:'2031-02-12',issuedOn:'2026-02-12',publishedOn:'2026-02-12',checkedOn:'2026-10-25',verification:'official_text_and_attachment_selected_manufacturers_checked'},
  importVatScope:{...source('https://szs.mof.gov.cn/zhengcefabu/202601/P020260131621581319474.pdf','增值税征税具体范围有关事项及附件1','农产品水产品/未炒果仁9%；奶酪/加工乳品不属鲜奶9%范围，乳清用途未核不推断','2026-01-01'),documentNumber:'财政部 税务总局公告2026年第9号附件1',publishedOn:'2026-01-31',checkedOn:'2026-10-25',verification:'official_attachment_selected_rows_checked'},
  tonnageOriginalTable:{...source('https://faolex.fao.org/docs/pdf/chn172978.pdf','全国人大2018修正船舶吨税法原版（FAO法库保存）','第4页完整税率表；原NPC页失联，保存原版来源形式','2018-10-26'),documentNumber:'中华人民共和国船舶吨税法税目税率表',publicationKind:'international_legal_archive_of_npc_original',checkedOn:'2026-10-25',verification:'archived_original_table_selected_rows_checked'},
  environmentCalculation:{...source('https://www.mof.gov.cn/gkml/caizhengwengao/wg2018/wg201805/201808/t20180820_2993667.htm','关于环境保护税有关问题的通知','三固废余额；四噪声超标分贝四舍五入取整后选档，昼/夜各不足15分别减半','2018-03-30'),documentNumber:'财税〔2018〕23号',issuedOn:'2018-03-30',publishedOn:'2018-08-20',checkedOn:'2026-10-25',verification:'official_text_checked_selected_branch'},
  vehicleEnergyPolicy2018:{...source('https://tianjin.chinatax.gov.cn/11200000000/0300/030004/03000418/20251013090258979.shtml','关于节能新能源车船享受车船税优惠政策的通知','2018优惠基础；2027仅列明汽车条款废止，船舶第二条（三）不随之废止','2018-07-10'),documentNumber:'财税〔2018〕74号',issuedOn:'2018-07-10',checkedOn:'2026-10-25',verification:'official_text_scope_checked',partiallyRepealedFrom:'2027-01-01'},
  vehicleEnergyCatalogue:{...source('https://fgk.chinatax.gov.cn/zcfgk/c100013/c5243561/content.html','调整享受车船税优惠的节能新能源汽车产品技术要求','第八十二批起新目录，旧目录取得过渡另核；已实现新目录分支','2026-01-01'),documentNumber:'工业和信息化部 财政部 税务总局公告2025年第25号',issuedOn:'2025-09-29',checkedOn:'2026-10-25',verification:'official_text_checked_selected_branch'},
  vehicleEnergyRepeal:{...source('https://tianjin.chinatax.gov.cn/11200000000/0300/030004/03000418/20260706142433259.shtml','调整节能汽车新能源汽车车船税优惠政策','仅取消列明汽车优惠，含以前取得汽车；不取消新能源船舶优惠','2027-01-01'),documentNumber:'财政部 税务总局 工业和信息化部公告2026年第19号',issuedOn:'2026-07-02',publishedOn:'2026-07-02',checkedOn:'2026-10-25',verification:'official_text_checked_selected_branch',partiallyReplaces:['vehicleEnergyPolicy2018','vehicleEnergyCatalogue']},
  newEnergyShip:{...source('https://www.miit.gov.cn/xwdt/gxdt/sjdt/art/2020/art_b14fe3b2b48a43f2a4dee8bf21444554.html','符合相关标准的新能源船舶可以享受车船税免税优惠','财税2018[74]第二条（三）；主推进纯天然气、微柴油热值不超5%、船检证书字段；条件分支尚未实现，不按全额认定','2018-07-10'),documentNumber:'财税〔2018〕74号第二条（三）官方说明',publishedOn:'2018-08-03',checkedOn:'2026-10-25',verification:'official_explanation_scope_checked_formula_unsupported'},
});
export const OBLIGATION_IDS = Object.freeze(['vat', 'vat_prepayment', 'corporate_income', 'business_income', 'salary_withholding', 'other_withholding', 'urban_maintenance', 'education_surcharge', 'local_education', 'stamp', 'property', 'urban_land', 'vehicle_vessel', 'consumption', 'resource', 'water_resource', 'environment', 'deed', 'land_appreciation', 'farmland_occupation', 'vehicle_purchase', 'customs', 'cultural_construction', 'union_funds', 'tobacco', 'vessel_tonnage', 'social_insurance', 'housing_fund', 'disability_fund']);
export const AGENCY_ACCOUNTING_SOURCES = Object.freeze([
  { url: 'https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852319878.pdf', title: '小企业会计准则', locator: '第11至14、49、63至65条；职工薪酬按提供服务期及受益对象归集' },
  { url: 'https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852734144.pdf', title: '小企业会计准则附录', locator: '存货/生产成本/应收应付/收入成本科目与报表' },
  { url: 'https://kjs.mof.gov.cn/zt/kjzzss/kuaijizhunzeshishi/200806/t20080618_46239.htm', title: '企业会计准则第9号——职工薪酬（2014修订）', locator: '第5、7条；只在适用CAS profile使用，个体不冒用' },
  { url: 'https://kjs.mof.gov.cn/zt/kjzzss/kuaijizhunzeshishi/201709/t20170907_2694006.htm', title: '企业会计准则第14号——收入', locator: '第11至13条、履约成本与销售退回条款' },
]);
export const AGENCY_RULE_CATALOG_VERSION = 'agency-rule-catalog/1';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const need = (v,code) => { if(!v)fail(code); };
const stable = v => Array.isArray(v)?`[${v.map(stable).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`:JSON.stringify(v);
const digest = v => createHash('sha256').update(typeof v==='string'?v:stable(v)).digest('hex');
const clone = structuredClone;
const DATE = /^20\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const validDate = d => typeof d==='string'&&DATE.test(d)&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
const supported = {from:'2026-01-01',through:'2027-12-31'};
const allKinds = ['company','individual_business','sole_proprietor','partnership'];
// This is a directory of existing fixed functions, not an expression language.
const taxTopics = [
 ['vat','增值税',['sale','sale_return','service_complete','purchase','import_export','rental','construction_billing'],['vat','vatRelief'],'境内普通交易及已核进口分支；跨境/特殊差额仍有缺口'],
 ['vat_prepayment','增值税预缴',['construction_cash','construction_tax_trigger','rental','subcontract_payment'],['prepayment','prepaymentSurcharge'],'按原项目与预缴地、实际收付归集'],
 ['corporate_income','企业所得税',['income_evidence','quarter_profile','prior_loss'],['corporate','corporateRules'],'实际利润预缴与全年原件年度调整；不负责年度流程'],
 ['business_income','经营所得',['owner','income_evidence'],['income','owners','individualRules','businessAdvance'],'查账自然人投资者；核定/法人合伙人/多处经营等未全覆盖'],
 ['salary_withholding','工资薪金扣缴',['payroll','contribution_notice'],['withholding','social'],'原工资及官方社公明细；地区参数试算不能升级正式应缴'],
 ['other_withholding','其他个人款项扣缴',['personal_payment','personal_rental_tax'],['income','withholding','rentalWithholding'],'已核居民劳务/稿酬/特许/股息及租赁；非居民/包税/部分清偿仍待核'],
 ['urban_maintenance','城市维护建设税',['tax_location','excise_product'],['smallRelief','prepaymentSurcharge'],'VAT/消费税及预缴地基础、六税资格均须已核'],
 ['education_surcharge','教育费附加',['tax_location','excise_product'],['educationRelief','smallRelief'],'按纳税人整期销售额、实际VAT/消费税及减免条件'],
 ['local_education','地方教育附加',['tax_location','excise_product'],['localEducation','educationRelief'],'全国通常2%；不采用尚未生效草案'],
 ['stamp','印花税',['contract'],['stamp','smallRelief'],'按原合同法定税目/含税列示及六税身份'],
 ['property','房产税',['property_asset','rental','property_acquisition','property_disposal'],['property','housingProperty','rentFreeProperty'],'已核从租分支；从价/免租仍需地区原值规则'],
 ['urban_land','城镇土地使用税',['land_asset'],['urban_land','smallRelief','sixTaxProcedure','sixTaxExamples'],'北京六级土地额；合同/批准推法定起月，按各月六税资格分段'],
 ['vehicle_vessel','车船税',['vehicle','vehicle_acquisition'],['vehicle_vessel','vehicleEnergyPolicy2018','vehicleEnergyCatalogue','vehicleEnergyRepeal','newEnergyShip'],'全国船舶及北京全年存量乘用车；终止/部分年度地区减免未全覆盖'],
 ['consumption','消费税',['excise_product'],['consumption','cosmetics'],'整笔原销售同税唯一归属；高档化妆品等列明国内生产销售税目；不代表全部环节税目'],
 ['resource','资源税',['extraction'],['resource','shaleGasRelief','smallRelief','sixTaxProcedure','sixTaxExamples'],'国家固定率列明资源及页岩气优惠；地区浮动税目未全覆盖'],
 ['water_resource','水资源税',['water_extraction'],['water_resource'],'全国义务识别＋北京原取水口税额表，不将最低平均额充具体率'],
 ['environment','环境保护税',['pollutant_discharge'],['environment','environmentCalculation'],'列明监测污染物/固废/工业噪声；VOC试点及其他复杂条件仍待核'],
 ['deed','契税',['property_acquisition'],['deed'],'逐省基本税率；普通企业购置，住房/特殊减免条件另核'],
 ['land_appreciation','土地增值税',['property_disposal','land_appreciation_unit'],['landAppreciation','landAppreciation2026'],'旧商房评估法原基本对象汇总；开发清算/地方预征等待核'],
 ['farmland_occupation','耕地占用税',['farmland_use'],['farmland_occupation','smallRelief','sixTaxProcedure','sixTaxExamples'],'已核国家设施分支；普通厂房地区税额等仍待补'],
 ['vehicle_purchase','车辆购置税',['vehicle_acquisition','vehicle_catalogue_entry'],['vehiclePurchase','electricVehicle','electricVehicle2026'],'国内购买自用及2026–27合格新能源限额；进口/自制等待核'],
 ['customs','关税及进口相关税',['import_export'],['customs','customs2026','euDairyCountervailing','importVatScope','vat'],'2026列明非ex号列/原产地/厂商；其他年度税则及特殊贸易待核'],
 ['cultural_construction','文化事业建设费',['advertising','entertainment'],['cultural','culturalEntertainment','culturalRelief'],'实际VAT税期归并；已核中央预算减半，地方归属仍待核'],
 ['union_funds','工会经费',['union','union_payment','payroll'],['union','wageTotal'],'建会普通2%拨缴、劳动受益期计提；筹备/代收留成返还待核'],
 ['tobacco','烟叶税',['tobacco_leaf_purchase'],['tobacco'],'合法单位烤/晾烟叶收购；统一10%价外补贴及采购成本'],
 ['vessel_tonnage','船舶吨税',['foreign_port_vessel_entry'],['vessel_tonnage','tonnageOriginalTable'],'中国籍原执照税率及拖轮换算；其他国籍协定仍待核'],
 ['social_insurance','社会保险',['payroll','contribution_notice','contribution_payment'],['social'],'原官方核定单真实应缴/付款；任意参数仅试算'],
 ['housing_fund','住房公积金',['payroll','contribution_notice','contribution_payment'],['housing2019','housing2026'],'原官方核定及付款核销；公开地区公式尚未接线，个体自愿条件不当全体强制'],
 ['disability_fund','残保金',['annual_employment','payroll'],['disability'],'全国小企业免征及公式试算；非零地方完整链尚未接线'],
];
const required = {
 urban_land:['landRightDocumentNumber','acquisitionKind','areaSquareMetres','taxArea','use'],
 vehicle_vessel:['registrationNumber','vehicleClass','acquiredOn','energyKind'],
 consumption:['productKind','taxStage','salesExcludingVat','saleFactIds','specialTreatment'],
 resource:['resourceKind','productionPlace','use','separatelyAccounted','saleFactIds'],
 water_resource:['intakeLocationRegion','intakeId','waterKind','use','quantityCubicMetres','permitNumber'],
 environment:['monitoringReportNumber','emissionCategory','directDischarge','assessmentMonth'],
 deed:['rightsContractNumber','transactionKind','assetKind','propertyUse','priceExcludingVat','propertyId','contractSignedOn'],
 farmland_occupation:['approvalNoticeNumber','noticeReceivedOn','areaSquareMetres','projectUse','basicFarmland'],
 customs:['direction','customsDeclarationNumber','hsCode','originCountry','originCertificateNumber','tradeMode','invoiceCny'],
 tobacco:['purchasePermitNumber','leafKind','purchasePrice','purchaseInvoiceNumber','relatedBusinessFactId'],
 vessel_tonnage:['vesselId','tonnageCertificateNumber','nationalityCertificateNumber','licenseNumber','licenseStartsOn','licenseEndsOn','vesselClass','nationality'],
};
const physical = {urban_land:'taxRegion：土地所在地',deed:'taxRegion：承受不动产所在地',environment:'taxRegion：排放所在地（全国固定额分支除外）',water_resource:'intakeLocationRegion：取水口所在地',vehicle_vessel:'taxRegion：车辆登记地（全国船舶固定额除外）',farmland_occupation:'taxRegion/所在区：实际占地所在地'};
const taxRules = taxTopics.map(([id,title,recordTypes,sourceKeys,limitations])=>({
 ruleId:`agency.tax.${id}`,revision:'1',kind:'tax',obligationId:id,title,scope:{kind:'public'},
 entityKinds:id==='corporate_income'?['company']:id==='business_income'?['individual_business','sole_proprietor','partnership']:id==='tobacco'?['company']:allKinds,
 vatStatuses:['small','general'],triggers:{recordTypes,inventoryObligation:id},locationRole:physical[id]??'按原事实核税务管辖/项目地点，不以行业推所在地',
 requiredOriginalFacts:required[id]??['原合同/发票/权属/用工及完整资料清单；按实际分支列缺项'],
 legalEffective:{from:null,through:null,detail:'各来源分项有效期见sources，不把工程支持期冒作法律生效期'},implementationPeriod:supported,
 sources:sourceKeys.map(k=>{const s=AGENCY_EXTENDED_TAX_SOURCES[k]??TAX_SOURCES[k];need(s?.url&&s.title&&s.locator,'agency_rule_source_registration_invalid');return {sourceId:k,...s,checkedOn:s.checkedOn??(Object.hasOwn(AGENCY_EXTENDED_TAX_SOURCES,k)?'2026-10-25':'2026-10-24'),verification:s.verification??(Object.hasOwn(AGENCY_EXTENDED_TAX_SOURCES,k)?'public_text_checked_selected_branch':'carried_from_reviewed_baseline'),publishedOn:s.publishedOn??null};}),
 composition:{mode:'national_obligation_plus_regional_parameters_plus_eligible_relief',priority:100,conflictPolicy:'相同参数槽存在多个同时有效且无明确替代关系时阻断；地区不覆盖国家义务/减免',supersedes:[]},
 exclusions:[limitations],implementationStatus:'limited_fixed_functions',validationStatus:Object.hasOwn(required,id)?'selected_branches_selftested':'reviewed_baseline_selected_branches',
 code:{path:Object.hasOwn(required,id)?'server/agency-extended-tax-rules.mjs':'server/agency-tax-rules.mjs',entrypoint:Object.hasOwn(required,id)?'calculateAgencyExtendedTax':'calculateAgencyObligations'},
 capabilityIds:['agency.workpaper','agency.annual-calculation'],effect:'read',amountsDerivedByProgram:true,
}));
const industries = ['service','trade','ecommerce','catering','manufacturing','construction','transport','rental_property'];
const accountingRules = industries.map(industry=>({ruleId:`agency.accounting.${industry}`,revision:'1',kind:'accounting',title:`${industry}会计及成本`,scope:{kind:'public'},entityKinds:allKinds,vatStatuses:['small','general'],triggers:{industry},locationRole:'原业务履约及账套准则事实',requiredOriginalFacts:['原始业务资料及原件指针','实际采用会计准则','履约/存货/用工/资产及收付款事实'],implementationPeriod:supported,legalEffective:{from:null,through:null},sources:clone(AGENCY_ACCOUNTING_SOURCES),composition:{mode:'business_then_non_income_tax_then_income_tax',priority:100,supersedes:[]},exclusions:['仅现固定分支，复杂租赁/工程/核定等依实际issues；不以行业概括全部业务已完成'],implementationStatus:'limited_fixed_functions',validationStatus:'reviewed_baseline_selected_branches',code:{path:'server/agency-business-rules.mjs',entrypoint:'evaluateAgencyAccounting'},capabilityIds:['agency.workpaper','agency.posting'],effect:'read'}));
const navigationRules = [
 {ruleId:'agency.reports.profile-mapping',revision:'1',kind:'reports',title:'账套准则及报表映射',scope:{kind:'public'},entityKinds:allKinds,implementationPeriod:supported,requiredOriginalFacts:['实际profileId及科目/期初/凭证/原件完整性'],exclusions:['复用既有profile/report registry；个体语义底稿不冒称1997完整制度'],code:{path:'server/accounting-report-rules.mjs',entrypoint:'evaluateAccountingStatement'},capabilityIds:['agency.workpaper'],implementationStatus:'limited_fixed_functions',validationStatus:'reviewed_baseline_selected_branches'},
 {ruleId:'agency.annual.raw-calculation',revision:'1',kind:'annual',title:'全年原件税会调整计算',scope:{kind:'public'},entityKinds:allKinds,implementationPeriod:supported,requiredOriginalFacts:['实际经营月份至12月全部同企业/同账套/同年原件session','需要时显式只读dbPath'],exclusions:['只计算；年度流程编排由原annual-close能力负责'],code:{path:'server/agency-business.mjs',entrypoint:'buildAgencyAnnualWorkpaper'},capabilityIds:['agency.annual-calculation'],implementationStatus:'limited_fixed_functions',validationStatus:'reviewed_baseline_selected_branches'},
 {ruleId:'legacy.vat.selected-q1-q2',revision:'1',kind:'legacy_reference',title:'独立Q1/Q2选定表栏工程规则',scope:{kind:'public'},implementationPeriod:{from:'2026-01-01',through:'2026-06-30'},requiredOriginalFacts:['该registry自身engineeringScope全部条件'],exclusions:['仅独立旧入口，不把其整元/Q1/Q2限制套给agency全国规则'],code:{path:'server/tax-rule-registry.mjs',entrypoint:'getVatRules/getVatQ2Rules'},capabilityIds:[],implementationStatus:'separate_legacy_registry',validationStatus:'separate_suite'},
];
function regionalDescriptors(){return listAgencyPublicRegionalRules().map(r=>({...r,ruleId:`agency.region.${r.ruleId??r.id}`,revision:r.revision??'1',kind:'regional_parameter',title:r.source.title,scope:{kind:'public'},entityKinds:r.entityKinds??allKinds,implementationPeriod:supported,legalEffective:{from:r.from,through:r.through??null},publishedOn:null,checkedOn:'2026-10-25',locationRole:physical[r.obligationId],requiredOriginalFacts:['原标的/取水口/排放地/登记地及适用条件；不以企业注册地址兜底'],composition:{mode:'adds_regional_parameter',parameterSlot:`${r.obligationId}:${r.region}`,priority:100,supersedes:r.id==='SH-deed-2026'?['agency.region.SH-deed-2021']:[]},sources:[r.source,...r.relatedSources??[]],implementationStatus:'selected_parameters_only',validationStatus:'selected_branches_selftested',code:{path:'server/agency-regional-rules.mjs',entrypoint:'selectAgencyRegionalRule'},capabilityIds:['agency.workpaper'],exclusions:['只有列明条件和基本税额；不推定该地区所有税费/减免已实现']}));}
function catalog(){return [...taxRules,...accountingRules,...navigationRules,...regionalDescriptors()];}
export function getAgencyHousingSourceKeys(period){need(/^202[67]-(0[1-9]|1[0-2])$/.test(period),'agency_rule_implementation_period_unsupported');const from=`${period}-01`,through=new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5)),0)).toISOString().slice(0,10);return ['housing2019','housing2026'].filter(k=>TAX_SOURCES[k].from<=through&&(!TAX_SOURCES[k].through||TAX_SOURCES[k].through>=from));}
export function agencyRuleCatalogDigest(){return digest({version:AGENCY_RULE_CATALOG_VERSION,rules:catalog()});}
function dateRange(filters){for(const key of ['from','through'])if(filters[key]!==undefined)need(validDate(filters[key]),'agency_rule_filter_date_invalid');need(!filters.from||!filters.through||filters.from<=filters.through,'agency_rule_filter_range_invalid');}
function matchesFilter(r,f){const range=r.kind==='regional_parameter'?r.legalEffective:r.implementationPeriod;return (!f.ruleId||r.ruleId===f.ruleId)&&(!f.obligationId||r.obligationId===f.obligationId)&&(!f.kind||r.kind===f.kind)&&(!f.region||!r.region||r.region===f.region)&&(!f.entityKind||!r.entityKinds||r.entityKinds.includes(f.entityKind))&&(!f.from||!range?.through||range.through>=f.from)&&(!f.through||!range?.from||range.from<=f.through);}
export function listAgencyRules(filters={}){
 need(filters&&typeof filters==='object'&&!Array.isArray(filters)&&Object.keys(filters).every(k=>['ruleId','obligationId','kind','region','entityKind','from','through','offset','limit'].includes(k)),'agency_rule_filters_invalid');dateRange(filters);const offset=filters.offset??0,limit=filters.limit??20;need(Number.isInteger(offset)&&offset>=0&&Number.isInteger(limit)&&limit>0&&limit<=50,'agency_rule_pagination_invalid');const rows=catalog().filter(r=>matchesFilter(r,filters));
 return clone({version:AGENCY_RULE_CATALOG_VERSION,catalogDigest:agencyRuleCatalogDigest(),total:rows.length,offset,limit,nextOffset:offset+limit<rows.length?offset+limit:null,rules:rows.slice(offset,offset+limit).map(r=>({ruleId:r.ruleId,revision:r.revision,kind:r.kind,title:r.title,obligationId:r.obligationId??null,region:r.region??'national_or_fact_based',implementationPeriod:r.implementationPeriod,legalEffective:r.legalEffective??null,implementationStatus:r.implementationStatus,validationStatus:r.validationStatus,detailEntrypoint:'getAgencyRuleDetail'}))});
}
export function getAgencyRuleDetail(ruleId,revision='1'){const r=catalog().find(r=>r.ruleId===ruleId&&r.revision===revision);need(r,'agency_rule_revision_not_found');return {version:AGENCY_RULE_CATALOG_VERSION,catalogDigest:agencyRuleCatalogDigest(),rule:clone(r)};}
export function assertAgencyRuleContext(obligationId,record,scope,entity){const r=taxRules.find(r=>r.obligationId===obligationId);need(r&&/^202[67]-(0[1-9]|1[0-2])$/.test(scope?.period),'agency_rule_implementation_period_unsupported');need(r.entityKinds.includes(entity?.kind),'agency_rule_entity_unsupported');need(record&&typeof record==='object','agency_rule_original_fact_missing');}
const stateFor = s => s==='calculated'?'matched':s==='not_applicable'?'not_applicable':s==='uncovered'?'unsupported':s==='missing'||s==='unknown'?'missing':s==='pending_period_end'?'missing':'unsupported';
/** Only actual workpaper results determine readiness; metadata listings never do. */
export function resolveAgencyRuleTrace({scope,entity,records,obligations,accounting}){
 need(Array.isArray(obligations)&&Array.isArray(records),'agency_rule_calculation_result_required');
 const traces=obligations.map(o=>{const r=taxRules.find(r=>r.obligationId===o.obligationId);need(r,'agency_rule_obligation_not_registered');const types=r.triggers.recordTypes,triggerFacts=records.filter(f=>types.includes(f.type)&&f.date?.slice(0,7)<=scope.period),seen=(o.calculations??[]).flatMap(c=>c.regionalRuleId?[c.regionalRuleId]:[]),regionalRules=regionalDescriptors().filter(p=>seen.includes(p.id)),outside=!/^202[67]-/.test(scope.period),reason=o.reason??'实际计算未提供原因';let state=outside?'unsupported':stateFor(o.status);const ruleIds=[r.ruleId,...regionalRules.map(p=>p.ruleId)],conflicts=[];
 for(const p of regionalRules){const date=triggerFacts.find(f=>f.contractSignedOn)?.contractSignedOn??`${scope.period}-01`,same=regionalDescriptors().filter(q=>q.obligationId===p.obligationId&&q.region===p.region&&q.legalEffective.from<=date&&(!q.legalEffective.through||q.legalEffective.through>=date));if(same.length>1&&!same.some(q=>same.every(other=>q.ruleId===other.ruleId||q.composition.supersedes.includes(other.ruleId))))conflicts.push(p.composition.parameterSlot);}
 if((o.issues??[]).some(i=>i.missingOriginalFacts?.length))state='missing';if(conflicts.length||(o.issues??[]).some(i=>/conflict|duplicate|mismatch/.test(i.code??'')))state='conflict';return {ruleId:r.ruleId,revision:r.revision,state,calculationStatus:o.status,reason,composedRuleIds:ruleIds,regionalRevisions:regionalRules.map(p=>({ruleId:p.ruleId,revision:p.revision})),factIds:triggerFacts.map(f=>f.id),issueCodes:(o.issues??[]).map(i=>i.code),missingOriginalFacts:[...new Set((o.issues??[]).flatMap(i=>i.missingOriginalFacts??[]))],conflicts,detailEntrypoint:'getAgencyRuleDetail',implementationStatus:r.implementationStatus,validationStatus:r.validationStatus};});
 const business=accountingRules.find(r=>r.triggers.industry===entity.industry);if(business)traces.unshift({ruleId:business.ruleId,revision:business.revision,state:accounting?.issues?.length?'missing':'matched',reason:'原业务/成本分支实际结果；复杂或缺件见accounting.issues',issueCodes:(accounting?.issues??[]).map(i=>i.code)});
 traces.push({ruleId:'agency.reports.profile-mapping',revision:'1',state:accounting?.reports?.balanceSheet?.complete&&accounting?.reports?.incomeStatement?.complete?'matched':'missing',reason:'复用该账套profile及报表映射实际完整性'});
 return {version:'agency-rule-match/1',catalogVersion:AGENCY_RULE_CATALOG_VERSION,catalogDigest:agencyRuleCatalogDigest(),scope:clone(scope),trace:traces,readiness:'actual_workpaper_results',amountsInWorkpaper:true,submittable:false};
}
export function getAgencyPolicyObservationSources(filters={}){const page=listAgencyRules(filters),ids=new Set(page.rules.map(r=>r.ruleId)),rows=catalog().filter(r=>ids.has(r.ruleId));return {version:'agency-policy-observation/1',automaticMonitoring:false,totalRules:page.total,offset:page.offset,limit:page.limit,nextOffset:page.nextOffset,sources:rows.flatMap(r=>(r.sources??[]).map(s=>({ruleId:r.ruleId,revision:r.revision,url:s.url,title:s.title,locator:s.locator??null,checkedOn:s.checkedOn??r.checkedOn??null,publishedOn:s.publishedOn??r.publishedOn??null,publicationDateStatus:s.publishedOn||r.publishedOn?'recorded':'not_recorded_in_baseline',effectiveFrom:s.from??r.legalEffective?.from??null,effectiveThrough:s.through??r.legalEffective?.through??null,verification:s.verification??r.evidenceForm??'source_form_recorded'})))};}

// Append-only local candidate journal. It contains observations, never executable
// formulas or active parameter overrides. Promotion requires a reviewed code PR.
const POLICY_VERSION='agency-policy-candidates/1';
const allowedKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>keys.includes(k));
export function validateAgencyPolicyCandidate(candidate){
 const errors=[];const check=(ok,code)=>{if(!ok)errors.push(code);};
 check(allowedKeys(candidate,['title','source','affectedRuleIds','regions','changeKind','scope','reason','supersedesCandidateId']),'candidate_fields_invalid');
 if(errors.length)return {valid:false,stage:'structural_only',errors,activatesRules:false,sourceContentVerified:false};
 check(typeof candidate.title==='string'&&candidate.title.trim().length>0&&candidate.title.length<=500,'candidate_title_invalid');
 const s=candidate.source;check(allowedKeys(s,['url','title','documentNumber','issuer','issuedOn','publishedOn','effectiveFrom','effectiveThrough','locators']),'candidate_source_fields_invalid');
 if(s&&typeof s==='object'){
  let url;try{url=new URL(s.url);}catch{}check(typeof s.url==='string'&&s.url.length<=2048&&url?.protocol==='https:'&&!url.username&&!url.password&&(/(^|\.)gov\.cn$/.test(url.hostname)||['fg.taxation.cn','www.npc.gov.cn'].includes(url.hostname)),'candidate_official_source_url_required');
  check(typeof s.title==='string'&&s.title.trim().length>0&&s.title.length<=500&&typeof s.issuer==='string'&&s.issuer.trim().length>0&&s.issuer.length<=300,'candidate_source_identity_missing');
  check(s.documentNumber===null||typeof s.documentNumber==='string'&&s.documentNumber.length>0&&s.documentNumber.length<=200,'candidate_document_number_missing');
  check(validDate(s.issuedOn)&&validDate(s.publishedOn)&&validDate(s.effectiveFrom)&&(!s.effectiveThrough||validDate(s.effectiveThrough)&&s.effectiveThrough>=s.effectiveFrom),'candidate_dates_invalid');
  check(Array.isArray(s.locators)&&s.locators.length>0&&s.locators.length<=30&&s.locators.every(l=>typeof l==='string'&&l.length>0&&l.length<=500),'candidate_source_locators_missing');
 }
 check(Array.isArray(candidate.affectedRuleIds)&&candidate.affectedRuleIds.length>0&&candidate.affectedRuleIds.length<=50&&new Set(candidate.affectedRuleIds).size===candidate.affectedRuleIds.length&&candidate.affectedRuleIds.every(id=>catalog().some(r=>r.ruleId===id)),'candidate_rule_ids_invalid');
 check(Array.isArray(candidate.regions)&&candidate.regions.length>0&&candidate.regions.length<=32&&candidate.regions.every(r=>r==='national'||/^CN-\d\d$/.test(r)),'candidate_regions_invalid');
 check(['amend','replace','expire','add_scope','clarify'].includes(candidate.changeKind),'candidate_change_kind_invalid');
 check(allowedKeys(candidate.scope,['kind','enterpriseKey'])&&(candidate.scope.kind==='public'&&!candidate.scope.enterpriseKey||candidate.scope.kind==='enterprise'&&typeof candidate.scope.enterpriseKey==='string'&&candidate.scope.enterpriseKey.trim().length>0&&candidate.scope.enterpriseKey.length<=160),'candidate_scope_invalid');
 check(typeof candidate.reason==='string'&&candidate.reason.trim().length>0&&candidate.reason.length<=4000,'candidate_reason_missing');
 if(candidate.supersedesCandidateId!==undefined)check(/^[a-f0-9]{64}$/.test(candidate.supersedesCandidateId),'candidate_previous_id_invalid');
 return {valid:errors.length===0,stage:'structural_only',errors,activatesRules:false,sourceContentVerified:false,reviewRequired:['核官方原文、效力、条款和发布时间','核替代/冲突/适用及例外','代码及独立金额/跨期原件链验收','人审Git/PR更新公共规则；保留旧修订'],catalogDigest:agencyRuleCatalogDigest()};
}
function checkedJournalPath(path){
 need(typeof path==='string'&&isAbsolute(path)&&path.endsWith('.agency-policy.jsonl'),'agency_policy_explicit_journal_path_required');const p=resolve(path);let current=parse(p).root;
 for(const part of relative(current,dirname(p)).split(/[\\/]/).filter(Boolean)){current=join(current,part);const s=lstatSync(current);need(s.isDirectory()&&!s.isSymbolicLink(),'agency_policy_path_rejected');}
 need(realpathSync(dirname(p)).toLowerCase()===dirname(p).toLowerCase(),'agency_policy_path_changed');
 try{const s=lstatSync(p);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size<=2*1024*1024,'agency_policy_journal_rejected');}catch(error){if(error.code!=='ENOENT')throw error;}
 return p;
}
function readJournal(path){
 const p=checkedJournalPath(path);let raw;try{raw=readFileSync(p,'utf8');}catch(error){if(error.code==='ENOENT')return {path:p,events:[]};throw error;}
 need(raw.endsWith('\n'),'agency_policy_journal_incomplete');const lines=raw.trimEnd().split('\n');let header;try{header=JSON.parse(lines.shift());}catch{fail('agency_policy_journal_invalid');}
 need(allowedKeys(header,['version'])&&header.version===POLICY_VERSION,'agency_policy_journal_invalid');const events=[];let previous='0'.repeat(64);
 for(const line of lines){let event;try{event=JSON.parse(line);}catch{fail('agency_policy_journal_invalid');}need(allowedKeys(event,['sequence','previous','candidateId','candidate','state','recordedAt','catalogDigestAtRegistration','digest'])&&event.sequence===events.length+1&&event.previous===previous&&event.state==='pending_verification'&&event.candidateId===digest(event.candidate)&&validateAgencyPolicyCandidate(event.candidate).valid,'agency_policy_journal_invalid');const {digest:actual,...payload}=event;need(actual===digest(payload),'agency_policy_journal_changed');previous=actual;events.push(event);}
 return {path:p,events};
}
export function listAgencyPolicyCandidates(path,filters={}){
 need(allowedKeys(filters,['enterpriseKey','from','through','offset','limit','candidateId']),'agency_policy_filters_invalid');const {enterpriseKey,from,through,candidateId}=filters,offset=filters.offset??0,limit=filters.limit??20;
 dateRange({from,through});need(Number.isInteger(offset)&&offset>=0&&Number.isInteger(limit)&&limit>0&&limit<=50,'agency_policy_pagination_invalid');if(candidateId)need(/^[a-f0-9]{64}$/.test(candidateId),'agency_policy_candidate_id_invalid');
 const journal=readJournal(path),events=journal.events.filter(e=>(!candidateId||e.candidateId===candidateId)&&(e.candidate.scope.kind==='public'||enterpriseKey&&e.candidate.scope.enterpriseKey===enterpriseKey)&&(!from||!e.candidate.source.effectiveThrough||e.candidate.source.effectiveThrough>=from)&&(!through||e.candidate.source.effectiveFrom<=through)),page=events.slice(offset,offset+limit);
 return {version:POLICY_VERSION,projection:candidateId?'candidate_detail':'bounded_summary',activatesRules:false,catalogDigest:agencyRuleCatalogDigest(),total:events.length,offset,limit,nextOffset:offset+limit<events.length?offset+limit:null,candidates:candidateId?clone(page):page.map(e=>({candidateId:e.candidateId,state:e.state,recordedAt:e.recordedAt,catalogDigestAtRegistration:e.catalogDigestAtRegistration,title:e.candidate.title.slice(0,120),titleTruncated:e.candidate.title.length>120,scope:clone(e.candidate.scope),effectivePeriod:{from:e.candidate.source.effectiveFrom,through:e.candidate.source.effectiveThrough},changeKind:e.candidate.changeKind,ruleCount:e.candidate.affectedRuleIds.length,affectedRuleIds:e.candidate.affectedRuleIds.slice(0,5),ruleIdsTruncated:e.candidate.affectedRuleIds.length>5,detailFilters:{candidateId:e.candidateId,...(enterpriseKey?{enterpriseKey}:{})}})),scope:enterpriseKey?{publicAndEnterprise:enterpriseKey}:{publicOnly:true}};
}
export function registerAgencyPolicyCandidate(path,candidate){
 const validation=validateAgencyPolicyCandidate(candidate);need(validation.valid,'agency_policy_candidate_invalid');const p=checkedJournalPath(path),lockPath=`${p}.lock`;let lock;try{lock=openSync(lockPath,'wx');}catch(error){if(error.code==='EEXIST')fail('agency_policy_journal_busy');throw error;}
 try{
  const journal=readJournal(p),candidateId=digest(candidate),old=journal.events.find(e=>e.candidateId===candidateId);if(old)return {candidateId,state:'pending_verification',replayed:true,activatesRules:false};
  if(candidate.supersedesCandidateId){const previous=journal.events.find(e=>e.candidateId===candidate.supersedesCandidateId);need(previous&&stable(previous.candidate.scope)===stable(candidate.scope),'agency_policy_previous_scope_mismatch');}
  const payload={sequence:journal.events.length+1,previous:journal.events.at(-1)?.digest??'0'.repeat(64),candidateId,candidate:clone(candidate),state:'pending_verification',recordedAt:new Date().toISOString(),catalogDigestAtRegistration:agencyRuleCatalogDigest()},event={...payload,digest:digest(payload)};
  const bytes=Buffer.from((journal.events.length?'':`${JSON.stringify({version:POLICY_VERSION})}\n`)+`${JSON.stringify(event)}\n`);need((()=>{try{return lstatSync(p).size;}catch(e){if(e.code==='ENOENT')return 0;throw e;}})()+bytes.length<=2*1024*1024,'agency_policy_journal_too_large');
  let fd;try{fd=openSync(p,journal.events.length?'a':'wx');const before=lstatSync(p),opened=fstatSync(fd);need(before.dev===opened.dev&&before.ino===opened.ino&&!before.isSymbolicLink()&&before.isFile()&&before.nlink===1&&realpathSync(p).toLowerCase()===p.toLowerCase(),'agency_policy_path_changed');let written=0;while(written<bytes.length)written+=writeSync(fd,bytes,written,bytes.length-written);fsyncSync(fd); }finally{if(fd!==undefined)closeSync(fd);}
  return {candidateId,state:'pending_verification',replayed:false,activatesRules:false,validation,historyPreserved:true};
 }finally{closeSync(lock);unlinkSync(lockPath);}
}
export function assessAgencyPolicyImpact(candidate,{enterpriseKey}={}){
 const validation=validateAgencyPolicyCandidate(candidate);need(validation.valid,'agency_policy_candidate_invalid');need(candidate.scope.kind==='public'||candidate.scope.enterpriseKey===enterpriseKey,'agency_policy_enterprise_scope_mismatch');
 const ids=new Set(candidate.affectedRuleIds),direct=catalog().filter(r=>ids.has(r.ruleId)),obligations=new Set(direct.map(r=>r.obligationId).filter(Boolean)),national=new Set(direct.filter(r=>r.kind==='tax').map(r=>r.obligationId)),rules=catalog().filter(r=>ids.has(r.ruleId)||r.kind==='tax'&&obligations.has(r.obligationId)||r.kind==='regional_parameter'&&national.has(r.obligationId)).filter(r=>candidate.regions.includes('national')||!r.region||candidate.regions.includes(r.region));
 const from=candidate.source.effectiveFrom>supported.from?candidate.source.effectiveFrom:supported.from,through=candidate.source.effectiveThrough&&candidate.source.effectiveThrough<supported.through?candidate.source.effectiveThrough:supported.through;
 return {version:'agency-policy-impact/1',candidateId:digest(candidate),catalogDigest:agencyRuleCatalogDigest(),scope:clone(candidate.scope),potentialRuleIds:rules.map(r=>r.ruleId),regions:clone(candidate.regions),businessPeriods:from<=through?{from,through}:null,basis:'policy_directory_scope_only',conditionalAffectedResults:['tax_workpaper','ledger','asset_or_inventory_cost_if_applicable','profit','corporate_or_business_income_if_applicable','annual_calculation','accountant_review'],ledgerScanPerformed:false,affectedEnterprises:null,affectedDocuments:null,requiresExplicitMaterialsForActualImpact:true,activatesRules:false,historyPolicy:'通过Git/PR保留旧修订和原件；更正重放后标影响结果，不覆盖旧账'};
}
export function renderAgencyRuleWiki(){
 const lines=['# 代账规则 Wiki','', '此页由 `renderAgencyRuleWiki()` 从结构化登记生成。先取按需目录或当前底稿规则轨迹，再读取一个规则详情；无需模型通读法规或挑选税率。','', '唯一目录：[agency-rule-catalog.mjs](../06-workbench/server/agency-rule-catalog.mjs)；地区参数复用 [agency-regional-rules.mjs](../06-workbench/server/agency-regional-rules.mjs)；实际公式仍在既有会计/税费函数。法律有效期与本实现支持期（2026—2027）分开。地区参数与国家义务/减免组合，不能相互覆盖。','', '## 使用入口','', '在 `06-workbench` 运行：','', '```text','node scripts/agency-business.mjs rules [filters.json]','node scripts/agency-business.mjs rule <ruleId> [revision]','node scripts/agency-business.mjs match-rules <manifest> [workbench.db]','node scripts/agency-business.mjs policy-sources [filters.json]','node scripts/agency-business.mjs policy-validate <candidate.json>','node scripts/agency-business.mjs policy-register <absolute-name.agency-policy.jsonl> <candidate.json>','node scripts/agency-business.mjs policy-list <absolute-name.agency-policy.jsonl> [filters.json]','node scripts/agency-business.mjs policy-impact <candidate.json> [enterpriseKey]','```','', '目录和候选列表默认20条、最多50条；候选用candidateId按需读详情，match-rules仅前5个事实ID和有界原因/问题摘要，完整追溯留在原底稿。目录筛选字段为 `ruleId/obligationId/kind/region/entityKind/from/through/offset/limit`。`match-rules` 调用真实只读底稿重放，返回 matched、missing、not_applicable、unsupported 或 conflict，matched 仅代表该实际分支，申报缴费仍由人核对。','', '候选只追加到显式本机文件，不进入活动目录，不接受代码、税率或参数覆盖。`policy-validate` 仅校验结构，不声称已抓取核实原文。`policy-impact` 只分析规则/地区/业务期间，未扫描账套或资料。未来政策更新需核官方效力、验证并经Git/PR更新；旧版本留历史，企业特例不得自动跨企。无需启动定时任务。','', '候选JSON字段：`title/source/affectedRuleIds/regions/changeKind/scope/reason/supersedesCandidateId?`。source为 `url/title/documentNumber(无文号填null)/issuer/issuedOn/publishedOn/effectiveFrom/effectiveThrough/locators`；changeKind为 amend、replace、expire、add_scope 或 clarify；scope为 `{kind:"public"}` 或 `{kind:"enterprise",enterpriseKey:"..."}`。','', '## 按需规则导航','', '| 规则ID | 内容 | 实际入口 | 验证范围 |','|---|---|---|---|'];
 for(const r of [...accountingRules,...navigationRules,...taxRules])lines.push(`| ${r.ruleId} | ${r.title} | [${r.code.path}](../06-workbench/${r.code.path})：${r.code.entrypoint} | ${r.validationStatus} |`);
 lines.push('', '## 地区参数与历史','', '地区参数按目录 `kind=regional_parameter` 与真实标的所在地/业务日期查询；只有列明税费和分支，不代表该地区全税种覆盖。地区详情记录来源形式、有效期及替代关系；辽宁2023起、上海2026续期均保留原版本边界。来源与有公式、金额验收和完整业务链验收是不同状态。','', '旧 `tax-rule-registry.mjs` 的Q1/Q2工程范围独立，不能把其整元等限制套给agency。报表复用原profile/report registry，年度只引用现全年计算入口。','', '缺项不会当零；实际命中/排除/冲突与catalog digest留在底稿，原件与代码仍由原审计链归档。');
 return `${lines.join('\n')}\n`;
}

const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
[TAX_SOURCES,AGENCY_EXTENDED_TAX_SOURCES,AGENCY_ACCOUNTING_SOURCES,taxRules,accountingRules,navigationRules].forEach(freeze);

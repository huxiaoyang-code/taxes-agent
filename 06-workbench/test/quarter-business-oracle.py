"""完整季度独立账务答案。仅 Python 标准库/Decimal；不导入被测财税引擎。

运行：python test/quarter-business-oracle.py --check
重建维护侧答案：python test/quarter-business-oracle.py --write
不得把本文件、答案或其输出交给执行业务的 Agent。
"""
from pathlib import Path
from decimal import Decimal, ROUND_HALF_UP
from collections import defaultdict
import argparse, csv, hashlib, json, calendar

BASE=Path(__file__).resolve().parents[1]
PUBLIC=BASE/'fixtures/quarter-business/public'
EXPECTED=Path(__file__).with_suffix('.expected.json')
D=Decimal; ZERO=D(0)
def q(n):return D(str(n)).quantize(D('.01'),rounding=ROUND_HALF_UP)
def m(n):return str(q(n))
def rows(name):
    with (PUBLIC/name).open(encoding='utf-8-sig',newline='') as f:return list(csv.DictReader(f))
def read(name):return json.loads((PUBLIC/name).read_text(encoding='utf-8'))
def encode(value):
    if isinstance(value,D):return m(value)
    if isinstance(value,dict):return {k:encode(v) for k,v in value.items()}
    if isinstance(value,list):return [encode(v) for v in value]
    return value

# 科目按财政部小企业会计准则附录设定，税费明细可按业务自行设置。
NAMES={'1001':'库存现金','1002':'银行存款','1012':'其他货币资金','1101':'短期投资','1121':'应收票据','1122':'应收账款','1123':'预付账款','1131':'应收股利','1132':'应收利息','1221':'其他应收款','1401':'材料采购','1402':'在途物资','1403':'原材料','1404':'材料成本差异','1405':'库存商品','1407':'商品进销差价','1408':'委托加工物资','1411':'周转材料','1421':'消耗性生物资产','1501':'长期债券投资','1511':'长期股权投资','1601':'固定资产','1602':'累计折旧','1604':'在建工程','1605':'工程物资','1606':'固定资产清理','1621':'生产性生物资产','1622':'生产性生物资产累计折旧','1701':'无形资产','1702':'累计摊销','1801':'长期待摊费用','1901':'待处理财产损溢','2001':'短期借款','2201':'应付票据','2202':'应付账款','2203':'预收账款','2211':'应付职工薪酬','2221':'应交税费','2231':'应付利息','2232':'应付利润','2241':'其他应付款','2401':'递延收益','2501':'长期借款','2701':'长期应付款','3001':'实收资本','3002':'资本公积','3101':'盈余公积','3103':'本年利润','3104':'利润分配','4001':'生产成本','4101':'制造费用','4301':'研发支出','4401':'工程施工','4403':'机械作业','5001':'主营业务收入','5051':'其他业务收入','5111':'投资收益','5301':'营业外收入','5401':'主营业务成本','5402':'其他业务成本','5403':'税金及附加','5601':'销售费用','5602':'管理费用','5603':'财务费用','5711':'营业外支出','5801':'所得税费用'}
NAMES.update({'222101':'应交税费—增值税进项税额','222102':'应交税费—增值税销项税额','222103':'应交税费—未交增值税','222104':'应交税费—城市维护建设税','222105':'应交税费—教育费附加','222106':'应交税费—地方教育附加','222107':'应交税费—企业所得税','222108':'应交税费—个人所得税','222109':'应交税费—印花税'})
CF_LABELS=['销售产成品、商品、提供劳务收到的现金','收到其他与经营活动有关的现金','购买原材料、商品、接受劳务支付的现金','支付的职工薪酬','支付的税费','支付其他与经营活动有关的现金','经营活动产生的现金流量净额','收回短期投资、长期债券投资和长期股权投资收到的现金','取得投资收益收到的现金','处置固定资产、无形资产和其他非流动资产收回的现金净额','短期投资、长期债券投资和长期股权投资支付的现金','购建固定资产、无形资产和其他非流动资产支付的现金','投资活动产生的现金流量净额','取得借款收到的现金','吸收投资者投资收到的现金','偿还借款本金支付的现金','偿还借款利息支付的现金','分配利润支付的现金','筹资活动产生的现金流量净额','现金净增加额','期初现金余额','期末现金余额']

def cash_table(detail,opening):
    c={i:detail.get(i,ZERO) for i in range(1,23)}
    c[7]=c[1]+c[2]-sum(c[i] for i in [3,4,5,6]);c[13]=sum(c[i] for i in [8,9,10])-c[11]-c[12]
    c[19]=c[14]+c[15]-c[16]-c[17]-c[18];c[20]=c[7]+c[13]+c[19];c[21]=opening;c[22]=opening+c[20]
    return [{'row':i,'label':CF_LABELS[i-1],'amount':c[i]} for i in range(1,23)]

def build(public=None):
    global PUBLIC
    if public is not None:PUBLIC=Path(public)
    company=read('企业资料.json'); taxfacts=read('税费与资格.json')
    bal=defaultdict(lambda:ZERO);year_dr=defaultdict(lambda:ZERO);year_cr=defaultdict(lambda:ZERO)
    for r in rows('期初科目余额.csv'):bal[r['科目代码']]+=D(r['金额（元）'])*(1 if r['余额方向']=='借' else -1)
    initial=dict(bal)
    assert sum(bal.values())==0,'期初不平衡，禁止配平'
    lots=defaultdict(list);sale_lots={};inventory_movements=[]
    for r in rows('期初存货.csv'):
      lots[r['商品编号']].append({'lot':r['入库批次'],'date':r['入库日期'],'quantity':D(r['数量']),'unitCost':D(r['单位成本（元）'])})
    goods=rows('购销明细.csv');expenses=rows('费用单据.csv');payroll=rows('员工工资.csv');bank=rows('银行流水.csv');contracts=rows('合同台账.csv');assets=rows('固定资产.csv');alloc=rows('收付核销.csv')
    payroll_previous=defaultdict(lambda:ZERO);months=[];all_journal=[];cf_ytd=defaultdict(lambda:ZERO);previous_cit=ZERO
    for month in ['2026-01','2026-02','2026-03']:
      month_end=month+'-'+str(calendar.monthrange(int(month[:4]),int(month[5:]))[1])
      opening=dict(bal);journal=[];dr=defaultdict(lambda:ZERO);cr=defaultdict(lambda:ZERO);cf=defaultdict(lambda:ZERO)
      def post(date,label,entries,sources,rule,parameters=None,closing=False):
        entries=[{'code':c,'debit':q(d),'credit':q(k)} for c,d,k in entries if q(d)!=0 or q(k)!=0]
        assert all(e['debit']>=0 and e['credit']>=0 for e in entries),label
        assert sum(e['debit']-e['credit'] for e in entries)==0,label
        for e in entries:
          c=e['code'];bal[c]+=e['debit']-e['credit'];dr[c]+=e['debit'];cr[c]+=e['credit'];year_dr[c]+=e['debit'];year_cr[c]+=e['credit']
        journal.append({'date':date,'label':label,'entries':entries,'sources':sources,'rule':rule,'parameters':parameters or {},'closing':closing})
      def netroot(c,balances=None):return sum(v for k,v in (bal if balances is None else balances).items() if k.startswith(c))
      month_goods=[r for r in goods if r['业务日期'].startswith(month)]
      output=ZERO;inputs=ZERO;revenue=ZERO;cogs=ZERO
      for r in month_goods:
        net=D(r['不含税金额（元）']);vat=D(r['单列增值税额（元）']);gross=D(r['价税合计（元）']);qty=D(r['数量']);sku=r['商品编号'];doc=r['单据编号'];typ=r['业务类型']
        assert net==q(qty*D(r['不含税单价（元）'])) and vat==q(net*D('.13')) and gross==net+vat
        if typ=='采购':
          post(r['业务日期'],doc+' '+sku, [('1405',net,0),('222101',vat,0),('2202',0,gross)],[doc],'小企存货成本；增值税一般计税',{'不含税金额':net,'可抵扣进项':vat})
          lots[sku].append({'lot':doc,'date':r['业务日期'],'quantity':qty,'unitCost':net/qty});inputs+=vat
        elif typ=='销售':
          post(r['业务日期'],doc+' '+sku,[('1122',gross,0),('5001',0,net),('222102',0,vat)],[doc],'收入确认；增值税纳税义务',{'不含税销售额':net,'销项':vat});output+=vat;revenue+=net
          left=qty;parts=[]
          for lot in sorted(lots[sku],key=lambda x:(x['date'],x['lot'])):
            take=min(lot['quantity'],left)
            if take:lot['quantity']-=take;left-=take;parts.append({'lot':lot['lot'],'quantity':take,'unitCost':lot['unitCost'],'amount':q(take*lot['unitCost'])})
            if left==0:break
          assert left==0,'存货不足'
          cost=sum(p['amount'] for p in parts);sale_lots[(doc,sku)]=parts;cogs+=cost
          post(r['业务日期'],doc+' '+sku+' 成本',[('5401',cost,0),('1405',0,cost)],[doc],'先进先出法',{'批次':parts})
          inventory_movements.append({'date':r['业务日期'],'document':doc,'sku':sku,'quantity':-qty,'cost':-cost,'lots':parts})
        else:
          assert typ=='销售退回'
          prior=sale_lots[(r['退货原销售单据'],sku)];part=next(p for p in prior if p['lot']==r['退货原采购批次']);assert qty<=part['quantity']
          cost=q(qty*part['unitCost']);lot=next(p for p in lots[sku] if p['lot']==part['lot']);lot['quantity']+=qty;cogs-=cost;output-=vat;revenue-=net
          post(r['业务日期'],doc,[('5001',net,0),('222102',vat,0),('1122',0,gross)],[doc],'红字退货按原业务冲回',{'不含税退货额':net})
          post(r['业务日期'],doc+' 成本恢复',[('1405',cost,0),('5401',0,cost)],[doc,r['退货原销售单据']],'原销售实际出库批次恢复',{'批次':part['lot'],'数量':qty,'单位成本':part['unitCost']})
          inventory_movements.append({'date':r['业务日期'],'document':doc,'sku':sku,'quantity':qty,'cost':cost})
      for r in expenses:
        if not r['业务日期'].startswith(month):continue
        net=D(r['不含税金额（元）']);vat=D(r['单列增值税额（元）']);gross=D(r['价税合计（元）']);doc=r['单据编号'];assert net+vat==gross
        deductible='已勾选' in r['进项确认状态'];cost=net if deductible else gross
        account='1601' if doc=='设备二月' else '5601' if doc.startswith(('运费','租金')) else '5602'
        post(r['业务日期'],doc,[(account,cost,0),('222101',vat if deductible else 0,0),('2202',0,gross)],[doc],'成本费用确认及进项用途核对',{'计入成本费用':cost,'可抵扣税额':vat if deductible else ZERO});inputs+=vat if deductible else ZERO
      current_people=[r for r in payroll if r['工资月份']==month];payable=ZERO;personal=ZERO;employer=ZERO;pit=ZERO;pay_entries=[];pit_detail=[]
      for r in current_people:
        ident=r['员工编号'];gross=D(r['应发工资（元）']);ps=D(r['个人社保公积金（元）']);es=D(r['单位社保公积金（元）']);extra=D(r['专项附加扣除（元）']);periods=int(month[-2:]);cum=max(ZERO,(gross-ps-extra-D(5000))*periods)
        # 本资料三名员工全季度均位于第一档；额外越档由独立自测覆盖表函数。
        current=max(ZERO,pit_tax(cum)-payroll_previous[ident]);payroll_previous[ident]+=current;pit+=current;payable+=gross;personal+=ps;employer+=es
        pay_entries.append(('5602' if r['部门']=='行政' else '5601',gross+es,0));pit_detail.append({'employee':ident,'cumulativeTaxable':cum,'cumulativeTax':payroll_previous[ident],'currentTax':current})
      pay_entries.append(('2211',0,payable+employer));post(month+'-28','本月工资及单位社公计提',pay_entries,[month+'工资表'],'权责发生制与居民工资累计预扣',{'员工个税':pit_detail})
      for r in bank:
        if not r['交易日期'].startswith(month):continue
        doc=r['流水编号'];incoming=D(r['收入（元）']);outgoing=D(r['支出（元）']);date=r['交易日期'];parts=[p for p in alloc if p['流水编号']==doc]
        assert sum(D(p['分配金额（元）']) for p in parts)==incoming+outgoing,doc
        if doc.startswith('收货款') or doc=='银行0101':ent=[('1002',incoming,0),('1122',0,incoming)];cf[1]+=incoming
        elif doc=='预收三月':ent=[('1002',incoming,0),('2203',0,incoming)];cf[1]+=incoming
        elif doc=='借款二月':ent=[('1002',incoming,0),('2001',0,incoming)];cf[14]+=incoming
        elif doc=='归还本金三月':ent=[('2001',outgoing,0),('1002',0,outgoing)];cf[16]+=outgoing
        elif doc.startswith('利息'):ent=[('5603',outgoing,0),('1002',0,outgoing)];cf[17]+=outgoing
        elif doc.startswith('发工资'):
          assert outgoing==payable-personal-pit
          ent=[('2211',payable,0),('2241',0,personal),('222108',0,pit),('1002',0,outgoing)];cf[4]+=outgoing
        elif doc.startswith('缴社公'):ent=[('2211',employer,0),('2241',personal,0),('1002',0,outgoing)];cf[4]+=outgoing
        elif doc.startswith('缴'):
          code=next(c for name,c in [('增值税','222103'),('城建税','222104'),('教育附加','222105'),('地方附加','222106'),('个税','222108')] if name in doc)
          ent=[(code,outgoing,0),('1002',0,outgoing)]
          # 工资代扣个税实质属于职工薪酬；不因支付对象为税局改成企业承担的税费。
          cf[4 if code=='222108' else 5]+=outgoing
        else:
          ent=[('2202',outgoing,0),('1002',0,outgoing)]
          for p in parts:
            link=p['关联单据或事项'];amount=D(p['分配金额（元）']);cf[12 if link=='设备二月' else 3 if link.startswith(('采购','期初应付')) else 6]+=amount
        post(date,r['业务摘要'],ent,[doc]+[p['关联单据或事项'] for p in parts],'收付核销及现金流按实际业务分类',{'分配':parts})
      depreciation=ZERO
      for r in assets:
        usemonth=r['达到可使用状态日期'][:7]
        if usemonth>=month:continue
        dep=q((D(r['原值（元）'])-D(r['残值（元）']))/D(r['使用月数']));depreciation+=dep
        post(month_end,r['资产名称']+' 折旧',[('5601' if r['用途']=='仓储销售' else '5602',dep,0),('1602',0,dep)],[r['资产编号']],'年限平均法；增加次月起计提',{'原值':D(r['原值（元）']),'使用月数':int(r['使用月数']),'残值':D(r['残值（元）']),'启用月份':usemonth})
      vat_due=output-inputs;assert vat_due>=0
      post(month_end,'增值税月末转出',[('222102',output,0),('222101',0,inputs),('222103',0,vat_due)],['本月购销及费用'],'一般计税月末转出未交增值税',{'销项':output,'进项':inputs})
      surcharge={code:q(vat_due*rate*D('.5')) for code,rate in [('222104',D('.07')),('222105',D('.03')),('222106',D('.02'))]}
      assert revenue>100000,'本分支教育附加免征门槛变化必须重核'
      post(month_end,'本月附加税费计提',[('5403',sum(surcharge.values()),0)]+[(code,0,value) for code,value in surcharge.items()],['地点资格及本月增值税'],'市区及六税两费减半；月销售额超免征线',{'增值税基数':vat_due,'减征后缴纳比例':D('.5')})
      stamp=ZERO;stamp_details=[]
      for r in contracts:
        if not r['书立日期'].startswith(month):continue
        rate={'买卖合同':D('.0003'),'运输合同':D('.0003'),'租赁合同':D('.001'),'借款合同':D('.00005')}[r['合同类别']]
        base=D(r['不含税金额或本金（元）']);tax=q(base*rate*D('.5'))
        if r['合同类别']=='借款合同':
          loan=read('借款申请资料.json');assert loan['贷款人性质']=='持牌商业银行' and loan['主营行业']=='批发业'
          turnover=sum(D(x['营业收入（元）']) for x in loan['前十二个自然月营业收入明细'])
          assert loan['贷款时从业人数']<5 or turnover<10000000
          tax=ZERO
        stamp+=tax;stamp_details.append({'contract':r['合同编号'],'base':base,'rate':str(rate),'due':tax,'exemption':'金融机构与小微企业借款合同免征' if r['合同类别']=='借款合同' else None})
      post(month_end,'本月印花税计提',[('5403',stamp,0),('222109',0,stamp)],['本月合同台账'],'印花税按列明净额及税目；借款小微免征，其他六税两费减半',{'合同税额':stamp_details})
      pre_tax=-sum(v for c,v in bal.items() if c.startswith('5') and not c.startswith('5801'))
      previous_profit=sum(D(x['incomeStatement']['profitBeforeTax']) for x in months)
      cit_cumulative=q(max(ZERO,previous_profit+pre_tax)*D('.05'));cit=cit_cumulative-previous_cit;previous_cit=cit_cumulative
      assert cit>=0
      post(month_end,'本月所得税费用计提',[('5801',cit,0),('222107',0,cit)],['本月利润及季度资格'],'小型微利企业累计计提，季度实际利润预缴',{'累计实际利润':previous_profit+pre_tax,'有效税率':D('.05')})
      before=dict(bal);income={key:value for key,value in [('revenue',revenue),('cost',cogs),('surcharges',sum(surcharge.values())+stamp),('sellingExpenses',netroot('5601')),('administrativeExpenses',netroot('5602')),('financeExpenses',netroot('5603')),('profitBeforeTax',pre_tax),('incomeTax',cit),('netProfit',pre_tax-cit)]}
      close=[]
      for c,value in list(bal.items()):
        if c.startswith('5') and value:close.append((c,-value if value<0 else 0,value if value>0 else 0))
      netprofit=pre_tax-cit;close.append(('3103',-netprofit if netprofit<0 else 0,netprofit if netprofit>0 else 0))
      post(month_end,'结转本月损益',close,['当月损益科目'],'月度结转本年利润，不作年度分配',closing=True)
      def tb(snapshot):
        out=[]
        for code in sorted(NAMES):
          # 2221仅作为汇总根不重复计入借贷总额，叶子值才用于独立平衡校验。
          if code=='2221':continue
          op=opening.get(code,ZERO);end=snapshot.get(code,ZERO)
          out.append({'code':code,'name':NAMES[code],'openingDebit':max(op,ZERO),'openingCredit':max(-op,ZERO),'debit':dr[code]-(next((e['debit'] for e in journal[-1]['entries'] if e['code']==code),ZERO) if snapshot is before else ZERO),'credit':cr[code]-(next((e['credit'] for e in journal[-1]['entries'] if e['code']==code),ZERO) if snapshot is before else ZERO),'endingDebit':max(end,ZERO),'endingCredit':max(-end,ZERO)})
        return out
      assets_total=sum(v for c,v in bal.items() if c.startswith('1'));liabilities=-sum(v for c,v in bal.items() if c.startswith('2'));equity=-sum(v for c,v in bal.items() if c.startswith('3'))
      bs={'cash':netroot('1002'),'receivables':netroot('1122'),'inventory':netroot('1405'),'fixedAssetsCost':netroot('1601'),'accumulatedDepreciation':-netroot('1602'),'assetsTotal':assets_total,'shortBorrowings':-netroot('2001'),'payables':-netroot('2202'),'advancesReceived':-netroot('2203'),'employeePayable':-netroot('2211'),'taxesPayable':-netroot('2221'),'otherPayable':-netroot('2241'),'liabilitiesTotal':liabilities,'capital':-netroot('3001'),'retainedEarnings':-netroot('3104')-netroot('3103'),'equityTotal':equity,'liabilitiesAndEquity':liabilities+equity}
      cash=cash_table(cf,opening.get('1002',ZERO));inventory=[{'sku':sku,'lot':lot['lot'],'quantity':lot['quantity'],'unitCost':lot['unitCost'],'amount':q(lot['quantity']*lot['unitCost'])} for sku in sorted(lots) for lot in lots[sku] if lot['quantity']]
      checks={'trialBalance':sum(bal.values()),'balanceSheet':assets_total-liabilities-equity,'inventory':sum(x['amount'] for x in inventory)-netroot('1405'),'cash':cash[-1]['amount']-netroot('1002'),'profitClosing':-netroot('3103')-sum(D(x['incomeStatement']['netProfit']) for x in months)-netprofit,'salaryClearing':netroot('2211')+netroot('2241')}
      assert all(v==0 for v in checks.values()),checks
      statement_last=[r for r in bank if r['交易日期'].startswith(month)][-1];assert D(statement_last['余额（元）'])==bal['1002']
      months.append({'period':month,'opening':opening,'journal':journal,'trialBalanceBeforeClose':tb(before),'trialBalanceAfterClose':tb(dict(bal)),'incomeStatement':income,'balanceSheet':bs,'cashFlow':cash,'taxes':{'salesExcludingVat':revenue,'outputVat':output,'inputVat':inputs,'vatDue':vat_due,'surcharges':surcharge,'stamp':stamp,'stampDetails':stamp_details,'pit':pit,'pitDetails':pit_detail,'citAccrual':cit,'citCumulative':cit_cumulative},'inventory':inventory,'checks':checks})
      for key,value in cf.items():cf_ytd[key]+=value
      all_journal+=journal
    quarter_income={k:sum(x['incomeStatement'][k] for x in months) for k in months[0]['incomeStatement']}
    qtb=[{'code':c,'name':NAMES[c],'openingDebit':max(initial.get(c,ZERO),ZERO),'openingCredit':max(-initial.get(c,ZERO),ZERO),'debit':year_dr[c],'credit':year_cr[c],'endingDebit':max(bal[c],ZERO),'endingCredit':max(-bal[c],ZERO)} for c in sorted(NAMES) if c!='2221']
    result={'schemaVersion':'independent-quarter-ledger/1','datasetId':'zhangzhou-quarter-ledger-2026q1-v1','publicFingerprints':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(PUBLIC.iterdir()) if p.is_file()},'currency':'CNY','unit':'yuan','months':months,'quarter':{'period':'2026-Q1','trialBalance':qtb,'incomeStatement':quarter_income,'balanceSheet':months[-1]['balanceSheet'],'cashFlow':cash_table(cf_ytd,initial['1002']),'citPayable':previous_cit,'stampPayable':sum(x['taxes']['stamp'] for x in months),'averageEmployees':3,'averageAssets':(sum(v for c,v in initial.items() if c.startswith('1'))+months[-1]['balanceSheet']['assetsTotal'])/2},'inventoryMovements':inventory_movements,'method':'独立Decimal逐笔复式记账、FIFO、月度结转与直接法现金流；不导入被测产品'}
    result['cashFlowPolicy']={'status':'待口径确认','provisionalMethod':'购销及设备按实际含税收付列业务项目；代扣职工个税按薪酬实质列支；并非已确认唯一小企业列示答案','reason':'小企正式附录明确22行，但未直接说明购销含税拆分；尚未取得可以消除小企释义分税与含税列示差异的官方原始依据。','confirmedSource':'https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852734144.pdf','limitedSource':'https://kjs.mof.gov.cn/zt/kjzzss/sswd/xqykjzzsswd/202206/t20220621_3819702.htm','limitedSourceScope':'仅留抵退税，不推定普通购销；企业准则代扣个税答疑仅辅助业务实质判断，不冒称小企专门答复','comparison':'现金期初、净增加、期末与实际银行事实硬核；分类逐项差异另列待审，不作唯一正确性判定'}
    return encode(result)

def pit_tax(base):
    for ceiling,rate,quick in [(36000,'.03',0),(144000,'.10',2520),(300000,'.20',16920),(420000,'.25',31920),(660000,'.30',52920),(960000,'.35',85920),(D('Infinity'),'.45',181920)]:
      if base<=ceiling:return q(max(ZERO,base*D(rate)-D(quick)))

def self_check():
    assert pit_tax(D(36000))==D(1080) and pit_tax(D(36001))==D('1080.10')
    result=build()
    for mo in result['months']:
      for stage in ['trialBalanceBeforeClose','trialBalanceAfterClose']:
        tb=mo[stage]
        assert sum(D(r['endingDebit'])-D(r['endingCredit']) for r in tb)==0
        assert all(D(r['openingDebit'])-D(r['openingCredit'])+D(r['debit'])-D(r['credit'])==D(r['endingDebit'])-D(r['endingCredit']) for r in tb)
    assert result['months'][2]['taxes']['outputVat']=='26578.50'
    assert next(r for r in result['months'][1]['cashFlow'] if r['row']==12)['amount']=='13560.00'
    assert next(r for r in result['months'][1]['cashFlow'] if r['row']==3)['amount']=='140000.00'
    return result

INCOME_LABELS={'revenue':'营业收入','cost':'营业成本','surcharges':'税金及附加','sellingExpenses':'销售费用','administrativeExpenses':'管理费用','financeExpenses':'财务费用','profitBeforeTax':'利润总额','incomeTax':'所得税费用','netProfit':'净利润'}

def compare_actual(expected,actual):
    """核对真实后台账表导出。只审数字，不替代原件映射、规则适用及人工审阅。

    明细科目编码允许自行增设，因此按四位根科目比较净发生额和余额；
    不要求凭证张数相同，不把过账顺序或内部税费结转额当成唯一正确做法。
    现金流必须逐项匹配，不能只看现金净变动或资产负债平衡。
    """
    differences=[];classification_differences=[];checked=0
    def equal(path,want,got):
      nonlocal checked
      checked+=1
      try:ok=q(want)==q(got) if got is not None else False
      except (ValueError,TypeError,ArithmeticError):ok=False
      if not ok:differences.append({'项目':path,'独立参考值':str(want),'实际值':got})
    def issue(path,message):differences.append({'项目':path,'问题':message})
    def compare_tb(path,want,got):
      if not isinstance(got,list):issue(path,'缺少科目余额表');return
      if len({r['code'] for r in got})!=len(got):issue(path,'实际科目行重复，不能重复汇总')
      metrics=[('期初净余额','openingDebit','openingCredit','opening_debit','opening_credit'),('本期净发生','debit','credit','period_debit','period_credit'),('期末净余额','endingDebit','endingCredit','closing_debit','closing_credit')]
      for label,wd,wc,gd,gc in metrics:
        refs=defaultdict(lambda:ZERO);values=defaultdict(lambda:ZERO)
        for r in want:refs[str(r['code'])[:4]]+=D(r[wd])-D(r[wc])
        for r in got:values[str(r['code'])[:4]]+=D(str(r.get(gd,0)))-D(str(r.get(gc,0)))
        for root in sorted(set(refs)|set(values)):equal(path+'/'+root+'/'+label,refs[root],values[root])
    actual_months=actual.get('months',[])
    periods=[r.get('period') for r in actual_months]
    if periods!=[r['period'] for r in expected['months']]:issue('月份','必须按顺序包含完整2026年1、2、3月且无重复')
    cf_months=actual.get('cashFlow',{}).get('months',[])
    def compare_cf(path,want,got):
      if not got:issue(path,'缺少现金流量表');return
      if got.get('complete') is not True:issue(path,'存在未分类收付或未确认完整性')
      lines=got.get('rows',[])
      if len(lines)!=22 or [r.get('label') for r in lines]!=CF_LABELS:issue(path,'现金流量表必须保留官方22行及完整顺序')
      by_label={r.get('label'):r.get('value') for r in lines}
      for row in want:
        # 暂缓的仅是经营明细中购销增值税和代扣个税的列示位置。
        # 活动净额、设备投资及借还本息均不受该争议影响，不能一并放松。
        if row['row']>=7:equal(path+'/'+row['label'],row['amount'],by_label.get(row['label']))
        elif by_label.get(row['label']) is None or q(row['amount'])!=q(by_label[row['label']]):
          classification_differences.append({'项目':path+'/'+row['label'],'暂列参考值':row['amount'],'实际值':by_label.get(row['label']),'处理':'待列示口径确认，不能单凭该差额判执行正确或错误'})
    for mo in expected['months']:
      period=mo['period'];got=next((r for r in actual_months if r.get('period')==period),None)
      if not got or got.get('missing'):issue(period,'缺少完整月份账表');continue
      reports=got.get('reports',{})
      compare_tb(period+'/结转后科目',mo['trialBalanceAfterClose'],reports.get('trial-balance',{}).get('data',{}).get('lines'))
      compare_tb(period+'/结转前科目',mo['trialBalanceBeforeClose'],got.get('preClose',{}).get('lines'))
      profit=reports.get('income-statement',{}).get('data',{}).get('current',{})
      for key,label in INCOME_LABELS.items():equal(period+'/利润表/'+label,mo['incomeStatement'][key],profit.get(label))
      totals=reports.get('balance-sheet',{}).get('data',{}).get('totals',{})
      for key,prop in [('assetsTotal','assets'),('liabilitiesTotal','liabilities'),('equityTotal','equity'),('liabilitiesAndEquity','liabilitiesAndEquity')]:equal(period+'/资产负债表/'+key,mo['balanceSheet'][key],totals.get(prop))
      compare_cf(period+'/现金流量表',mo['cashFlow'],next((r for r in cf_months if r.get('period')==period),None))
    compare_cf('季度现金流量表',expected['quarter']['cashFlow'],actual.get('cashFlow',{}).get('quarter'))
    # 从真实凭证重放期末余额，防止只提交脱离账簿的正确报表。
    entries=actual.get('entries');openings=actual.get('openings')
    if not isinstance(entries,list) or not isinstance(openings,list):issue('实际凭证','缺少原生已过账分录或期初余额')
    else:
      balances=defaultdict(lambda:ZERO);voucher_sum=defaultdict(lambda:ZERO)
      for row in openings:balances[str(row['code'])[:4]]+=D(str(row.get('debit',0)))-D(str(row.get('credit',0)))
      for row in entries:
        if row.get('status')!='posted':issue('实际凭证/'+str(row.get('voucher_id')),'存在未过账分录');continue
        if row.get('period') not in ['2026-01','2026-02','2026-03']:issue('实际凭证','分录期间超出季度');continue
        net=D(str(row.get('debit',0)))-D(str(row.get('credit',0)));balances[str(row['code'])[:4]]+=net;voucher_sum[row.get('voucher_id')]+=net
      for ident,net in voucher_sum.items():equal('实际凭证/'+str(ident)+'/借贷差',0,net)
      refs=defaultdict(lambda:ZERO)
      for row in expected['quarter']['trialBalance']:refs[row['code'][:4]]+=D(row['endingDebit'])-D(row['endingCredit'])
      for root in sorted(set(refs)|set(balances)):equal('真实分录重放/'+root,refs[root],balances[root])
    return {'状态':'账表数字通过，现金流分类待口径确认' if not differences else '未通过','数字核对通过':not differences,'数值核对项数':checked,'差异':differences,'现金流分类状态':'待口径确认','现金流分类差异':classification_differences,'边界':'独立数字核对不代表原件参数映射正确、不代表规则已人工审核或可以申报；现金流分类尚不构成唯一金标。科目明细命名允许变化，税费明细仍应在人工报告中复核。'}

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--write',action='store_true');parser.add_argument('--check',action='store_true');parser.add_argument('--public',type=Path);parser.add_argument('--output',type=Path);parser.add_argument('--actual',type=Path);parser.add_argument('--comparison-output',type=Path);args=parser.parse_args()
    if args.public:PUBLIC=args.public
    result=self_check();text=json.dumps(result,ensure_ascii=False,indent=2)+'\n'
    if args.write:EXPECTED.write_text(text,encoding='utf-8',newline='\n')
    if args.output:args.output.write_text(text,encoding='utf-8',newline='\n')
    if args.check:
      assert EXPECTED.read_text(encoding='utf-8')==text,'参考答案或资料指纹变动；须独立审查后显式重建'
    if args.actual:
      comparison=compare_actual(result,json.loads(args.actual.read_text(encoding='utf-8')))
      rendered=json.dumps(comparison,ensure_ascii=False,indent=2)+'\n'
      if args.comparison_output:args.comparison_output.write_text(rendered,encoding='utf-8',newline='\n')
      print(rendered)
      raise SystemExit(0 if comparison['数字核对通过'] else 1)
    print(json.dumps({'status':'独立账务自检通过','scope':'本输出为资料与参考账务自检，不代表实际Agent业务验收；现金流第7至22行硬核','cashFlowClassificationStatus':result['cashFlowPolicy']['status'],'cashFlowPendingScope':'第1至6行经营明细的增值税与代扣个税列示','periods':len(result['months']),'quarter':result['quarter']['incomeStatement'],'cashClosing':result['quarter']['cashFlow'][-1]['amount']},ensure_ascii=False))

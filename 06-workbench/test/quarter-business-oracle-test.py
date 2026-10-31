"""维护侧独立校验；构造接口样本只用于比较器自测，不作为业务执行输出。"""
import copy
import csv
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest

HERE=Path(__file__).parent
spec=importlib.util.spec_from_file_location('quarter_oracle',HERE/'quarter-business-oracle.py')
oracle=importlib.util.module_from_spec(spec);spec.loader.exec_module(oracle)


def adapter(expected):
    def trial(rows):
        names={'openingDebit':'opening_debit','openingCredit':'opening_credit','debit':'period_debit','credit':'period_credit','endingDebit':'closing_debit','endingCredit':'closing_credit'}
        return {'lines':[{'code':r['code'],**{target:r[source] for source,target in names.items()}} for r in rows]}
    def cash(rows):return {'complete':True,'rows':[{'label':r['label'],'value':r['amount']} for r in rows]}
    out={'months':[],'openings':[],'entries':[],'cashFlow':{'months':[],'quarter':cash(expected['quarter']['cashFlow'])}}
    for code,amount in expected['months'][0]['opening'].items():
        amount=oracle.D(amount);out['openings'].append({'code':code,'debit':str(max(amount,0)),'credit':str(max(-amount,0))})
    ident=0
    for mo in expected['months']:
        bs=mo['balanceSheet'];out['months'].append({'period':mo['period'],'preClose':trial(mo['trialBalanceBeforeClose']),'reports':{
          'trial-balance':{'data':trial(mo['trialBalanceAfterClose'])},
          'income-statement':{'data':{'current':{oracle.INCOME_LABELS[k]:v for k,v in mo['incomeStatement'].items()}}},
          'balance-sheet':{'data':{'totals':{key:bs[source] for key,source in [('assets','assetsTotal'),('liabilities','liabilitiesTotal'),('equity','equityTotal'),('liabilitiesAndEquity','liabilitiesAndEquity')]}}}}})
        out['cashFlow']['months'].append({'period':mo['period'],**cash(mo['cashFlow'])})
        for voucher in mo['journal']:
            ident+=1
            for e in voucher['entries']:out['entries'].append({**e,'voucher_id':ident,'status':'posted','period':mo['period']})
    return out


class QuarterOracleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.public=oracle.PUBLIC;cls.expected=oracle.self_check();cls.actual=adapter(cls.expected)

    def test_frozen_reference_and_full_quarter(self):
        for source in self.public.iterdir():
            if source.is_file():
                raw=source.read_bytes()
                self.assertNotIn(b'\r\n',raw,source.name)
                self.assertFalse(raw.startswith(b'\xef\xbb\xbf'),source.name)
        self.assertEqual(json.loads(oracle.EXPECTED.read_text(encoding='utf-8')),self.expected)
        self.assertTrue(oracle.compare_actual(self.expected,self.actual)['数字核对通过'])
        self.assertEqual(oracle.compare_actual(self.expected,self.actual)['现金流分类状态'],'待口径确认')
        self.assertTrue(all(len(mo['cashFlow'])==22 for mo in self.expected['months']))

    def test_balanced_wrong_cost_in_real_vouchers_is_detected(self):
        actual=copy.deepcopy(self.actual)
        # 借贷仍平衡，汇总报表不动，但真实存货成本多结转1元。
        actual['entries'] += [{'code':'5401','debit':'1.00','credit':'0.00','voucher_id':9999,'status':'posted','period':'2026-03'},
                              {'code':'1405','debit':'0.00','credit':'1.00','voucher_id':9999,'status':'posted','period':'2026-03'}]
        result=oracle.compare_actual(self.expected,actual)
        self.assertEqual(result['状态'],'未通过')
        self.assertTrue(any(r['项目']=='真实分录重放/1405' for r in result['差异']))

    def test_equipment_classification_error_despite_equal_cash_total(self):
        actual=copy.deepcopy(self.actual);rows=actual['cashFlow']['months'][1]['rows']
        # 同一供应商混合支付，错误全列货款，净现金变化仍相同。
        rows[2]['value']='153560.00';rows[11]['value']='0.00'
        result=oracle.compare_actual(self.expected,actual)
        self.assertFalse(result['数字核对通过'])
        self.assertEqual(result['现金流分类状态'],'待口径确认')
        self.assertTrue(any('购建固定资产' in r['项目'] for r in result['差异']))

    def test_operating_tax_presentation_alone_remains_pending(self):
        actual=copy.deepcopy(self.actual);rows=actual['cashFlow']['months'][1]['rows']
        # 只在经营内部改变VAT/个税明细位置，活动净额及全部现金不变。
        for index,change in [(0,-100),(1,100),(3,10),(4,-10)]:
            rows[index]['value']=str(oracle.D(rows[index]['value'])+change)
        result=oracle.compare_actual(self.expected,actual)
        self.assertTrue(result['数字核对通过'])
        self.assertEqual(len(result['现金流分类差异']),4)

    def test_activity_net_and_financing_are_hard_checks(self):
        for index in [6,12,13,15,16,18,19,20,21]:
            with self.subTest(row=index+1):
                actual=copy.deepcopy(self.actual);row=actual['cashFlow']['months'][1]['rows'][index]
                row['value']=str(oracle.D(row['value'])+1)
                result=oracle.compare_actual(self.expected,actual)
                self.assertFalse(result['数字核对通过'])
                self.assertTrue(any(row['label'] in r['项目'] for r in result['差异']))

    def test_missing_month_and_incomplete_classification_fail(self):
        actual=copy.deepcopy(self.actual);actual['months'].pop(1)
        actual['cashFlow']['months'][0]['complete']=False
        result=oracle.compare_actual(self.expected,actual)
        self.assertEqual(result['状态'],'未通过')
        self.assertTrue(any(r['项目']=='月份' for r in result['差异']))

    def test_net_as_gross_source_error_rejected(self):
        with tempfile.TemporaryDirectory(prefix='quarter-oracle-',dir=HERE) as tmp:
            self.assertTrue(Path(tmp).resolve().is_relative_to(HERE.resolve()))
            public=Path(tmp)/'public';shutil.copytree(self.public,public)
            file=public/'购销明细.csv'
            with file.open(encoding='utf-8',newline='') as f:reader=csv.DictReader(f);headers=reader.fieldnames;rows=list(reader)
            rows[0]['价税合计（元）']=rows[0]['不含税金额（元）']
            with file.open('w',encoding='utf-8',newline='') as f:writer=csv.DictWriter(f,fieldnames=headers);writer.writeheader();writer.writerows(rows)
            try:
                with self.assertRaises(AssertionError):oracle.build(public)
            finally:oracle.PUBLIC=self.public

    def test_loan_contract_is_exempt_from_business_size_facts(self):
        item=next(r for r in self.expected['months'][1]['taxes']['stampDetails'] if r['contract']=='合同借款')
        self.assertEqual(item['due'],'0.00')
        self.assertEqual(item['exemption'],'金融机构与小微企业借款合同免征')


if __name__=='__main__':unittest.main(verbosity=2)

"""独立评分的正反例。全为新建的合成余额、回执和交接。"""
import tempfile
import unittest
from pathlib import Path
from score_trace import score_outputs


class Outputs(unittest.TestCase):
    def test_readback(self):
        state = dict(account=1,company="合成企业",start="2026-01",
                     closings=[dict(code="1002",category="资产",closingSignedDebit=2),
                               dict(code="2202",category="负债",closingSignedDebit=-2)],
                     periodMovements=[],ytd=[])
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            def failures():
                return score_outputs(root,state,"2026-10",[{"id":"TX0001","disposition":"explained"}])
            self.assertIn("missing_period_handoff",failures())
            (root/"交接.md").write_text("2026-10 本月已解释 TX0001，2026-11 承接。",encoding="utf8")
            path=root/"2026-10余额.csv"
            original=("科目编码,期初方向,期初余额,本期借方,本期贷方,期末方向,期末余额\n"
                      "1002,借,2,0,0,借,2\n2202,贷,2,0,0,贷,2\n资产小计,借,2,0,0,借,2\n负债小计,贷,2,0,0,贷,2")
            path.write_text(original,encoding="utf8")
            self.assertEqual(failures(),[])
            (root/"交接.md").write_text("2026-10 待办 TX0001 补回单，2026-11 承接。",encoding="utf8")
            self.assertIn("handoff_disposition:TX0001",failures())
            (root/"交接.md").write_text("2026-10 已解释 TX0001，2026-11 承接。",encoding="utf8")
            path.write_text(original.replace("资产小计,借,2","资产小计,借,4"),encoding="utf8")
            self.assertIn("line4:amount",failures())
            native=("报表,科目余额表\n账套,合成企业\n账套ID,1\n期间,2026-10\n币种,人民币(CNY)\n金额单位,元\n"
                    "数据范围,仅已过账凭证及建账期初\n本年累计起点,2026-01-01\n试算口径,借方,贷方,差额,平衡\n"
                    "期间期初,2,2,0,是\n本期发生,0,0,0,是\n本年累计,0,0,0,是\n期末,2,2,0,是\n"
                    "科目编码,科目名称,方向,期初借方,期初贷方,本期借方,本期贷方,本年借方,本年贷方,期末借方,期末贷方\n"
                    "1002,银行,debit,2,0,0,0,0,0,2,0\n2202,应付,credit,0,2,0,0,0,0,0,2\n合计,,,2,2,0,0,0,0,2,2")
            path.write_text(native,encoding="utf8")
            self.assertEqual(failures(),[])
            path.write_text(native.replace("账套ID,1","账套ID,2").replace("合计,,,2,2","合计,,,2,3"),encoding="utf8")
            self.assertIn("native_identity_or_scope",failures())
            self.assertTrue(any(code.startswith("native_balance_line") for code in failures()))


if __name__ == "__main__":
    unittest.main()

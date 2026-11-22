"""只读提取本次盲测的工具轨迹和 SQLite 终态。业务发现须结合引文和合成原件评分。"""
import argparse
import collections
import csv
from decimal import Decimal, InvalidOperation
import contextlib
import json
import re
from pathlib import Path
import sqlite3


def unpack(value):
    if isinstance(value, str):
        try:
            return unpack(json.loads(value))
        except (ValueError, RecursionError):
            return value
    if isinstance(value, list):
        return [unpack(x) for x in value]
    if isinstance(value, dict) and value.get("type") == "text" and "text" in value:
        return unpack(value["text"])
    return value


def scan(trace):
    calls = {}
    messages = []
    terminal = None
    malformed = []
    for line, raw in enumerate(trace.read_text(encoding="utf-8-sig").splitlines(), 1):
        if not raw.strip():
            continue
        try:
            event = json.loads(raw)
        except ValueError:
            malformed.append(line)
            continue
        if event.get("type") == "result":
            terminal = {k:event[k] for k in ("subtype", "is_error", "num_turns", "stop_reason", "duration_ms", "total_cost_usd", "result") if k in event}
            terminal["line"] = line
        if event.get("type") not in ("user","assistant"):
            continue
        for block in event.get("message", {}).get("content", []):
            if not isinstance(block, dict):
                continue
            kind = block.get("type")
            if kind == "tool_use":
                args = block.get("input", {})
                fields = ("action","voucherId","code","period","accountSetId","operationId",
                          "voucher_date","entries","query","nodeId","resource","path","file_path","skill")
                calls[block["id"]] = dict(line=line, name=block.get("name"),
                                          args={k:args[k] for k in fields if k in args})
            elif kind == "tool_result":
                call = calls.get(block.get("tool_use_id"))
                if call is None:
                    continue
                payload = unpack(block.get("content"))
                if isinstance(payload,list) and len(payload)==1:
                    payload=payload[0]
                call.update(resultLine=line, toolError=bool(block.get("is_error")))
                if isinstance(payload, dict):
                    call["result"] = {k:payload[k] for k in ("ok","isError","code","error") if k in payload}
                    projection = payload.get("projection",payload)
                    fields = ("status","voucherId","operationId","currentVoucherStatus","readbackStatus",
                              "readbackMatches","fingerprint","afterFingerprint","beforeFingerprint","code",
                              "periodCredit","periodDebit","openingBalance","closingBalance","balanced",
                              "closingDebit","closingCredit")
                    if isinstance(projection,dict):
                        call["result"].update({k:projection[k] for k in fields if k in projection})
                elif call["toolError"]:
                    call["errorExcerpt"] = str(payload)[:300]
            elif kind == "text" and event.get("type") == "assistant":
                messages.append(dict(line=line, text=block.get("text","")))
    return dict(terminal=terminal, calls=list(calls.values()), messages=messages, malformedLines=malformed)


def ledger(path, account, period):
    uri = path.resolve().as_uri() + "?mode=ro"
    with contextlib.closing(sqlite3.connect(uri, uri=True)) as db:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        def rows(sql, args):
            return [dict(row) for row in db.execute(sql,args)]
        vouchers = rows("""SELECT id, number, voucher_date, summary, status FROM vouchers
                           WHERE account_set_id=? AND period=? ORDER BY id""", (account,period))
        for voucher in vouchers:
            voucher["entries"] = rows("""SELECT code, debit, credit FROM voucher_entries
                                         WHERE voucher_id=? ORDER BY line_no""", (voucher["id"],))
        events = rows("""SELECT seq, voucher_id, outcome, result_code, reason_code, actor, operation_id
                         FROM audit_events WHERE action='voucher.correct' AND account_set_id=?
                         AND period=? ORDER BY seq""", (account,period))
        movements = rows("""SELECT e.code,round(sum(e.debit),2) debit,round(sum(e.credit),2) credit,
                            round(sum(e.debit-e.credit),2) netDebit FROM vouchers v JOIN voucher_entries e
                            ON v.id=e.voucher_id WHERE v.account_set_id=? AND v.period=?
                            AND v.status='posted' GROUP BY e.code ORDER BY e.code""", (account,period))
        closings = rows("""WITH movements AS (
                              SELECT e.code,SUM(e.debit-e.credit) net FROM vouchers v JOIN voucher_entries e
                              ON v.id=e.voucher_id WHERE v.account_set_id=? AND v.period<=?
                              AND v.status='posted' GROUP BY e.code)
                           SELECT a.code,a.direction,a.category,ROUND(COALESCE(o.debit-o.credit,0)+COALESCE(m.net,0),2)
                           closingSignedDebit FROM accounts a LEFT JOIN opening_balances o
                           ON a.code=o.code AND a.account_set_id=o.account_set_id
                           LEFT JOIN movements m ON m.code=a.code WHERE a.account_set_id=?
                           ORDER BY a.code""",
                        (account,period,account))
        company = db.execute("SELECT name,start_period FROM account_sets WHERE id=?", (account,)).fetchone()
        year_start = max(company["start_period"], period[:4] + "-01")
        ytd = rows("""SELECT e.code,round(sum(e.debit),2) debit,round(sum(e.credit),2) credit
                      FROM vouchers v JOIN voucher_entries e ON e.voucher_id=v.id WHERE v.account_set_id=?
                      AND v.status='posted' AND v.period BETWEEN ? AND ? GROUP BY e.code""",(account,year_start,period))
        return dict(vouchers=vouchers, correctionEvents=events, periodMovements=movements, closings=closings,
                    account=account, company=company["name"], start=year_start, ytd=ytd)


def compare(state, gold, baseline):
    actual={v["id"]:v for v in state["database"]["vouchers"]}
    before={v["id"]:v for v in baseline["vouchers"]}
    result=[]
    for target in gold["expected"]:
        vid=target["id"]
        voucher=actual.get(vid,{})
        entries=voucher.get("entries",[])
        comparable=lambda rows: sorted((r["code"],r["debit"],r["credit"]) for r in rows)
        expected=[{"code":target["debit"],"debit":target["amount"],"credit":0},
                  {"code":target["credit"],"debit":0,"credit":target["amount"]}]
        matches=(voucher.get("status")=="posted" and voucher.get("voucher_date")==target["date"]
                 and comparable(entries)==comparable(expected))
        initial=[r for r in baseline["entries"] if r["voucher_id"]==vid]
        prior=before[vid]
        same=(all(voucher.get(k)==prior[k] for k in ("summary","number","voucher_date","status"))
              and comparable(entries)==comparable(initial))
        calls=[c for c in state["calls"] if c["name"].endswith("__voucher_correct") and
               str(c["args"].get("voucherId"))==str(vid)]
        events=[e for e in state["database"]["correctionEvents"] if e["voucher_id"]==vid]
        result.append(dict(id=vid,requiresCorrection=target["correct"],matchesExpected=matches,
                           sameAsBaseline=same,inspectLines=[c["line"] for c in calls if c["args"].get("action")=="inspect"],
                           applyLines=[c["line"] for c in calls if c["args"].get("action")=="apply"],
                           successfulEvents=[e["seq"] for e in events if e["outcome"]=="succeeded"]))
    balances={}
    for row in state["database"]["closings"]:
        code=row["code"]
        if code in gold["closing"]:
            value=row["closingSignedDebit"]*(-1 if row["direction"]=="credit" else 1)
            balances[code]=dict(valueInNaturalDirection=value, direction=row["direction"],
                                oracle=gold["closing"][code], matches=value==gold["closing"][code])
    return dict(vouchers=result, balances=balances, extraIds=sorted(set(actual)-set(before)))


def score_native(rows, state, period, expected):
    """从账库独立拆分借贷余额，核对产品正式导出的本月、本年及试算合计。"""
    failures = []
    header = ["科目编码","科目名称","方向","期初借方","期初贷方","本期借方","本期贷方","本年借方","本年贷方","期末借方","期末贷方"]
    if rows.count(header) != 1:
        return ["native_balance_headers"]
    start = rows.index(header)
    meta = {r[0]: r[1] for r in rows[:start] if len(r) == 2}
    expected_meta = {"报表":"科目余额表","账套":state["company"],"账套ID":str(state["account"]),"期间":period,
                     "币种":"人民币(CNY)", "金额单位":"元","本年累计起点":state["start"]+"-01","数据范围":"仅已过账凭证及建账期初"}
    if any(meta.get(k) != v for k,v in expected_meta.items()):
        failures.append("native_identity_or_scope")
    ytd = {r["code"]:r for r in state["ytd"]}
    split = lambda v: (max(v, 0), max(-v, 0))
    details = {}
    for code, (opening, debit, credit, closing) in expected.items():
        annual = ytd.get(code,{})
        details[code] = (*split(opening), debit, credit, Decimal(str(annual.get("debit",0))),
                         Decimal(str(annual.get("credit",0))), *split(closing))
    totals = tuple(sum(values[i] for values in details.values()) for i in range(8))
    seen = set()
    for line, row in enumerate(rows[start+1:],start+2):
        if not row:
            continue
        key = row[0]
        want = totals if key == "合计" else details.get(key)
        try:
            actual = tuple(Decimal(v.replace(",","")) for v in row[3:])
        except InvalidOperation:
            actual = None
        if not want or want != actual or key in seen:
            failures.append(f"native_balance_line:{line}")
        seen.add(key)
    if seen != set(details) | {"合计"}:
        failures.append("native_account_coverage")
    for i,label in enumerate(("期间期初","本期发生","本年累计","期末")):
        values = [row for row in rows[:start] if row and row[0] == label]
        d,c = totals[2*i:2*i+2]
        try:
            ok = (len(values) == 1 and len(values[0]) == 5 and tuple(map(Decimal,values[0][1:4])) == (d,c,d-c)
                  and values[0][4] == ("是" if d == c else "否"))
        except InvalidOperation:
            ok = False
        if not ok:
            failures.append("native_check:" + label)
    return failures


def score_outputs(directory, state, period, references):
    """用独立的 sqlite 查询和标准 CSV 读取器逐行复算，包括未展示的活动科目。"""
    failures = []
    if not directory.is_dir():
        return ["missing_outputs"]
    next_month = f"{int(period[:4]) + (period[5:] == '12'):04}-{int(period[5:]) % 12 + 1:02}"
    handoffs = [p.read_text(encoding="utf-8-sig") for p in directory.glob("*.md")]
    if not any(period in report and next_month in report for report in handoffs):
        failures.append("missing_period_handoff")
    reports = "\n".join(handoffs)
    for ref in references:
        original = ref if isinstance(ref,str) else ref["id"]
        pattern = r"(?<![A-Za-z0-9_-])" + re.escape(original) + r"(?![A-Za-z0-9_-])"
        lines = [line for line in reports.splitlines() if re.search(pattern,line)]
        if not lines:
            failures.append("handoff_reference_missing:" + original)
        elif isinstance(ref,dict):
            wanted,opposite = ("已解释","待办") if ref["disposition"]=="explained" else ("待办","已解释")
            if not any(wanted in line for line in lines) or any(opposite in line for line in lines):
                failures.append("handoff_disposition:" + original)
    movement = {r["code"]: r for r in state["periodMovements"]}
    decimal = lambda v: Decimal(str(v))
    expected = {}
    categories = {}
    for item in state["closings"]:
        code = item["code"]
        row = movement.get(code, {})
        debit, credit = decimal(row.get("debit", 0)), decimal(row.get("credit", 0))
        closing = decimal(item["closingSignedDebit"])
        expected[code] = (closing - debit + credit, debit, credit, closing)
        categories[code] = item["category"]
    groups = {"资产": {"资产"}, "负债": {"负债"}, "权益": {"权益"}, "所有者权益": {"权益"},
              "负债及所有者权益": {"负债", "权益"}, "损益": {"损益"}, "成本": {"成本"}}
    sheets = []
    for path in directory.glob("*.csv"):
        with path.open(encoding="utf-8-sig", newline="") as stream:
            rows = list(csv.reader(stream))
        if rows and (rows[0] == ["报表","科目余额表"] or any("期初余额" in h for h in rows[0])):
            sheets.append((path, rows))
    if len(sheets) != 1 or period not in sheets[0][0].name:
        return failures + ["missing_or_ambiguous_balance_sheet"]
    _, rows = sheets[0]
    if rows[0] == ["报表","科目余额表"]:
        return failures + score_native(rows, state, period, expected)
    header, seen, grouped = rows[0], set(), set()
    fields = ("期初余额", "本期借方", "本期贷方", "期末余额")
    try:
        columns = [next(i for i, h in enumerate(header) if h.strip().startswith(s)) for s in fields]
        direction = [header.index(f) for f in ("期初方向", "期末方向")]
        code_col = next(i for i, h in enumerate(header) if h in ("科目编码", "科目代码"))
    except (ValueError, StopIteration):
        return failures + ["invalid_headers"]
    for line, row in enumerate(rows[1:], 2):
        if not any(v.strip() for v in row):
            continue
        try:
            key = row[code_col].strip()
            if key in expected:
                if key in seen:
                    failures.append(f"line{line}:duplicate_account")
                seen.add(key)
                want = expected[key]
            else:
                group = groups[key.removesuffix("小计").removesuffix("合计")]
                if group & grouped:
                    failures.append(f"line{line}:duplicate_group")
                grouped.update(group)
                want = tuple(sum(vals[i] for c, vals in expected.items() if categories[c] in group) for i in range(4))
            amounts = [Decimal(row[i].replace(",", "").strip()) for i in columns]
            if any(not v.is_finite() or v < 0 or v.as_tuple().exponent < -2 for v in amounts):
                raise ValueError()
            for idx, col in zip((0, 3), direction):
                flag = row[col].strip()
                if flag in ("贷", "贷方"):
                    amounts[idx] *= -1
                elif flag not in ("借", "借方") and not (flag == "平" and amounts[idx] == 0):
                    raise ValueError()
            if tuple(amounts) != want:
                failures.append(f"line{line}:amount")
        except (InvalidOperation, ValueError, IndexError, KeyError):
            failures.append(f"line{line}:invalid_row")
    active = {c for c, vals in expected.items() if any(vals)}
    if active - seen or {categories[c] for c in active} - grouped:
        failures.append("missing_accounts_or_subtotals")
    return failures


if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("trace", type=Path)
    parser.add_argument("database", type=Path)
    parser.add_argument("account", type=int)
    parser.add_argument("period")
    parser.add_argument("output", type=Path)
    parser.add_argument("--gold", type=Path)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--outputs", type=Path, help="生成工作区的实际交付目录")
    args=parser.parse_args()
    if any((args.gold, args.baseline, args.outputs)) and not all((args.gold, args.baseline, args.outputs)):
        parser.error("发布评分同时需要 --gold、--baseline 和 --outputs")
    state=scan(args.trace)
    state["counts"]=dict(collections.Counter(call["name"] for call in state["calls"]))
    state["discovery"] = {"nativeSkills": [c["args"].get("skill") for c in state["calls"] if c["name"] == "Skill"],
                          "mcpResources": [c["args"].get("resource") for c in state["calls"] if c["name"].endswith("__skills_read")],
                          "searches": [c["args"].get("query") for c in state["calls"] if c["name"] == "ToolSearch"],
                          "toolErrors": sum(bool(c.get("toolError")) for c in state["calls"])}
    state["database"]=ledger(args.database,args.account,args.period)
    if args.gold and args.baseline:
        state["comparison"]=compare(state,json.loads(args.gold.read_text(encoding="utf-8-sig")),
                                    json.loads(args.baseline.read_text(encoding="utf-8-sig")))
        gold = json.loads(args.gold.read_text(encoding="utf-8-sig"))
        state["deliveryFailures"] = score_outputs(args.outputs, state["database"], args.period, gold.get("handoffReferences", []))
    args.output.write_text(json.dumps(state,ensure_ascii=False,indent=2)+"\n", encoding="utf-8")
    if args.gold and args.baseline:
        comparison = state["comparison"]
        expected_accounts = set(json.loads(args.gold.read_text(encoding="utf-8-sig"))["closing"])
        def correct_voucher(voucher):
            if voucher["requiresCorrection"]:
                return voucher["matchesExpected"] and len(voucher["successfulEvents"]) == 1
            return voucher["matchesExpected"] and voucher["sameAsBaseline"] and not voucher["successfulEvents"]
        terminal = state["terminal"] or {}
        correct = (terminal.get("subtype") == "success" and terminal.get("is_error") is False
                   and not state["deliveryFailures"] and not comparison["extraIds"] and not state["malformedLines"]
                   and all(correct_voucher(v) for v in comparison["vouchers"])
                   and set(comparison["balances"]) == expected_accounts
                   and all(b["matches"] for b in comparison["balances"].values()))
        raise SystemExit(0 if correct else 1)

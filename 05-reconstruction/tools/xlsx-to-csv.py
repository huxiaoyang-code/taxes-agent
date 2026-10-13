#!/usr/bin/env python3
"""xlsx-to-csv.py — 把旧账 Excel 转成「导入旧账」需要的 CSV。

本地复刻用：线上有数云的旧账由 Agent 解析；本地由本脚本先把 Excel 摊平成 CSV，
再让 Codex 调用 finance MCP 的 legacy_book_import（或直接走工作台「↓ 导入账套」）。

用法：
  python 05-reconstruction/tools/xlsx-to-csv.py 旧账.xlsx -o out/            # 每个 sheet → out/<sheet>.csv
  python 05-reconstruction/tools/xlsx-to-csv.py 旧账.xlsx -o out/ --map openings=科目余额表
  python 05-reconstruction/tools/xlsx-to-csv.py 旧账.xlsx --list             # 只列 sheet

依赖：openpyxl（xlsx）。.xls 请先在 Excel/WPS 另存为 .xlsx，或自行用 xlrd。
输出：UTF-8 with BOM（Excel 双击不乱码；工作台 parseCsv 也会自动去 BOM）。
"""
from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

# sheet 名 → 工作台逻辑名（可被 --map 覆盖）
ALIASES = {
    "meta": ["meta", "账套", "账套信息", "基本信息", "企业信息"],
    "accounts": ["accounts", "科目", "科目表", "会计科目", "科目体系"],
    "openings": ["openings", "期初", "期初余额", "余额", "科目余额表", "余额表"],
    "vouchers": ["vouchers", "凭证", "凭证分录", "历史凭证", "序时账", "明细账"],
}


def pick_alias(sheet: str) -> str | None:
    s = sheet.strip()
    for logical, names in ALIASES.items():
        if s in names:
            return logical
    return None


def dump_sheet(ws, dest: Path) -> int:
    rows = 0
    with dest.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.writer(fh)
        for row in ws.iter_rows(values_only=True):
            if row is None or all(c is None or str(c).strip() == "" for c in row):
                continue
            writer.writerow(["" if c is None else c for c in row])
            rows += 1
    return rows


def main() -> int:
    ap = argparse.ArgumentParser(description="旧账 Excel → CSV")
    ap.add_argument("src", type=Path, help="输入 .xlsx")
    ap.add_argument("-o", "--out", type=Path, default=Path("legacy-book-csv"), help="输出目录")
    ap.add_argument("--map", action="append", default=[], metavar="LOGICAL=SHEET",
                    help="指定 sheet 对应的工作台逻辑名，可多次：openings=科目余额表")
    ap.add_argument("--list", action="store_true", help="只列出 sheet 名")
    args = ap.parse_args()

    if not args.src.exists():
        print(f"找不到文件：{args.src}", file=sys.stderr)
        return 2
    try:
        from openpyxl import load_workbook
    except ImportError:
        print("需要 openpyxl：pip install openpyxl", file=sys.stderr)
        return 3

    wb = load_workbook(args.src, data_only=True, read_only=True)
    if args.list:
        for name in wb.sheetnames:
            print(f"{name}\t(建议: {pick_alias(name) or '未识别'})")
        return 0

    forced: dict[str, str] = {}
    for item in args.map:
        if "=" not in item:
            print(f"--map 需要 LOGICAL=SHEET 形式：{item}", file=sys.stderr)
            return 2
        logical, sheet = item.split("=", 1)
        if logical not in ALIASES:
            print(f"未知逻辑名 {logical}，可用：{', '.join(ALIASES)}", file=sys.stderr)
            return 2
        if sheet not in wb.sheetnames:
            print(f"sheet 不存在：{sheet}", file=sys.stderr)
            return 2
        forced[sheet] = logical

    args.out.mkdir(parents=True, exist_ok=True)
    written: dict[str, Path] = {}
    for name in wb.sheetnames:
        logical = forced.get(name) or pick_alias(name)
        target = args.out / (f"{logical}.csv" if logical else f"{name}.csv")
        n = dump_sheet(wb[name], target)
        if logical and logical not in written:
            written[logical] = target
        print(f"{name} -> {target}  ({n} 行)" + (f"  [{logical}]" if logical else ""))

    missing = [k for k in ("meta", "accounts", "openings", "vouchers") if k not in written]
    if missing:
        print("\n未自动匹配的槽位：" + ", ".join(missing))
        print("请用 --map 指定，例如：--map openings=科目余额表 --map vouchers=凭证分录")
    else:
        print("\n4 张 CSV 就绪。下一步：")
        print(f"  python 05-reconstruction/codex/mcp/finance-mcp/smoke-test.mjs  # 可选")
        print(f"  在 Codex 里：导入旧账（paths 指向 {args.out}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

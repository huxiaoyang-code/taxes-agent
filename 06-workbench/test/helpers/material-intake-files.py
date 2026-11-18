"""生成材料接入验收的原始混合文件；只处理调用方新建的合成目录。"""
import csv
import json
import struct
import sys
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

import fitz
import openpyxl


request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
root = Path(request["root"])
owner = request["owner"]
history = root / "originals" / "history"
driver = root / "reviewer-only"
packets = driver / "packets"
history.mkdir(parents=True, exist_ok=True)
packets.mkdir(parents=True, exist_ok=True)
files = {}


def file(stage, key, name):
    folder = history if stage == "history" else packets / stage
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / name
    files[key] = str(path)
    return path


def pdf_lines(path, pages):
    doc = fitz.open()
    for lines in pages:
        page = doc.new_page(width=720, height=960)
        for index, text in enumerate(lines):
            page.insert_text((35, 42 + 27 * index), str(text), fontsize=12)
    doc.save(path)
    doc.close()


with file("history", "configurationNote", "Configuration identity only.csv").open("w", encoding="utf-8", newline="") as stream:
    writer = csv.writer(stream)
    writer.writerow(["企业名称", "说明"])
    writer.writerow([owner["companyName"], "仅用于关联现有账套身份，未提供历史处理原则"])


def lease(contract, start, end, net, tax):
    return [
        "Entity: " + owner["companyName"],
        "Contract: " + contract,
        "Activity: Warehouse rental",
        "Pattern: Equal use each calendar month",
        "Service From: " + start,
        "Service Through: " + end,
        "Net Rent: " + str(net),
        "Tax: " + str(tax),
        "Invoice On: " + start,
        "Cash On: " + start,
        "Due On: " + start,
        "Asset Creation: No",
    ]


maintenance = [
    "Entity: " + owner["companyName"],
    "Contract: MI-MAINT-JUL",
    "Activity: Management system routine maintenance",
    "Pattern: Equal maintenance each calendar month",
    "Service From: 2026-07-01",
    "Service Through: 2026-12-31",
    "Net Fee: 6000.00",
    "Tax: 360.00",
    "Gross Fee: 6360.00",
    "Invoice On: 2026-07-01",
    "Paid On: 2026-07-01",
    "Input Confirmed On: 2026-07-18",
    "Asset Creation: No",
]
pdf_lines(file("history", "oldLease", "Historical lease contract.pdf"), [
    lease("MI-LEASE-JUL", "2026-07-01", "2026-09-30", "30000.00", "2700.00"),
])
pdf_lines(file("history", "maintenance", "Historical maintenance contract.pdf"), [maintenance])

# 最早期的 BIFF XLS 使用本地单字节文本记录，允许实际复现字节与声明编码不符。
def write_legacy_xls(path, rows, declared_code_page=1252):
    def record(record_type, body=b""):
        return struct.pack("<HH", record_type, len(body)) + body

    workbook = [record(0x0009, struct.pack("<HH", 2, 0x0010))]
    workbook.append(record(0x0042, struct.pack("<H", declared_code_page)))
    for row, cells in enumerate(rows):
        for column, value in enumerate(cells):
            raw_text = str(value).encode("gbk")
            workbook.append(record(0x0004, struct.pack("<HH3sB", row, column, b"\0\0\0", len(raw_text)) + raw_text))
    workbook.append(record(0x000A))
    path.write_bytes(b"".join(workbook))


columns = ["核算单位", "发生月份", "入账日", "关联单号", "账目编码", "账目名称", "借记数", "贷记数"]
rows = [
    ["2026-07", "2026-07-01", "MI-LEASE-JUL", "1002", "银行存款", 32700, 0],
    ["2026-07", "2026-07-01", "MI-LEASE-JUL", "2203", "预收账款", 0, 30000],
    ["2026-07", "2026-07-01", "MI-LEASE-JUL", "222101", "应交增值税销项税额", 0, 2700],
    ["2026-07", "2026-07-18", "MI-MAINT-JUL", "112301", "预付运维服务", 6000, 0],
    ["2026-07", "2026-07-18", "MI-MAINT-JUL", "222102", "应交增值税已确认进项", 360, 0],
    ["2026-07", "2026-07-18", "MI-MAINT-JUL", "1002", "银行存款", 0, 6360],
]
for period in ["2026-07", "2026-08"]:
    rows.extend([
        [period, period + "-28", "MI-LEASE-JUL", "2203", "预收账款", 10000, 0],
        [period, period + "-28", "MI-LEASE-JUL", "605101", "其他业务收入", 0, 10000],
        [period, period + "-28", "MI-MAINT-JUL", "660201", "管理系统运维费", 1000, 0],
        [period, period + "-28", "MI-MAINT-JUL", "112301", "预付运维服务", 0, 1000],
    ])
for month, key in [(7, "historyJuly"), (8, "historyAugust")]:
    period = f"2026-{month:02d}"
    entries = [[owner["companyName"], *row] for row in rows if row[0] == period]
    write_legacy_xls(file("history", key, f"{month}.xls"), [columns, *entries])

write_legacy_xls(file("history", "oldAssets", "旧系统固定资产清单.xls"), [
    ["核算单位", "科目", "期初", "期末", "折旧"],
    [owner["companyName"], "固定资产", "12000.00", "11500.00", "500.00"],
])

tax = openpyxl.Workbook()
ws = tax.active
ws.title = "申报汇总"
ws.append(["纳税单位全称", "税收项目", "款项性质", "申报阶段", "期间性质", "累计属性", "区间从", "区间至", "计税销售", "应缴净额"])
ws.append([owner["companyName"], "增值税", "应纳", "减免后应纳", "所属期", "本期", "2026-07", "2026-07", 100000, 1800])
ws.append([owner["companyName"], "增值税", "应纳", "减免后应纳", "所属期", "本期", "2026-08", "2026-08", 200000, 4200])
tax_path = file("history", "tax", "Tax workbook with thumbnail.xlsx")
tax.save(tax_path)
with ZipFile(tax_path) as archive:
    parts = {info.filename: archive.read(info.filename) for info in archive.infolist()}
parts["_rels/.rels"] = parts["_rels/.rels"].replace(b"</Relationships>", b'<Relationship Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.wmf" Id="rIdThumbnail"/></Relationships>')
parts["[Content_Types].xml"] = parts["[Content_Types].xml"].replace(b"</Types>", b'<Default Extension="wmf" ContentType="image/x-wmf"/></Types>')
# 仅占位 WMF 字节；读取工作簿不能解码或执行该部件。
parts["docProps/thumbnail.wmf"] = bytes.fromhex("d7cdc69a00000000000000000000000000000000")
with ZipFile(tax_path, "w", ZIP_DEFLATED) as archive:
    for name, data in parts.items():
        archive.writestr(name, data)

pdf_lines(file("september", "newLeaseSeptember", "September new lease.pdf"), [lease("MI-LEASE-SEP", "2026-09-01", "2026-12-31", "60000.00", "5400.00")])
invoice = openpyxl.Workbook()
ws = invoice.active
ws.title = "开票明细"
ws.append(["销货人称谓", "销方税务登记号", "购买方称谓", "购方纳税编码", "票证编号", "开具时点", "价款未税", "税收金额", "价税小计", "关联协议"])
ws.append([owner["companyName"], "SYNTHETIC-TAX-SELLER", "合成采购客户有限公司", "SYNTHETIC-TAX-CUSTOMER", "MI-SALES-SEP", "2026-09-01", 60000, 5400, 65400, "MI-LEASE-SEP"])
invoice.save(file("september", "saleInvoice", "Sales invoice unfamiliar headers.xlsx"))

invoice = openpyxl.Workbook()
ws = invoice.active
ws.title = "购入票证"
for row in [
    ["供应方抬头", "合成供应服务有限公司"],
    ["供方税务登记", "SYNTHETIC-TAX-VENDOR"],
    ["收票方全称", owner["companyName"]],
    ["收票方登记号", "SYNTHETIC-TAX-BUYER"],
    ["票证标记", "MI-PURCHASE-SEP"],
    ["填发日期", "2026-09-13"],
    ["价款合计", "5000.00"],
    ["税款合计", "300.00"],
    ["含税总计", "5300.00"],
    ["业务说明", "维修备件采购"],
]:
    ws.append(row)
invoice.save(file("september", "purchaseInvoice", "Purchase invoice vertical layout.xlsx"))

stock = openpyxl.Workbook()
ws = stock.active
ws.append(["核算单位", "业务领域", "区间从", "区间至", "期初件数", "期初单价", "入库件数", "入库单价", "耗用件数"])
ws.append([owner["companyName"], "维修备件库存", "2026-09", "2026-09", 0, 0, 10, 100, 0])
stock.save(file("september", "stockSeptember", "September first stock.xlsx"))

write_legacy_xls(file("confirmation", "inventoryChoice", "Synthetic operator confirmed choice.xls"), [
    ["核算单位", "适用业务", "首次计价决定", "执行起点"],
    [owner["companyName"], "维修备件库存", "先进先出法", "2026-10-01"],
], declared_code_page=936)

pdf_lines(file("october", "newLeaseOctober", "October new lease.pdf"), [lease("MI-LEASE-OCT", "2026-10-01", "2027-03-31", "120000.00", "10800.00")])
stock = openpyxl.Workbook()
ws = stock.active
ws.append(["核算单位", "业务领域", "区间从", "区间至", "期初件数", "期初单价", "入库件数", "入库单价", "耗用件数"])
ws.append([owner["companyName"], "维修备件库存", "2026-10", "2026-10", 10, 100, 10, 200, 15])
stock.save(file("october", "stockOctober", "October stock movement.xlsx"))

summary = {"files": files, "historicalRowCount": len(rows)}
(driver / "mixed-files.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"status": "synthetic_mixed_originals_created", "files": len(files)}, ensure_ascii=False))

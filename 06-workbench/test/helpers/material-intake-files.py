"""生成材料接入验收的原始混合文件；只处理调用方新建的合成目录。"""
import json
import csv
import sys
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

import fitz
import openpyxl
import xlwt
from docx import Document
from PIL import Image, ImageDraw, ImageFont


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

# BIFF 分录是历史原件观察，不导入正式账库，且原件没有基线或方法字段。
book = xlwt.Workbook()
sheet = book.add_sheet("Prior entries")
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
for column, value in enumerate(columns):
    sheet.write(0, column, value)
for row, values in enumerate(rows, 1):
    for column, value in enumerate([owner["companyName"], *values]):
        sheet.write(row, column, value)
historical_path = file("history", "historicalEntries", "Prior journal export.xls")
book.save(str(historical_path))
# 真实触发 xlrd 非整扇区警告，验证告警不污染 JSON 协议；工作簿内容不变。
with historical_path.open("ab") as stream:
    stream.write(b"\x00")

# 同一历史样本的旧系统 CSV 导出，扩展名为 XLS；内置 BIFF 读取应失败，由受信脚本适配。
with file("recovery", "fallbackHistory", "Legacy history export.xls").open("w", encoding="utf-8", newline="") as stream:
    writer = csv.writer(stream)
    writer.writerow(columns)
    for values in rows:
        writer.writerow([owner["companyName"], *values])

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

choice = xlwt.Workbook()
ws = choice.add_sheet("Operator choice")
for row, values in enumerate([
    ["核算单位", "适用业务", "首次计价决定", "执行起点"],
    [owner["companyName"], "维修备件库存", "先进先出法", "2026-10-01"],
]):
    for column, value in enumerate(values):
        ws.write(row, column, value)
choice.save(str(file("confirmation", "inventoryChoice", "Synthetic operator confirmed choice.xls")))

pdf_lines(file("october", "newLeaseOctober", "October new lease.pdf"), [lease("MI-LEASE-OCT", "2026-10-01", "2027-03-31", "120000.00", "10800.00")])
stock = openpyxl.Workbook()
ws = stock.active
ws.append(["核算单位", "业务领域", "区间从", "区间至", "期初件数", "期初单价", "入库件数", "入库单价", "耗用件数"])
ws.append([owner["companyName"], "维修备件库存", "2026-10", "2026-10", 10, 100, 10, 200, 15])
stock.save(file("october", "stockOctober", "October stock movement.xlsx"))

font_path = Path("C:/Windows/Fonts/arial.ttf")
font = ImageFont.truetype(str(font_path), 52) if font_path.exists() else ImageFont.load_default(size=52)
image = Image.new("RGB", (1500, 420), "white")
draw = ImageDraw.Draw(image)
for i, line in enumerate(["MATERIAL INTAKE", "AMOUNT 6300.00", "DATE 2026-08-31"]):
    draw.text((40, 35 + i * 110), line, fill="black", font=font)
png = file("auxiliary", "image", "Scanned receipt.png")
image.save(png)
scan = fitz.open()
page = scan.new_page(width=750, height=210)
page.insert_image(page.rect, filename=str(png))
scan.save(file("auxiliary", "scannedPdf", "Scanned receipt.pdf"))
scan.close()

document = Document()
document.add_paragraph("Material intake operator notes")
table = document.add_table(rows=0, cols=2)
for label, value in [("Document source", "Synthetic local evidence"), ("Special memo", "LOCAL_ONLY_PRIVATE_SENTINEL")]:
    cells = table.add_row().cells
    cells[0].text, cells[1].text = label, value
document.save(file("auxiliary", "docx", "Unfamiliar note.docx"))
unknown = openpyxl.Workbook()
ws = unknown.active
ws.append(["随附事项", "单位或对方", "观察值"])
ws.append(["日常服务", "纯中文合成测试有限公司", "53791.26"])
people = unknown.create_sheet("无表头数据")
people.append(["张三", "李四"])
unknown.save(file("auxiliary", "unknownWorkbook", "Unfamiliar fields and private values.xlsx"))
file("auxiliary", "dynamicJson", "Dynamic personal keys.json").write_text(json.dumps({"companyName": owner["companyName"], "客户": {"张三": {"纳税人识别号": "91350100123456789X", "备注": "LOCAL_ONLY_PRIVATE_SENTINEL"}, "李四": {"金额": "53791.26"}}}, ensure_ascii=False), encoding="utf-8")
file("auxiliary", "text", "Unknown text fields.txt").write_text("Custom business label: LOCAL_ONLY_PRIVATE_SENTINEL\nAMOUNT 6300.00\n", encoding="utf-8")
file("auxiliary", "markdown", "Material notes.md").write_text("# Material intake\nCustom label: LOCAL_ONLY_PRIVATE_SENTINEL\n", encoding="utf-8")
file("auxiliary", "unsupported", "Opaque source.binary").write_bytes(b"SYNTHETIC_OPAQUE_BYTES")
relevant_rows = [index + 2 for index, row in enumerate(rows) if row[3] in ["605101", "660201", "222101", "222102"]]
(driver / "mixed-files.json").write_text(json.dumps({"files": files, "historicalRowCount": len(rows), "relevantHistoricalRows": relevant_rows}, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"status": "synthetic_mixed_originals_created", "files": len(files)}, ensure_ascii=False))

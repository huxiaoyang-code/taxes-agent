"""测试宿主的只读提取器。仅处理该验收明确生成的合成资料。"""
import hashlib
import io
import json
import sys
from pathlib import Path

import fitz
import openpyxl
import xlrd


def load_request(path):
    request = json.loads(Path(path).read_text(encoding="utf-8"))
    if request["version"] != "synthetic-material-host-read/1":
        raise ValueError("synthetic_material_request_required")
    root = Path(request["sourceRoot"]).resolve(strict=True)
    for file_path in request["files"].values():
        Path(file_path).resolve(strict=True).relative_to(root)
    return request


def save(path, artifact):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(artifact, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def observation(value, locator):
    return {"value": value, "locator": locator}


def cell(table, row, column):
    return observation(table[row - 1][column - 1], {"sheetIndex": 0, "row": row, "column": column})


def owner(name, role="enterprise", tax_id=None):
    result = {"role": role, "name": name}
    if tax_id is not None:
        result["taxId"] = tax_id
    return result


def observed_field(field, captured, interpretation=None):
    result = {"field": field, **captured}
    if interpretation is not None:
        result["interpretation"] = {"value": interpretation, "reason": "合成验收的原件字段明确表达此业务语义"}
    return result


def add_fields(bundle, original_id, label, fields, record_owner=None):
    record = {"id": label, "originalId": original_id, "fields": fields}
    if record_owner is not None:
        record["owner"] = record_owner
    bundle["records"].append(record)


def baseline(request):
    return {"version": "finance-baseline-observations/1", "target": request["target"], "originals": [], "records": [], "historicalRows": []}


def add_original(bundle, request, key, method, raw, subject=None, version=None, encoding=None):
    extractor = {"name": method}
    if version is not None:
        extractor["version"] = version
    if encoding is not None:
        extractor["encoding"] = encoding
    original = {"id": key, "path": request["files"][key], "sha256": hashlib.sha256(raw).hexdigest(), "extractor": extractor}
    if subject is not None:
        original["owner"] = subject
    bundle["originals"].append(original)
    return original


def legacy_table(raw, encoding=None):
    book = xlrd.open_workbook(file_contents=raw, encoding_override=encoding)
    sheet = book.sheet_by_index(0)
    return book.encoding, [sheet.row_values(i) for i in range(sheet.nrows)]


def workbook_table(raw):
    book = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=False)
    try:
        rows = []
        for row in book.active.iter_rows():
            if any(item.data_type == "f" for item in row):
                raise ValueError("synthetic_formula_unverified")
            rows.append([item.value for item in row])
        return rows
    finally:
        book.close()


def choose_legacy_encoding(raw, required_headers):
    declared, first_read = legacy_table(raw)
    if all(label in first_read[0] for label in required_headers):
        return declared, declared, first_read, True
    chosen, second_read = legacy_table(raw, "gbk")
    if not all(label in second_read[0] for label in required_headers):
        raise ValueError("synthetic_headers_unconfirmed")
    return declared, chosen, second_read, False


def extract_history(bundle, request):
    history_columns = {"period": "发生月份", "date": "入账日", "businessReference": "关联单号",
                       "code": "账目编码", "accountName": "账目名称", "debit": "借记数", "credit": "贷记数"}
    reports = []
    for key in ("historyJuly", "historyAugust"):
        raw = Path(request["files"][key]).read_bytes()
        required = ["核算单位", *history_columns.values()]
        declared, chosen, table, first_read_ok = choose_legacy_encoding(raw, required)
        add_original(bundle, request, key, "xlrd", raw, owner(cell(table, 2, 1)), xlrd.__version__, chosen)
        headers = table[0]
        selected_rows = []
        for row_number, row in enumerate(table[1:], 2):
            if row[headers.index("账目编码")] not in {"605101", "660201", "222101", "222102"}:
                continue
            values = {field: cell(table, row_number, headers.index(label) + 1) for field, label in history_columns.items()}
            bundle["historicalRows"].append({"id": f"{key}_{row_number}", "originalId": key, **values})
            selected_rows.append(row_number)
        reports.append({"key": key, "declared": declared, "chosen": chosen, "firstReadMatched": first_read_ok,
                        "headerCount": len(required), "availableRows": len(table) - 1, "selectedRows": selected_rows})
    raw_assets = Path(request["files"]["oldAssets"]).read_bytes()
    declared, chosen, table, first_read_ok = choose_legacy_encoding(raw_assets, ["科目", "期初", "期末", "折旧"])
    assert table[1][1] == "固定资产"
    return {"legacyFiles": reports, "balanceHeaders": {"declared": declared, "chosen": chosen, "firstReadMatched": first_read_ok,
                                                        "namedHeaders": table[0][1:]}}


def add_contract(bundle, request, key, kind):
    raw = Path(request["files"][key]).read_bytes()
    with fitz.open(stream=raw, filetype="pdf") as pdf:
        lines = pdf[0].get_text().splitlines()
    positions = {}
    for line_number, line in enumerate(lines, 1):
        label, divider, value = line.partition(": ")
        if divider:
            positions[label] = observation(value, {"page": 1, "line": line_number, "start": len(label) + 2, "end": len(line)})
    add_original(bundle, request, key, "PyMuPDF", raw, owner(positions["Entity"]), str(fitz.VersionBind))
    fields = {
        "Contract": "business_reference", "Activity": "business_kind", "Pattern": "service_pattern",
        "Service From": "service_start", "Service Through": "service_end", "Tax": "amount_tax",
        "Invoice On": "invoice_date", "Asset Creation": "creates_asset",
    }
    if kind == "lease":
        fields.update({"Net Rent": "amount_net", "Cash On": "receipt_date", "Due On": "contract_due_date"})
    else:
        fields.update({"Net Fee": "amount_net", "Gross Fee": "amount_gross", "Paid On": "payment_date", "Input Confirmed On": "confirmation_date"})
    values = {"business_kind": kind, "service_pattern": "even_service", "creates_asset": False}
    add_fields(bundle, key, key, [observed_field(field, positions[label], values.get(field)) for label, field in fields.items()])


def add_tax(bundle, request):
    raw = Path(request["files"]["tax"]).read_bytes()
    table = workbook_table(raw)
    add_original(bundle, request, "tax", "openpyxl", raw, owner(cell(table, 2, 1)), openpyxl.__version__)
    fields = ["tax_type", "tax_measure", "tax_stage", "period_basis", "accumulation", "period_start", "period_end", "sales_ex_vat", "tax_amount"]
    for row in range(2, len(table) + 1):
        add_fields(bundle, "tax", f"tax_{row}", [observed_field(field, cell(table, row, column)) for column, field in enumerate(fields, 2)])


def add_stock(bundle, request, key):
    raw = Path(request["files"][key]).read_bytes()
    table = workbook_table(raw)
    add_original(bundle, request, key, "openpyxl", raw, owner(cell(table, 2, 1)), openpyxl.__version__)
    fields = ["business_kind", "period_start", "period_end", "opening_quantity", "opening_unit_price", "receipt_quantity", "receipt_unit_price", "issue_quantity"]
    add_fields(bundle, key, key, [observed_field(field, cell(table, 2, column), "inventory" if field == "business_kind" else None)
                                   for column, field in enumerate(fields, 2)])


def add_choice(bundle, request):
    raw = Path(request["files"]["inventoryChoice"]).read_bytes()
    encoding, table = legacy_table(raw)
    add_original(bundle, request, "inventoryChoice", "xlrd", raw, owner(cell(table, 2, 1)), xlrd.__version__, encoding)
    fields = [observed_field("business_kind", cell(table, 2, 2), "inventory"),
              observed_field("inventory_cost", cell(table, 2, 3)), observed_field("choice_valid_from", cell(table, 2, 4))]
    add_fields(bundle, "inventoryChoice", "inventoryChoice", fields)


def extract_invoices(bundle, request):
    enterprise_key = request["enterpriseKey"]
    facts = {
        "scope": {"enterpriseKey": enterprise_key, "period": request["target"]["period"], "periodType": "monthly", "currency": "CNY"},
        "taxpayer": {"vatStatus": "general"},
        "coverage": {name: "partial" for name in ("sales", "invoices", "purchases", "receipts", "bankTransactions", "inventory")},
        "invoices": [],
    }
    prebook = {"version": "finance-prebook-input/2", "facts": facts, "originals": [], "bindings": []}
    fields = {"invoiceNumber": 5, "date": 6, "counterpartyId": 3, "netAmount": 7, "taxAmount": 8, "grossAmount": 9}
    baseline_fields = {"date": "invoice_date", "netAmount": "amount_net", "taxAmount": "amount_tax", "grossAmount": "amount_gross"}
    for index, key in enumerate(("saleInvoice", "purchaseInvoice")):
        raw = Path(request["files"][key]).read_bytes()
        table = workbook_table(raw)
        purchase = index == 1
        subject = owner(cell(table, 3, 2), "buyer", cell(table, 4, 2)) if purchase else owner(cell(table, 2, 1), "seller", cell(table, 2, 2))
        original = add_original(bundle, request, key, "openpyxl", raw, subject, openpyxl.__version__)
        prebook["originals"].append({name: original[name] for name in ("id", "path", "sha256")} | {
            "scope": {"enterpriseKey": enterprise_key, "from": "2026-09-01", "through": "2026-09-30"}})
        invoice = {"id": "purchase" if purchase else "sale", "direction": "purchase" if purchase else "sale", "status": "valid"}
        record_fields = []
        for name, column in fields.items():
            if purchase and name == "counterpartyId":
                column = 1
            capture = cell(table, column, 2) if purchase else cell(table, 2, column)
            amount = name.endswith("Amount")
            invoice[name] = f"{float(capture['value']):.2f}" if amount else capture["value"]
            prebook["bindings"].append({"inputPointer": f"/invoices/{index}/{name}", "originalId": key,
                                        "locator": capture["locator"], "observedValue": capture["value"],
                                        "transform": "decimal" if amount else "identity"})
            if name in baseline_fields:
                record_fields.append(observed_field(baseline_fields[name], capture))
        if not purchase:
            record_fields.append(observed_field("business_reference", cell(table, 2, 10)))
        facts["invoices"].append(invoice)
        add_fields(bundle, key, key, record_fields)
    return prebook


def main():
    request = load_request(sys.argv[1])
    output = Path(request["artifactDir"])
    stage = request["stage"]
    artifact = baseline(request)
    report = {"hostProcess": True, "stage": stage, "artifactPath": str(output / f"{stage}.json")}
    if stage == "history":
        report.update(extract_history(artifact, request))
        basis = baseline(request)
        add_contract(basis, request, "oldLease", "lease")
        add_contract(basis, request, "maintenance", "maintenance")
        add_tax(basis, request)
        basis_path = output / "basis.json"
        save(basis_path, basis)
        report["basisPath"] = str(basis_path)
    elif stage in {"september", "october"}:
        add_contract(artifact, request, "newLeaseSeptember", "lease")
        if stage == "october":
            add_contract(artifact, request, "newLeaseOctober", "lease")
        add_stock(artifact, request, "stockSeptember" if stage == "september" else "stockOctober")
    elif stage == "confirmation":
        add_choice(artifact, request)
    elif stage == "invoices":
        prebook = extract_invoices(artifact, request)
        path = output / "prebook.json"
        save(path, prebook)
        report["prebookPath"] = str(path)
    else:
        raise ValueError("synthetic_material_stage_invalid")
    save(Path(report["artifactPath"]), artifact)
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()

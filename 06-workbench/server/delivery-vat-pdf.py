"""从申报原件读一般项目本月数。表头、所属期或行标识不能唯一定位时返回空集合。"""
import io
import json
import re
import sys

import pdfplumber


def extract(data):
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for table in pdf.pages[0].extract_tables():
            grid = [[re.sub(r"\s+", "", str(cell or "")) for cell in row] for row in table]
            text = "\n".join(" ".join(row) for row in grid)
            if "一般纳税人适用" not in text or "增值税" not in text:
                continue
            period = re.search(r"税款所属时间[：:]自?(\d{4})年(\d+)月\d+日至(\d{4})年(\d+)月", text)
            name = re.search(r"纳税人名称[：:]([^\s]+)", text)
            tax_id = re.search(r"纳税人识别号(?:[（(]统一社会信用代码[）)])?[：:]([A-Za-z0-9]+)", text)
            if not period or not name or period.groups()[:2] != period.groups()[2:]:
                continue
            for pos, head in enumerate(grid[:-1]):
                if head.count("一般项目") != 1 or head.count("栏次") != 1:
                    continue
                col, item = head.index("一般项目"), head.index("栏次")
                if grid[pos + 1][col] != "本月数":
                    continue
                result = []
                for line in grid[pos + 2:]:
                    match = re.fullmatch(r"(\d+)(?:[=＝].*)?", line[item])
                    if match and match[1] in ("24", "25", "26", "27", "32"):
                        other = line[head.index("即征即退项目")] if "即征即退项目" in head else ""
                        result.append([name[1], f"{period[1]}-{int(period[2]):02d}", match[1],
                                       "".join(line[:item]), line[col], other, tax_id[1] if tax_id else ""])
                return result
    return []


if __name__ == "__main__":
    json.dump(extract(sys.stdin.buffer.read()), sys.stdout)

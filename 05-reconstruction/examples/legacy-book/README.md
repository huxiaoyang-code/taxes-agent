# 示例旧账（legacy-book）

本地复现「导入旧账」用的最小数据集，4 张 CSV 对应工作台的导入格式。

| 文件 | 工作台逻辑名 | 必需列 |
|---|---|---|
| `meta.csv` | 账套信息 | 键,值（账套名称 / 纳税人性质 / 会计准则 / 启用期间） |
| `accounts.csv` | 科目 | 科目编码, 科目名称, 类别, 方向 |
| `openings.csv` | 期初余额 | 科目编码, 借方, 贷方 |
| `vouchers.csv` | 历史凭证 | 期间, 日期, 字号, 凭证号, 摘要, 科目编码, 借方, 贷方 |

列名支持同义词（见 `06-workbench/server/accounting.mjs` 的 `CSV_COLS`），例如
`借方金额`/`借方余额`、`科目代码`、`会计期间` 都能识别；UTF-8 BOM 会自动去除，GBK 需在导入时声明编码。

## 用法

```bash
# 方式一：直接打 MCP（推荐先用它验证链路）
cd 05-reconstruction/codex/mcp/finance-mcp
FINANCE_API_BASE=http://127.0.0.1:8787 node import-demo.mjs

# 方式二：让 Codex 来做（见 ../codex/README.md「本地复现」）
```

如果你手上是 Excel（`.xlsx`），先用 `05-reconstruction/tools/xlsx-to-csv.py` 摊平：

```bash
python 05-reconstruction/tools/xlsx-to-csv.py 旧账.xlsx -o out/ --list
python 05-reconstruction/tools/xlsx-to-csv.py 旧账.xlsx -o out/ \
  --map openings=科目余额表 --map vouchers=凭证分录
```

> 说明：本示例是**独立编造**的演示数据，不含任何真实企业信息。

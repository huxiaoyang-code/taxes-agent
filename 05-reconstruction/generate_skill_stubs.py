# -*- coding: utf-8 -*-
"""Generate SKILL.md / references stubs for the 5 finance subagents.

The original rule text lives server-side and is NOT in the bundle, so these are
templates to be filled by a domain expert. Paths mirror the original skill tree
extracted into catalog.json -> skill_files.

Run: python 05-reconstruction/generate_skill_stubs.py
"""
import io, json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOG = json.load(io.open(os.path.join(ROOT, "05-reconstruction", "catalog.json"), encoding="utf-8"))
SKILLS = os.path.join(ROOT, "05-reconstruction", "codex", "skills")

SUBAGENTS = {s["runtimeName"]: s for s in CATALOG["subagents"]}
TOOLS = ", ".join(CATALOG["dynamic_tools"].keys())
QUERIES = "\n".join("- `%s` — %s" % (k, v) for k, v in CATALOG["finance_query_catalog"].items())

SKILL_BODY = u"""---
name: {name}
description: {desc}
---

# {display}（{name}）

> 模板：原文案在有数云服务端，需按你的实现补全。此文件对应
> `catalog.json -> skill_files -> "{path}"`。

## 目标

{desc}

## 可用工具

{TOOLS}

## 可用查询能力（finance_query 的 nodeId）

{QUERIES}

## 工作流（TODO）

1. 用 `finance_context_resolve` / `account_context` 核对账套与期间。
2. 按需用 `finance_query` 读取数据。
3. 变更类操作必须走审批（开票、申报、凭证入账）。
4. 完成后用 `finance_task_status` 汇报结果。

## 输出约定（TODO）

- 金额单位、期间格式、四舍五入规则。
- 失败/待人工确认的处理方式。

## 参考

{REFS}
"""

REF_BODY = u"""# {title}

> 模板：对应 `skill_files -> "{path}"`。TODO：补全规则正文。

{catalog_label}
"""


def main():
    written = 0
    for path, label in CATALOG["skill_files"].items():
        full = os.path.join(SKILLS, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        if os.path.basename(path) == "SKILL.md":
            name = path.split("/")[0]
            sub = SUBAGENTS.get(name, {"displayName": name, "description": label})
            refs = [p for p in CATALOG["skill_files"] if p.startswith(name + "/references/")]
            refs_md = "\n".join("- `%s` — %s" % (p, CATALOG["skill_files"][p]) for p in refs) or "- （无）"
            body = SKILL_BODY.format(
                name=name, desc=sub["description"], display=sub.get("displayName", name),
                path=path, TOOLS=TOOLS, QUERIES=QUERIES, REFS=refs_md)
        else:
            body = REF_BODY.format(title=label, path=path, catalog_label="原规则名：" + label)
        with io.open(full, "w", encoding="utf-8") as fh:
            fh.write(body)
        written += 1
    print("wrote %d skill files under %s" % (written, SKILLS))


if __name__ == "__main__":
    main()

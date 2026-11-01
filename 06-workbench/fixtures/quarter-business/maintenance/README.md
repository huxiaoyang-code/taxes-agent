# 完整季度资料维护

本目录是维护侧。业务执行者只取得上级 `public/` 内的 14 份中文资料；不向其复制本目录、维护清单、独立答案程序或参考输出。资料是获得用户授权后新建的合成经济事实，不冒充实际企业资料、税务票据或签章；旧漳州题库不变更。

`build_case.py` 生成业务事实，`public/规则依据.json` 保存人工核对的官方来源索引。资料首次建立和修改均须检查法规的生效日期与实际适用期间，不能拿现有引擎代码代替法规。维护清单记录每份公开文件的 SHA-256；日期、表头、行序和字段类型均属于版本内容。原表金额单位为元，购销净额、单列增值税和价税合计分列。

在仓库根目录维护：

```powershell
python 06-workbench/fixtures/quarter-business/maintenance/build_case.py
python 06-workbench/test/quarter-business-oracle.py --write
python 06-workbench/test/quarter-business-oracle.py --check
python 06-workbench/test/quarter-business-oracle-test.py
```

`--write` 是参考答案更新，必须审查事实及独立计算差异后使用，不能为了让实际执行通过而覆盖参考值。独立程序仅使用 Python 标准库和 Decimal，从期初与逐笔事实生成复式账、FIFO、工资税费、月度结转和直接法现金流；不导入产品引擎、不读取模型输出作参考答案。参考输出位于 `test/quarter-business-oracle.expected.json`。

业务完成后，在维护侧单独运行：

```powershell
python 06-workbench/test/quarter-business-oracle.py --check --actual "本次输出/账表数据.json" --comparison-output "本次输出/独立账表核对.json"
```

比较器检查完整月份、结转前后根科目净额、利润表、资产负债合计，并根据实际已过账凭证重放期末余额。现金流保留全部 22 行；第7至22行的各活动净额、投资及融资项目、现金期初期末与净增加保持硬核，设备付款误列货款必须失败。仅第1至6行经营明细中受购销增值税或代扣个税列示争议影响的分类差异单独输出，不将暂列值作为唯一金标。财政部小企留抵退税问答只处理留抵退税，不足以推定普通购销；企业准则的含税收付答复也不冒作小企直接依据。

不同的合法明细编码、凭证合并及内部税费结转方式不按张数判错；税费明细、原件字段到参数的语义及规则适用仍需人审。数字比较通过的退出码为零，但结果始终显示现金流分类待口径确认，不构成业务验收或可申报认证。运行和比较结果与当次调用记录放同一运行目录，不改写原始资料。

许可状态：新增内容未指定独立通用开源许可证；本目录不授权第三方原文再许可。法律链接仅为官方索引，未复制第三方财务数据。

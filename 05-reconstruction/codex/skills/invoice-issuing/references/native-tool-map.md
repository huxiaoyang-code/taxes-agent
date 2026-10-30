# 发票资料与实际工具

已有发票通过`finance_record_contract`取得对应采购、销售、退货或费用字段，再以`finance_workpaper`核账务；税费和抵扣由`finance_tax_calculate`及`finance_rules`核验。系统自动保存原件定位、整理输入和调用记录。

本机没有正式开票、红字开具/申请、在线采集、税局查验或自动税码选择。工具清单中的预留名称不表示已接入，不能调用占位接口报告成功。

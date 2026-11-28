// 本机发行的固定资源清单。宿主安装及 MCP 读取使用相同的文件集合，不扫描现场目录。
function packageFiles(groups) {
  return Object.freeze(Object.entries(groups).flatMap(([dir, names]) =>
    names.split(' ').map(name => dir + '/' + name)).sort());
}

export const PLUGIN_SKILL_FILES = packageFiles({
  'company-baseline': 'SKILL.md',
  'company-baseline/references': 'material-adaptation.md materials-and-save.md',
  'financial-statements': 'SKILL.md',
  'internal-control-review': 'SKILL.md',
  'internal-control-review/references': 'audit-support.md',
  'journal-entry': 'SKILL.md',
  'journal-entry/references': 'journal-entry-prep.md',
  'prebook-review': 'SKILL.md',
  'prebook-review/references': 'adapted-methods.md input-and-tools.md',
  'prebook-review/scripts': 'demo.mjs',
  'reconciliation': 'SKILL.md',
  'reconciliation/references': 'bank-workbench.md voucher-correction.md',
  'shared/references': 'business-memory.md calculation.md connectors.md control-testing-methods.md financial-controls.md journal-support.md quarter-review.md reconciliation-methods.md reporting.md variance-methods.md',
  'tax-period': 'SKILL.md',
  'tax-period/references': 'close-management.md planning-cash.md',
  'tax-review': 'SKILL.md',
  'tax-review/agents': 'tax-source-extract.md vat-data-review.md',
  'tax-review/examples': 'annual-handoff.md period-estimate.md',
  'tax-review/references': 'corporate-income.md official-policy.md planning-cash.md salary.md stamp.md summary-calculation.md supported-obligations.md tax-cash-brief.md tax-exceptions.md tax-organizer.md tax-sources.md vat-calculation.md vat-general.md vat-planning.md vat-small.md',
  'tax-review/templates': 'tax-handoff.md vat-comparison.md vat-decision.md',
  'variance-analysis': 'SKILL.md',
});

// 已保存的会计方法、旧会话和资源 URI 可指向迁移前的位置。
export const MOVED_SKILL_REFERENCES = Object.freeze({
  'audit-support/SKILL.md': 'internal-control-review/references/audit-support.md',
  'close-management/SKILL.md': 'tax-period/references/close-management.md',
  'journal-entry-prep/SKILL.md': 'journal-entry/references/journal-entry-prep.md',
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';
import {toolsForProfile} from '../../05-reconstruction/codex/mcp/finance-mcp/tool-profile.mjs';
import {validateSchemaValue} from '../server/harness-schema-validation.mjs';

const server = fileURLToPath(new URL('../../05-reconstruction/codex/mcp/finance-mcp/server.mjs', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'mcp-listed-contracts-'));
const target = {accountSetId: 1, period: '2026-03'};
const scope = {...target, enterpriseKey: 'SYNTHETIC', databaseInstanceId: 'synthetic-only', currency: 'CNY'};
const records = [{
  id: 'entity', type: 'entity', date: '2026-03-01', enterpriseKey: scope.enterpriseKey,
  originalRefs: [{originalId: 'source', locator: '/records/0', extractionReason: '合成企业记录'}],
  entity: {kind: 'company', industry: 'trade', profileId: 'small-2011-basic-v1',
    businessStartDate: '2026-03-01', vatStatus: 'general', vatPeriod: 'monthly', vatReliefWaived: false,
    incomeLevyMethod: 'actual_accounts', bookkeepingMethod: 'double_entry'}
}];
const path = join(root, 'original.json');
writeFileSync(path, JSON.stringify({records}));
const originals = [{id: 'source', path}];
const material = {scope, originals, records};
const {enterpriseKey, ...targetRecord} = records[0];
const targetMaterial = {target, originals, records: [targetRecord]};
const materials = {
  valid: [material, targetMaterial, {manifestPath: path}],
  invalid: [{...material, target}, {...material, records: [targetRecord]}, {manifestPath: path, records}]
};
const inspect = {action: 'inspect', ...target, voucherId: 1};
const apply = {
  ...inspect, action: 'apply', operationId: 'synthetic', expectedFingerprint: 'a'.repeat(64),
  voucher_date: '2026-03-01', summary: '合成验参', entries: [{code: '1002', debit: 1}, {code: '1122', credit: 1}],
  businessEvidence: {businessLabel: '合成凭证', method: '逐字段核对', mappings: [{
    inputPointer: '/voucher_date', parameterLabel: '日期', transform: 'identity', sources: [{path, jsonPointer: '/records/0/date'}]
  }]},
  proof: {kind: 'document', path, sha256: 'b'.repeat(64)}
};
const callIds = ['20260331T120000000Z_00000000-0000-4000-8000-000000000001'];
const summary = {target, originals, kind: 'cit_prepayment', inputs: {profitTotalYtd: 100}, bindings: []};
const cases = {
  voucher_correct: {
    valid: [inspect, apply],
    invalid: [{...inspect, operationId: 'unexpected'}, {...inspect, action: 'apply'}]
  },
  finance_period_review: {
    valid: [{target, callIds}, {unboundCalls: {callIds}}, {target, precedingPlanPeriod: '2026-02', beforeCallId: callIds[0]}],
    invalid: [{target, unboundCalls: {callIds}}, {target, callIds, limit: 1}, {target, beforeCallId: callIds[0]}]
  },
  finance_tax_summary_calculate: {
    valid: [summary, {...summary, kind: 'vat_general', inputs: {outputVat: 10}}],
    invalid: [{...summary, inputs: {outputVat: 10}}, {...summary, inputs: {quarterAverageEmployees: -1}}]
  },
  finance_rules: {
    valid: [{filters: {limit: 1}}, {action: 'search', query: '增值税', limit: 20}, {action: 'open', url: 'https://www.gov.cn/'}],
    invalid: [{action: 'search', query: '增值税', limit: 21}, {action: 'open', query: '增值税'}, {query: '增值税'}]
  },
  finance_workpaper: materials,
  finance_tax_calculate: {...materials, valid: [...materials.valid, {...material, obligationIds: ['vat']}]}
};

test('direct 工具列举满足宿主限制，并在 stdio 调用中执行原始分支约束', async t => {
  const client = new McpStdioClient(server, {cwd: root, env: {
    FINANCE_MCP_PROFILE: 'direct', FINANCE_API_BASE: 'http://127.0.0.1:9', FINANCE_DATABASE_PATH: '',
    FINANCE_BUSINESS_SESSION: '', FINANCE_AUDIT_MODE: '', FINANCE_AUDIT_DIR: join(root, 'audit'),
    WORKBENCH_DATA_DIR: join(root, 'data'), FINANCE_SOURCE_ROOT: root
  }}).start();
  t.after(() => client.close());
  await client.initialize('synthetic-host-contract');
  const published = (await client.rpc('tools/list')).result.tools;
  const canonical = toolsForProfile('direct');
  assert.deepEqual(published.map(tool => tool.name), canonical.map(tool => tool.name));
  const combinations = ['oneOf', 'anyOf', 'allOf'];
  for (const [index, {name, description, annotations, inputSchema}] of canonical.entries()) {
    const listed = published[index];
    assert.equal(listed.description, description, name);
    assert.deepEqual(listed.annotations, annotations, name);
    assert.ok(combinations.every(key => !Object.hasOwn(listed.inputSchema, key)), name);
    if (!cases[name]) {
      assert.deepEqual(listed.inputSchema, inputSchema, name);
      continue;
    }
    assert.deepEqual(listed.inputSchema.properties, inputSchema.properties, name);
    await t.test(name, async () => {
      for (const [expected, examples] of Object.entries(cases[name])) {
        for (const args of examples) {
          for (const schema of [inputSchema, listed.inputSchema]) {
            assert.equal(validateSchemaValue(schema, args).length === 0, expected === 'valid', JSON.stringify(args));
          }
          if (expected === 'invalid') {
            const result = await client.call(name, args);
            assert.equal(result.isError, true, result.text);
            assert.match(result.text, /invalid_arguments|finance_input_invalid/);
          }
        }
      }
    });
  }
  assert.ok(Object.keys(cases).every(name => published.some(tool => tool.name === name)));
  for (const name of ['finance_workpaper', 'finance_tax_calculate']) {
    const args = name === 'finance_workpaper' ? material : {...material, obligationIds: ['vat']};
    const result = await client.call(name, args);
    assert.equal(result.isError, false, result.text);
    assert.equal(result.structured.resultOrigin, 'native_engine');
  }
});

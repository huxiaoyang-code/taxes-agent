import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {McpStdioClient} from '../../05-reconstruction/codex/mcp/finance-mcp/mcp-stdio-client.mjs';
import {createSyntheticFixture, startBackend, REPO_ROOT} from './helpers/business-memory-e2e-fixture.mjs';
import {readFinanceCall} from '../server/finance-call-chain.mjs';

test('新工作区的已过账凭证查询只推荐一个节点，旧名沿用原账套和回执', async t => {
  const fixture = createSyntheticFixture();
  const session = join(fixture.root, 'session.json');
  writeFileSync(session, JSON.stringify({version:'finance-business-session/1', databasePath:fixture.dbPath, scope:fixture.scopeA}));
  const {child, apiBase} = await startBackend(fixture);
  t.after(() => child.kill());
  const alias = 'voucher.generated.summary';
  const primary = 'voucher.generated.list';
  async function connect(profile, discovery) {
    const client = new McpStdioClient(join(REPO_ROOT, '05-reconstruction/codex/mcp/finance-mcp/server.mjs'), {
      cwd:fixture.root, env:{
        FINANCE_MCP_PROFILE:profile, FINANCE_QUERY_DISCOVERY:discovery, FINANCE_SKILLS_DIR:undefined,
        FINANCE_BUSINESS_SESSION:session, FINANCE_API_BASE:apiBase, FINANCE_DATABASE_PATH:fixture.dbPath,
        FINANCE_SOURCE_ROOT:fixture.sourceA, FINANCE_AUDIT_DIR:fixture.auditA, FINANCE_AUDIT_MODE:undefined,
      },
    }).start();
    t.after(() => client.close());
    await client.initialize();
    return client;
  }
  const legacy = await connect('legacy', 'canonical');
  const oldDirect = await connect('direct', undefined);
  const oldCatalog = await oldDirect.call('finance_query_catalog');
  assert.equal(oldCatalog.isError, false, oldCatalog.text);
  assert.deepEqual((await legacy.call('finance_query_catalog')).data, oldCatalog.data);
  assert.equal(oldCatalog.data.projection.availableCount, 12);
  assert(oldCatalog.data.catalog.available.includes(alias));

  const client = await connect('direct', 'canonical');
  const {result: catalogCall} = await client.rpc('tools/call', {name:'finance_query_catalog', arguments:{}});
  const catalog = catalogCall.structuredContent;
  assert.deepEqual(catalog, JSON.parse(catalogCall.content[0].text));
  assert.deepEqual(catalog.catalog, {
    ...oldCatalog.data.catalog, available:oldCatalog.data.catalog.available.filter(id => id !== alias),
  });
  assert.deepEqual(catalog.projection, {availableCount:11, unimplementedCount:11, localExtensionCount:2, staticCatalog:true});
  const record = call => readFinanceCall({auditDir:fixture.auditA, callId:call._meta.financeCall.callId});
  assert.deepEqual((await record(catalogCall)).output, catalog);
  const args = {accountSetId:fixture.a, period:'2026-09'};
  const current = await client.call('finance_query', {...args, nodeId:primary});
  assert.equal(current.isError, false, current.text);
  assert.equal(current.data.projection.postedCount, 1);
  assert.equal(current.data.projection.totalDebit, 4500);
  const {result: oldCall} = await client.rpc('tools/call', {name:'finance_query', arguments:{...args, nodeId:alias}});
  const receipt = oldCall.structuredContent;
  assert.equal(receipt.ok, true);
  assert.equal(receipt.accountSetId, fixture.a);
  assert.equal(receipt.nodeId, alias);
  assert.equal(receipt.operation, 'finance_query:' + alias);
  assert.deepEqual(receipt.projection, current.data.projection);
  const history = await record(oldCall);
  assert.equal(history.input.nodeId, alias);
  assert.deepEqual(history.output, receipt);
  assert.equal(history.integrity, 'verified');
  const denied = await client.call('finance_query', {...args, accountSetId:fixture.b, nodeId:alias});
  assert.equal(denied.isError, true);
  assert.match(denied.text, /finance_memory_session_conflict/);
});

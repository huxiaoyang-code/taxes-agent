// 仅使用合成 CDP、身份响应及存储。不使用真实配置目录/缓存/网络。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeTaxNavigation } from '../scripts/observe-tax-navigation.mjs';
import { pageReference } from '../scripts/inventory-tax-browser.mjs';

const ORIGIN = 'https://etax.fujian.chinatax.gov.cn:8443', PRIVATE = 'SENTINEL_SYNTHETIC_NAVIGATION';
const registrationRef = 'taxr_' + '1'.repeat(48), targetId = PRIVATE + '_TARGET';
async function scenario(mode = 'normal', prepareOnly = false) {
  const handlers = new Map(), calls = [], saved = [];
  let reads = 0, registrations = 0, released = 0, retained = 0, closeEnded = false;
  const emit = (name, value = {}, session = 'synthetic-session') => handlers.get(name)?.(value, { sessionId: session });
  const frame = { id: PRIVATE + '_FRAME', loaderId: PRIVATE + '_LOADER', url: ORIGIN + '/loginb/' };
  const identity = { Response: { Data: { userinfo: { reg_number: PRIVATE + '_REG', company_name: PRIVATE + '_COMPANY',
    creditCode: PRIVATE + '_CREDIT', taxpayer_id: PRIVATE + '_TAX' } } } };
  const passiveIdentity = structuredClone(identity);
  if (mode === 'passive_missing_credit') delete passiveIdentity.Response.Data.userinfo.creditCode;
  const filing = { Response: { Data: { wsbxxGrid: [], dbt: 'synthetic', tbsl: 0 } } };
  const result = await observeTaxNavigation({ registrationRef, pageRef: pageReference(registrationRef, targetId), destination: 'portal_home',
    persistSource: !prepareOnly, readerStoppedConfirmed: true, prepareOnly }, {
    acquireLock: async () => ({ async release() {
      calls.push('lock_release');assert.equal(closeEnded, true);assert.equal(handlers.size, 0);
      if (mode === 'release_failure') throw Error(PRIVATE);released++;
    }, retain() { calls.push('lock_retain');retained++; } }),
    store: { async save(kind, value) { calls.push('store_save');assert.equal(kind, 'source');assert.equal(released, 1);assert.equal(closeEnded, true);saved.push(value);return 'taxsource_' + '2'.repeat(48); } },
    wait: async () => {
      if (mode === 'scope_reversal') { emit('Page.navigatedWithinDocument', { frameId: frame.id });emit('Page.navigatedWithinDocument', { frameId: frame.id }); }
      if (mode === 'connection_lost') emit('closed', {}, undefined);
      if (mode === 'session_lost') emit('Target.detachedFromTarget', { sessionId: 'synthetic-session' });
    },
    openDiagnostic: async () => ({ localScope: { registrationState: 'quarantined', browserKey: 'a'.repeat(64),
      async currentRegistrationState() { registrations++;return mode === 'registration_cleanup' && registrations >= 3 ? 'active' : 'quarantined'; } },
      async close() {
        calls.push('close_start');await new Promise(done => setImmediate(done));
        if (mode === 'close_failure') throw Error(PRIVATE);
        closeEnded = true;calls.push('close_done');
      },
      cdp: {
        on(name, handler) { handlers.set(name, handler);return () => { calls.push('off:' + name);if (mode === 'off_failure' && name === 'Page.frameNavigated') throw Error(PRIVATE);handlers.delete(name); }; },
        async send(method, params) {
          calls.push(method);
          if (method.endsWith('.disable')) { emit('Runtime.executionContextsCleared');throw Error('must not disable domains'); }
          if (method === 'Target.getTargets') return { targetInfos: [{ type: 'page', targetId, url: ORIGIN + '/loginb/' }] };
          if (method === 'Target.attachToTarget') {
            if (mode === 'attach_unknown') throw Error(PRIVATE);
            if (mode === 'attach_invalid') return {};
            return { sessionId: 'synthetic-session' };
          }
          if (method === 'Page.navigate') {
            assert.equal(params.url, ORIGIN + '/loginb/');
            if (mode !== 'no_context_clear') emit('Runtime.executionContextsCleared');
            emit('Page.frameNavigated', { frame: { ...frame } });
            for (const [requestId, path, method, postData, timestamp] of [
              ['identity', '/mhzx/api/mh/mhsy/getUserInfo', 'GET', undefined, 1],
              ['filing', '/mhzx/api/mh/wddb/v1/wddbquerybbsmxx', 'POST', JSON.stringify({ Csbz: '' }), 2],
            ]) {
              emit('Network.requestWillBeSent', { requestId, frameId: frame.id, loaderId: frame.loaderId, timestamp, type: 'XHR', request: { url: ORIGIN + path, method, postData } });
              emit('Network.responseReceived', { requestId, response: { status: 200 } });emit('Network.loadingFinished', { requestId, encodedDataLength: 256 });
            }
            return { frameId: frame.id, loaderId: frame.loaderId };
          }
          if (method === 'Network.getResponseBody') return { body: JSON.stringify(params.requestId === 'identity' ? passiveIdentity : filing) };
          if (method === 'Page.getFrameTree') {
            reads++;
            if (reads === 4 && mode === 'cleanup_frame_change') frame.urlFragment = '#SENTINEL_CHANGED';
            if (reads === 4 && mode === 'cleanup_frame_unavailable') throw Error(PRIVATE);
            if (reads === 4 && mode === 'cleanup_subframe') frame.parentId = '';
            return { frameTree: { frame: { ...frame } } };
          }
          if (method === 'Runtime.evaluate') {
            const requestRef = params.expression.match(/taxreq_[a-f0-9]{48}/)?.[0];assert.ok(requestRef);
            if (mode === 'identity_unknown') return { result: { value: { status: 'request_unconfirmed', settled: false } } };
            if (mode === 'identity_mismatched_reply') return { result: { value: { status: 'observed', settled: true, requestRef: 'wrong' } } };
            const body = structuredClone(identity);
            if (mode === 'credit_changed') body.Response.Data.userinfo.creditCode += '_CHANGED';
            if (mode === 'taxpayer_changed') body.Response.Data.userinfo.taxpayer_id += '_CHANGED';
            return { result: { value: { status: 'observed', settled: true, requestPerformed: true, responseComplete: true, requestRef, body } } };
          }
          if (method === 'Target.detachFromTarget') {
            if (mode === 'detach_failure') throw Error(PRIVATE);
            if (mode === 'scope_during_detach') emit('Page.navigatedWithinDocument', { frameId: frame.id });
            emit('Target.detachedFromTarget', { sessionId: 'synthetic-session' });return {};
          }
          if (['Network.enable', 'Page.enable', 'Runtime.enable'].includes(method)) return {};
          throw Error('unexpected synthetic CDP method');
        },
      },
    }),
  });
  assert.doesNotMatch(JSON.stringify(result), /SENTINEL|https?:|targetId|frameId|loaderId|browserKey/);
  assert.ok(!calls.some(c => c.endsWith('.disable')));
  return { result, calls, saved, released, retained, reads };
}

test('final scope guard, owned detach, listener removal and awaited close precede CAS release/source publication', async () => {
  const { result, calls, saved, released } = await scenario();
  assert.equal(result.status, 'observed');assert.equal(result.cleanupConfirmed, true);assert.equal(result.lockRetained, false);
  assert.equal(result.activeVerificationRequestCount, 1);assert.equal(released, 1);assert.equal(saved.length, 1);
  assert.equal(calls.filter(c => c === 'Runtime.evaluate').length, 1);
  assert.ok(calls.lastIndexOf('Page.getFrameTree') < calls.indexOf('Target.detachFromTarget'));
  assert.ok(calls.indexOf('Target.detachFromTarget') < calls.findIndex(c => c.startsWith('off:')));
  assert.ok(calls.findLastIndex(c => c.startsWith('off:')) < calls.indexOf('close_start'));
  assert.ok(calls.indexOf('close_done') < calls.indexOf('lock_release'));
  assert.ok(calls.indexOf('lock_release') < calls.indexOf('store_save'));
});

for (const mode of ['attach_unknown', 'attach_invalid', 'identity_unknown', 'identity_mismatched_reply', 'credit_changed', 'taxpayer_changed', 'connection_lost', 'session_lost',
  'scope_reversal', 'no_context_clear', 'cleanup_frame_change', 'cleanup_frame_unavailable', 'cleanup_subframe', 'registration_cleanup',
  'scope_during_detach', 'detach_failure', 'off_failure', 'close_failure', 'release_failure']) {
  test(mode + ' retains exclusion and cannot publish a source', async () => {
    const { result, released, retained, saved, calls } = await scenario(mode);
    assert.equal(result.status, 'observation_failed');assert.equal(result.cleanupConfirmed, false);
    assert.equal(result.lockRetained, true);assert.equal(released, 0);assert.equal(retained, 1);assert.equal(saved.length, 0);
    assert.equal(Object.hasOwn(result, 'sourceRef'), false);assert.ok(calls.includes('close_start'));
  });
}

test('prepare-only still closes/detaches safely without navigation or identity requests', async () => {
  const { result, calls, released, saved } = await scenario('normal', true);
  assert.equal(result.status, 'prepared');assert.equal(result.cleanupConfirmed, true);assert.equal(released, 1);assert.equal(saved.length, 0);
  assert.ok(!calls.includes('Page.navigate'));assert.ok(!calls.includes('Runtime.evaluate'));
});

test('two-field passive identity cannot be promoted to a four-field verified source', async () => {
  const { result, calls, saved } = await scenario('passive_missing_credit');
  assert.equal(result.status, 'observation_failed');assert.equal(result.phase, 'source_projection');
  assert.equal(saved.length, 0);assert.ok(!calls.includes('Runtime.evaluate'));
  assert.equal(Object.hasOwn(result, 'sourceRef'), false);
});

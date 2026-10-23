// Data-only aux-import/v1 appendix. No database is opened or migrated here.
import { assertAuxiliaryReady, auxError, auxFingerprint } from './auxiliary-storage.mjs';
import { createAuxiliaryEntity, replaceAuxiliaryAllocations } from './auxiliary-accounting.mjs';
import { persistedVoucherFingerprint } from './import-storage.mjs';
import { getAccountingProfile } from './accounting-profiles.mjs';
import { assertPeriodMutable } from './period-end-controls.mjs';
import { parseMoney, storedCents } from './money.mjs';
import { types } from 'node:util';

const protocol = 'aux-import/v1';
const dims = ['project', 'department', 'party'];
const fail = (bad, code = 'aux_import_invalid') => { if (bad) throw auxError(code); };
const json = value => JSON.stringify(value);
const equal = (a, b) => json(a) === json(b);
const key = (kind, value) => `aux-import:${kind}:${auxFingerprint(value)}`;
function object(value, allowed) {
  fail(!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value)));
  for (const k of Reflect.ownKeys(value)) {
    fail(typeof k !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(k) || !allowed.includes(k));
    const descriptor = Object.getOwnPropertyDescriptor(value, k);
    fail(!descriptor || !('value' in descriptor));
  }
}
function text(value, max = 200) {
  fail(typeof value !== 'string' || !value.trim() || value !== value.trim()
    || value.length > max || /[\x00-\x1f\x7f]/.test(value));
  return value;
}
function id(value) { fail(!Number.isSafeInteger(value) || value < 1); return value; }
function array(value, max) {
  fail(types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max);
  fail(Reflect.ownKeys(value).length !== value.length + 1);
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    fail(!descriptor || !('value' in descriptor));
  }
  return value;
}
function unique(items, select) {
  const seen = new Set();
  for (const item of items) { const k = select(item); fail(seen.has(k), 'aux_import_identity_duplicate'); seen.add(k); }
}
function amount(value) {
  fail(value !== undefined && !['number', 'string'].includes(typeof value));
  const parsed = parseMoney(value);
  fail(!parsed.ok || parsed.subCent || parsed.cents < 0n, 'aux_amount_invalid');
  return Number(parsed.cents);
}
function allocations(value, entities) {
  const result = array(value, 1000).map(item => {
    object(item, ['projectRef', 'departmentRef', 'partyRef', 'debit', 'credit']);
    const part = {};
    for (const dim of dims) {
      const ref = item[dim + 'Ref'];
      if (ref !== undefined) { text(ref); fail(entities.get(ref)?.kind !== dim, 'aux_import_ref_invalid'); }
      part[dim + 'Ref'] = ref ?? null;
    }
    fail(dims.every(d => part[d + 'Ref'] === null), 'aux_dimension_required');
    part.debitCents = amount(item.debit); part.creditCents = amount(item.credit);
    fail((part.debitCents > 0) === (part.creditCents > 0), 'aux_side_invalid');
    return part;
  }).sort((a, b) => json(a).localeCompare(json(b)));
  unique(result, p => json(dims.map(d => p[d + 'Ref'])));
  return result;
}

/** Strict shape validation is performed before any core business write. */
export function parseAuxiliaryAppendix(raw) {
  if (raw === undefined) return null;
  object(raw, ['version', 'requestId', 'reason', 'entities', 'entries', 'openings']);
  fail(raw.version !== 1, 'aux_import_version_invalid');
  const entities = array(raw.entities, 1000).map(item => {
    object(item, ['ref', 'kind', 'code', 'name', 'existingId']);
    fail(!dims.includes(item.kind), 'aux_kind_invalid');
    return { ref: text(item.ref), kind: item.kind, code: text(item.code), name: text(item.name),
      ...(item.existingId === undefined ? {} : { existingId: id(item.existingId) }) };
  }).sort((a, b) => a.ref.localeCompare(b.ref));
  unique(entities, e => e.ref); unique(entities, e => json([e.kind, e.code]));
  const refs = new Map(entities.map(e => [e.ref, e]));
  const entries = array(raw.entries, 10000).map(item => {
    object(item, ['sourceVoucherId', 'sourceEntryId', 'actualEntryId', 'allocations']);
    const sourceVoucherId = text(item.sourceVoucherId), sourceEntryId = text(item.sourceEntryId);
    fail(sourceVoucherId.startsWith('derived:') || sourceEntryId.startsWith('derived:'), 'aux_import_explicit_identity_required');
    return { sourceVoucherId, sourceEntryId,
      ...(item.actualEntryId === undefined ? {} : { actualEntryId: id(item.actualEntryId) }),
      allocations: allocations(item.allocations, refs) };
  }).sort((a, b) => json([a.sourceVoucherId, a.sourceEntryId]).localeCompare(json([b.sourceVoucherId, b.sourceEntryId])));
  unique(entries, e => json([e.sourceVoucherId, e.sourceEntryId]));
  const openings = array(raw.openings, 1000).map(item => {
    object(item, ['openingCode', 'allocations']);
    return { openingCode: text(item.openingCode), allocations: allocations(item.allocations, refs) };
  }).sort((a, b) => a.openingCode.localeCompare(b.openingCode));
  unique(openings, e => e.openingCode);
  return { version: 1, requestId: text(raw.requestId), reason: text(raw.reason), entities, entries, openings };
}

function receipt(db, setId, requestId, target) {
  if (setId == null) return null;
  const saved = db.prepare('SELECT * FROM aux_receipts WHERE account_set_id=? AND request_id=?').get(setId, requestId);
  if (!saved) return null;
  fail(saved.version !== 1 || saved.target_json !== json(target), 'aux_import_request_conflict');
  try { return { row: saved, result: JSON.parse(saved.result_json) }; }
  catch { throw auxError('aux_import_receipt_invalid'); }
}
function writeReceipt(db, setId, requestId, target, result) {
  db.prepare('INSERT INTO aux_receipts VALUES(?,?,1,?,?,?,?)')
    .run(setId, requestId, auxFingerprint({ target, result }), json(target), json(result), new Date().toISOString());
}
function checkedReceipt(db, setId, requestId, target) {
  const saved = receipt(db, setId, requestId, target);
  if (saved) fail(saved.row.fingerprint !== auxFingerprint({ target, result: saved.result }), 'aux_import_receipt_invalid');
  return saved;
}
function entryRows(db, voucherId) {
  return db.prepare('SELECT id,voucher_id,line_no,code,summary,debit,credit FROM voucher_entries WHERE voucher_id=? ORDER BY line_no,id').all(voucherId);
}
function evidence(db, ctx, item) {
  const source = db.prepare('SELECT * FROM import_voucher_sources WHERE source_system=? AND enterprise_key=? AND source_voucher_id=?')
    .get(ctx.source.system, ctx.source.enterpriseKey, item.sourceVoucherId);
  fail(!source || source.account_set_id !== ctx.accountSetId || source.content_fingerprint !== item.fingerprint, 'aux_import_source_conflict');
  const voucher = db.prepare('SELECT * FROM vouchers WHERE id=?').get(source.voucher_id);
  fail(!voucher || voucher.account_set_id !== ctx.accountSetId || voucher.status !== 'posted' || voucher.kind !== 'normal', 'aux_import_source_conflict');
  const rows = entryRows(db, voucher.id);
  fail(!source.voucher_fingerprint || persistedVoucherFingerprint(voucher, rows) !== source.voucher_fingerprint, 'aux_import_source_conflict');
  return { voucherId: voucher.id, contentFingerprint: source.content_fingerprint,
    voucherFingerprint: source.voucher_fingerprint, rows };
}
function mutable(db, setId, period) {
  if (setId == null) return;
  fail(db.prepare("SELECT 1 FROM periods WHERE account_set_id=? AND period=? AND status='closed'").get(setId, period), 'aux_period_closed');
  assertPeriodMutable(db, setId, period, { operation: 'auxiliary_import' });
}
function actualParts(parts, ids) {
  return parts.map(p => ({ ...Object.fromEntries(dims.map(d => [d + 'Id', p[d + 'Ref'] === null ? null : ids.get(p[d + 'Ref'])])),
    debit: p.debitCents / 100, credit: p.creditCents / 100 }));
}
function storedParts(db, setId, target) {
  const rows = target.entryId !== undefined
    ? db.prepare('SELECT * FROM aux_allocations WHERE account_set_id=? AND entry_id=? ORDER BY id').all(setId, target.entryId)
    : db.prepare('SELECT * FROM aux_allocations WHERE account_set_id=? AND opening_code=? ORDER BY id').all(setId, target.openingCode);
  return rows.map(r => ({ projectId: r.project_id, departmentId: r.department_id, partyId: r.party_id,
    debitCents: r.debit_cents, creditCents: r.credit_cents })).sort((a, b) => json(a).localeCompare(json(b)));
}
function expectedParts(parts, ids) {
  return parts.map(p => ({ ...Object.fromEntries(dims.map(d => [d + 'Id', p[d + 'Ref'] === null ? null : ids.get(p[d + 'Ref'])])),
    debitCents: p.debitCents, creditCents: p.creditCents })).sort((a, b) => json(a).localeCompare(json(b)));
}

/** Read-only preflight; apply must run on the same connection in the core transaction. */
export function processAuxiliaryAppendix(db, appendix, ctx, { apply = false } = {}) {
  assertAuxiliaryReady(db);
  fail(apply && !db.isTransaction, 'aux_import_transaction_required');
  const set = ctx.accountSetId == null ? null : db.prepare('SELECT * FROM account_sets WHERE id=?').get(ctx.accountSetId);
  if (ctx.accountSetId != null) { fail(!set, 'account_set_not_found'); getAccountingProfile(set.accounting_profile_id); }
  const scope = { protocol, sourceSystem: ctx.source.system, enterpriseKey: ctx.source.enterpriseKey };
  const requestTarget = { ...scope, type: 'appendix', requestId: appendix.requestId, batchId: ctx.batchId,
    coreFingerprint: ctx.coreFingerprint, appendix };
  const requestKey = key('request', [scope, appendix.requestId]);
  const oldRequest = checkedReceipt(db, ctx.accountSetId, requestKey, requestTarget);
  const ids = new Map(), entityStates = [];
  for (const entity of appendix.entities) {
    const saved = oldRequest?.result.entities?.find(e => e.ref === entity.ref);
    let row = ctx.accountSetId == null ? null : db.prepare('SELECT * FROM aux_entities WHERE account_set_id=? AND kind=? AND code=?').get(ctx.accountSetId, entity.kind, entity.code);
    if (saved) fail(!row || !equal(row, saved.row), 'aux_import_replay_state_conflict');
    else if (entity.existingId !== undefined) {
      fail(!row || row.id !== entity.existingId || row.name !== entity.name || row.active !== 1, 'aux_import_entity_conflict');
    } else fail(!!row, 'aux_import_entity_conflict');
    if (!row && apply) {
      const entityTarget = { ...scope, type: 'entity', requestId: appendix.requestId, entity };
      const childKey = key('entity', entityTarget);
      fail(!!db.prepare('SELECT 1 FROM aux_receipts WHERE account_set_id=? AND request_id=?').get(ctx.accountSetId, childKey), 'aux_import_request_conflict');
      const made = createAuxiliaryEntity(db, { accountSetId: ctx.accountSetId, ...entity, requestId: childKey });
      row = db.prepare('SELECT * FROM aux_entities WHERE id=?').get(made.id);
    }
    // Negative placeholders are used only during the zero-write new-entity preview.
    ids.set(entity.ref, row?.id ?? -(ids.size + 1));
    entityStates.push({ ref: entity.ref, row });
  }
  const mappings = [], targets = [], usedActual = new Set();
  for (const assignment of appendix.entries) {
    const item = ctx.vouchers.find(v => v.sourceVoucherId === assignment.sourceVoucherId);
    fail(!item, 'aux_import_explicit_identity_required');
    const raw = ctx.payload.vouchers?.[item.index];
    fail(!raw || (raw.sourceVoucherId ?? raw.source_voucher_id) !== assignment.sourceVoucherId, 'aux_import_explicit_identity_required');
    const mapTarget = { ...scope, type: 'entry-map', sourceVoucherId: assignment.sourceVoucherId, sourceEntryId: assignment.sourceEntryId };
    const mapKey = key('map', mapTarget), saved = checkedReceipt(db, ctx.accountSetId, mapKey, mapTarget);
    let proof = null, actualEntryId = null, row;
    if (item.action === 'create' || ctx.createdVoucherIds?.has(item.sourceVoucherId)) {
      const rawEntries = raw.entries;
      fail(!Array.isArray(rawEntries) || rawEntries.length !== item.voucher.entries.length, 'aux_import_entry_identity_required');
      const sourceIds = rawEntries.map(e => text(e?.sourceEntryId));
      fail(sourceIds.some(s => s.startsWith('derived:')), 'aux_import_explicit_identity_required');
      unique(sourceIds, s => s);
      const index = sourceIds.indexOf(assignment.sourceEntryId);
      fail(index < 0, 'aux_import_entry_identity_required');
      if (apply) {
        proof = evidence(db, ctx, item);
        fail(proof.rows.length !== item.voucher.entries.length, 'aux_import_source_conflict');
        proof.rows.forEach((r, i) => {
          const normalized = item.voucher.entries[i];
          fail(r.line_no !== i + 1 || r.code !== normalized.code || r.summary !== normalized.summary
            || storedCents(r.debit) !== storedCents(normalized.debit) || storedCents(r.credit) !== storedCents(normalized.credit), 'aux_import_source_conflict');
        });
        row = proof.rows[index]; actualEntryId = row.id;
      } else row = item.voucher.entries[index];
      fail(saved !== null, 'aux_import_mapping_conflict');
    } else {
      proof = evidence(db, ctx, item);
      actualEntryId = saved?.result.entryId ?? assignment.actualEntryId;
      fail(!actualEntryId, 'aux_import_actual_entry_required');
      row = proof.rows.find(r => r.id === actualEntryId);
      fail(!row || (assignment.actualEntryId !== undefined && assignment.actualEntryId !== actualEntryId), 'aux_import_mapping_conflict');
      if (saved) fail(!equal(saved.result, { entryId: actualEntryId, proof }), 'aux_import_mapping_conflict');
    }
    if (actualEntryId !== null) {
      fail(usedActual.has(actualEntryId), 'aux_import_identity_duplicate'); usedActual.add(actualEntryId);
      if (assignment.actualEntryId !== undefined) fail(assignment.actualEntryId !== actualEntryId, 'aux_import_mapping_conflict');
      // A real row cannot acquire a second source-entry identity, even in another request.
      const historical = db.prepare("SELECT target_json,result_json FROM aux_receipts WHERE account_set_id=? AND request_id LIKE 'aux-import:map:%'").all(ctx.accountSetId);
      for (const h of historical) {
        let target, result; try { target = JSON.parse(h.target_json); result = JSON.parse(h.result_json); } catch { throw auxError('aux_import_receipt_invalid'); }
        fail(result.entryId === actualEntryId && !equal(target, mapTarget), 'aux_import_mapping_conflict');
      }
    }
    const debit = assignment.allocations.reduce((s, p) => s + BigInt(p.debitCents), 0n);
    const credit = assignment.allocations.reduce((s, p) => s + BigInt(p.creditCents), 0n);
    fail(debit > storedCents(row.debit) || credit > storedCents(row.credit), 'aux_allocation_exceeds_entry');
    mutable(db, ctx.accountSetId, item.voucher.period);
    const mapping = { mapKey, mapTarget, result: { entryId: actualEntryId, proof }, saved: !!saved };
    mappings.push(mapping);
    targets.push({ target: actualEntryId === null ? null : { entryId: actualEntryId }, parts: assignment.allocations,
      identity: mapTarget, proof: proof ?? row });
  }
  for (const assignment of appendix.openings) {
    const row = ctx.accountSetId == null ? ctx.normalized.opening_balances.find(o => o.code === assignment.openingCode)
      : db.prepare('SELECT * FROM opening_balances WHERE account_set_id=? AND code=?').get(ctx.accountSetId, assignment.openingCode)
        ?? ctx.normalized.opening_balances.find(o => o.code === assignment.openingCode);
    fail(!row, 'aux_opening_not_found'); mutable(db, ctx.accountSetId, set?.start_period ?? ctx.normalized.account_set.start_period);
    targets.push({ target: { openingCode: assignment.openingCode }, parts: assignment.allocations,
      identity: { ...scope, type: 'opening', openingCode: assignment.openingCode }, proof: row });
  }
  const targetStates = [];
  for (const item of targets) {
    const expected = expectedParts(item.parts, ids);
    const current = ctx.accountSetId != null && item.target ? storedParts(db, ctx.accountSetId, item.target) : [];
    if (oldRequest) {
      const saved = oldRequest.result.targets?.find(t => equal(t.identity, item.identity));
      fail(!saved || !equal(saved.target, item.target) || !equal(saved.proof, item.proof)
        || !equal(saved.parts, expected) || !equal(current, expected), 'aux_import_replay_state_conflict');
    } else {
      fail(current.length > 0, 'aux_import_allocation_exists');
      if (apply) {
        const childKey = key('allocate', { requestTarget, identity: item.identity });
        fail(!!db.prepare('SELECT 1 FROM aux_receipts WHERE account_set_id=? AND request_id=?').get(ctx.accountSetId, childKey), 'aux_import_request_conflict');
        replaceAuxiliaryAllocations(db, { accountSetId: ctx.accountSetId, ...item.target,
          allocations: actualParts(item.parts, ids), requestId: childKey, reason: appendix.reason });
      }
    }
    targetStates.push({ identity: item.identity, target: item.target, proof: item.proof, parts: expected });
  }
  if (oldRequest) fail(!equal(oldRequest.result.entities, entityStates)
    || !equal(oldRequest.result.targets, targetStates) || !equal(oldRequest.result.mappings, mappings.map(m => ({ target: m.mapTarget, ...m.result }))), 'aux_import_replay_state_conflict');
  if (apply && !oldRequest) {
    for (const m of mappings) if (!m.saved) writeReceipt(db, ctx.accountSetId, m.mapKey, m.mapTarget, m.result);
    const result = { protocol, entities: entityStates, targets: targetStates, mappings: mappings.map(m => ({ target: m.mapTarget, ...m.result })) };
    writeReceipt(db, ctx.accountSetId, requestKey, requestTarget, result);
    db.prepare('INSERT INTO aux_operations(account_set_id,request_id,action,reason,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(ctx.accountSetId, requestKey, 'auxiliary_import', appendix.reason, 'null', json(result), new Date().toISOString());
  }
  return { version: 1, status: oldRequest ? 'replayed' : apply ? 'staged' : 'preview',
    entityCount: entityStates.length, mappingCount: mappings.length, allocationTargetCount: targets.length };
}

// Independent decimal reference: never imports server, product money, or tax code.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const minor = value => {
  assert.match(value, /^-?\d+\.\d{2}$/);
  const negative = value.startsWith('-'), [whole, fraction] = value.replace('-', '').split('.');
  return (BigInt(whole) * 100n + BigInt(fraction)) * (negative ? -1n : 1n);
};
export const decimal = value => { const n = BigInt(value), a = n < 0n ? -n : n; return `${n < 0n ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`; };
export const actualDecimal = value => { assert.ok(Number.isFinite(value)); return value.toFixed(2); };
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const pairs = ['initialOpening', 'cumulativeMovements', 'monthlyMovements', 'closing'];
const literalVoucher = v => ({ date: v.date, expectedRuleId: v.rule?.id ?? v.expectedRuleId, entries: v.entries.map(e => ({ accountCode: e.accountCode, debit: e.debit, credit: e.credit })) });
const sorted = values => values.map(literalVoucher).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

export function auditFrozenExpected(expected) {
  assert.equal(expected.accountantStatus, 'pending');
  for (const voucher of expected.vouchers) {
    assert.equal(voucher.entries.reduce((n, e) => n + minor(e.debit) - minor(e.credit), 0n), 0n);
    if (voucher.expectedRuleId === 'small-service-sale/1') {
      assert.equal(minor(voucher.entries[1].credit) / 100n, minor(voucher.entries[2].credit));
      assert.equal(minor(voucher.entries[1].credit) + minor(voucher.entries[2].credit), minor(voucher.entries[0].debit));
    }
  }
  let previous;
  for (const trial of expected.monthlyUnclosedTrials) {
    for (const line of trial.lines) {
      const cum = [0n, 0n], monthly = [0n, 0n];
      for (const v of expected.vouchers) for (const e of v.entries.filter(e => e.accountCode === line.code)) {
        if (v.date.slice(0, 7) <= trial.month) { cum[0] += minor(e.debit); cum[1] += minor(e.credit); }
        if (v.date.slice(0, 7) === trial.month) { monthly[0] += minor(e.debit); monthly[1] += minor(e.credit); }
      }
      assert.deepEqual(line.cumulativeMovements.map(minor), cum);
      assert.deepEqual(line.monthlyMovements.map(minor), monthly);
      const net = minor(line.initialOpening[0]) - minor(line.initialOpening[1]) + cum[0] - cum[1];
      assert.deepEqual(line.closing.map(minor), [net > 0n ? net : 0n, net < 0n ? -net : 0n]);
    }
    for (const pair of pairs) for (const i of [0, 1]) assert.equal(trial.lines.reduce((n, l) => n + minor(l[pair][i]), 0n), minor(trial.totals[pair][i]));
    for (const pair of pairs) assert.equal(trial.totals[pair][0], trial.totals[pair][1]);
    previous = trial;
  }
  assert.ok(previous);
  const cell = row => expected.vat.cells.find(c => c.row === row && c.period === 'current');
  if (expected.vat.calculationReady) {
    const base = minor(cell(1).value);
    assert.equal(minor(cell(15).value), base * 3n / 100n);
    assert.equal(minor(cell(16).value), base * 2n / 100n);
    assert.equal(minor(cell(22).value), base / 100n);
  }
}

export function assertGoldenOutput(actual, expected, rawDirectory) {
  auditFrozenExpected(expected);
  assert.deepEqual(sorted(actual.candidates), sorted(expected.vouchers));
  for (const ref of expected.sourceRefs) assert.equal(sha256(readFileSync(join(rawDirectory, ref.path))), ref.sha256);
  let previous;
  for (const exp of expected.monthlyUnclosedTrials) {
    const trial = actual.trials.find(t => t.period === exp.month);
    const movements = ['period_debit', 'period_credit'];
    for (const line of trial.lines) {
      const frozen = exp.lines.find(e => e.code === line.code);
      if (!frozen) { for (const name of ['opening_debit','opening_credit',...movements,'closing_debit','closing_credit']) assert.equal(line[name], 0); continue; }
      for (const [pair, keys] of [['initialOpening',['opening_debit','opening_credit']],['cumulativeMovements',movements],['closing',['closing_debit','closing_credit']]]) assert.deepEqual(keys.map(k => actualDecimal(line[k])), frozen[pair], `${expected.id}/${exp.month}/${line.code}/${pair}`);
      const old = previous?.lines.find(e => e.code === line.code);
      assert.deepEqual(movements.map(k => decimal(minor(actualDecimal(line[k])) - minor(actualDecimal(old?.[k] ?? 0)))), frozen.monthlyMovements);
    }
    for (const [pair, keys] of [['initialOpening',['opening_debit','opening_credit']],['cumulativeMovements',movements],['closing',['closing_debit','closing_credit']]]) assert.deepEqual(keys.map(k => actualDecimal(trial.totals[k])), exp.totals[pair]);
    previous = trial;
  }
  assert.equal(actual.snapshot.counts.draft, 0);
  assert.equal(actual.snapshot.vouchers.length, expected.vouchers.length);
  assert.ok(actual.snapshot.sources.checks.every(c => c.status === 'matches_persisted_content'));
  for (const candidate of actual.candidates) {
    const exp = expected.vouchers.find(e => JSON.stringify(literalVoucher(e)) === JSON.stringify(literalVoucher(candidate)));
    assert.ok(exp);
    assert.ok(candidate.evidence.businessFacts.some(f => f.fileSha256 === exp.accountingFactRef.sha256 && f.pointer === exp.accountingFactRef.pointer));
    for (const ref of exp.sourceRefs) {
      const actualRef = candidate.evidence.materials.find(r => r.sourceId === ref.sourceId && r.fileSha256 === ref.fileSha256);
      assert.ok(actualRef, 'every frozen duplicate/source is traceable');
      assert.equal(actualRef.location.row, ref.row);
      const record = actual.materialRecords.find(r => r.docId === actualRef.docId && r.sourceId === ref.sourceId);
      assert.ok(record);
      if (candidate.kind === 'service_prepayment') assert.deepEqual({ bankAccountId: record.data.bankAccountId, refId: record.data.refId }, exp.identity);
      else assert.deepEqual({ sellerKey: record.data.sellerKey, code: record.data.code, number: record.data.number }, exp.identity);
    }
    const persisted = actual.snapshot.sources.voucherSources.find(s => s.source_voucher_id === candidate.businessKey);
    assert.ok(persisted, 'actual source business key association');
    const voucher = actual.snapshot.vouchers.find(v => v.id === persisted.voucher_id);
    assert.ok(voucher); assert.equal(voucher.status, 'posted'); assert.equal(voucher.voucher_date, candidate.date);
    assert.equal(voucher.entries.length, candidate.entries.length);
    candidate.entries.forEach((entry, i) => {
      const stored = voucher.entries[i]; assert.ok(Number.isInteger(stored.id)); assert.equal(stored.code, entry.accountCode);
      assert.equal(actualDecimal(stored.debit), entry.debit); assert.equal(actualDecimal(stored.credit), entry.credit);
      assert.equal(entry.ruleId, exp.expectedRuleId); assert.ok(entry.ruleSources.every(s => s.url && s.locator));
      for (const ref of entry.sourceFields) {
        const frozen = exp.sourceRefs.find(s => s.sourceId === ref.sourceId); assert.ok(frozen); assert.equal(ref.fileSha256, frozen.fileSha256);
        assert.equal(ref.location.column, frozen.fields[ref.field].column);
        const material = candidate.evidence.materials.find(s => s.sourceId === ref.sourceId); assert.equal(material.location.row, frozen.row);
        if (frozen.sheet) { assert.equal(material.location.sheet, frozen.sheet); assert.equal(ref.location.cell, frozen.fields[ref.field].cell); }
        else { assert.equal(material.location.line, frozen.line); assert.ok(Number.isInteger(ref.location.column)); }
      }
    });
    if (candidate.kind === 'administrative_service') assert.ok(candidate.recognition.dateSource.references.every(r => r.pointer.endsWith('/completionDate') && /^[a-f0-9]{64}$/.test(r.fileSha256)));
  }
  const vat = actual.vat;
  assert.equal(vat.status, expected.vat.status); assert.equal(vat.calculationReady, expected.vat.calculationReady);
  assert.equal(vat.accountantApproval, 'pending'); assert.equal(vat.periodComplete, false); assert.equal(vat.submittable, false); assert.equal(vat.authorizesExecution, false);
  for (const exp of expected.vat.cells) {
    const cell = vat.cells.find(c => c.row === exp.row && c.period === exp.period && c.column === exp.column);
    assert.equal(cell.status, exp.status); assert.equal(cell.value, exp.value);
    assert.equal(vat.ruleVersion, exp.expectedRuleId); assert.equal(cell.ruleReferences.formula, exp.formula); assert.deepEqual(cell.ruleReferences.sources, exp.sources);
  }
  for (const cell of vat.cells) if (cell.column === 'goods' || !expected.vat.selectedFields.includes(cell.row)) assert.equal(cell.value, null);
  for (const issue of expected.vat.requiredIssues) assert.ok(vat.issues.some(i => i.code === issue), issue);
  for (const [key, url] of Object.entries(expected.vat.ruleSources)) assert.equal(vat.rules.sources[key].url, url);
  for (const sale of vat.sales) {
    assert.ok(sale.entries.every(e => Number.isInteger(e.entryId) && e.candidateSources.sourceFields.length));
    assert.equal(sale.sourceCheck.status, 'matches_persisted_content');
    const candidate = actual.candidates.find(c => c.businessKey === sale.businessKey);
    assert.equal(BigInt(sale.initialLedgerVatMinor), minor(candidate.entries[2].credit));
  }
}

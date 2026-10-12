// accounting.mjs — 复式记账领域逻辑 + 报表
import { db } from "./db.mjs";
import { COA } from "./coa.mjs";

const now = () => new Date().toISOString();
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const EPS = 0.005;

const row = (sql, ...args) => db.prepare(sql).get(...args);
const rows = (sql, ...args) => db.prepare(sql).all(...args);
const run = (sql, ...args) => db.prepare(sql).run(...args);

// ---------------------------------------------------------------- 账套
export function createAccountSet({ name, taxpayer_type, accounting_standard, start_period }) {
  if (!name) throw new Error("name_required");
  if (!/^\d{4}-\d{2}$/.test(String(start_period || ""))) throw new Error("start_period_invalid");
  const info = run(
    `INSERT INTO account_sets (name, taxpayer_type, accounting_standard, start_period, created_at)
     VALUES (?,?,?,?,?)`,
    name,
    taxpayer_type || "小规模纳税人",
    accounting_standard || "小企业会计准则",
    start_period,
    now()
  );
  const id = Number(info.lastInsertRowid);
  const insAcc = db.prepare(
    `INSERT INTO accounts (account_set_id, code, name, category, direction, contra, is_leaf)
     VALUES (?,?,?,?,?,?,1)`
  );
  for (const a of COA) insAcc.run(id, a.code, a.name, a.category, a.direction, a.contra ? 1 : 0);
  ensurePeriod(id, start_period);
  return getAccountSet(id);
}

export function listAccountSets() {
  return rows(`SELECT * FROM account_sets ORDER BY id DESC`);
}
export function getAccountSet(id) {
  const s = row(`SELECT * FROM account_sets WHERE id=?`, id);
  if (!s) throw new Error("account_set_not_found");
  return s;
}
export function deleteAccountSet(id) {
  run(`DELETE FROM account_sets WHERE id=?`, id);
}

// ---------------------------------------------------------------- 科目
export function listAccounts(setId) {
  getAccountSet(setId);
  return rows(`SELECT * FROM accounts WHERE account_set_id=? ORDER BY code`, setId);
}
export function addAccount(setId, { code, name, category, direction, parent_code = null }) {
  getAccountSet(setId);
  if (!code || !name) throw new Error("code_and_name_required");
  if (!["debit", "credit"].includes(direction)) throw new Error("direction_invalid");
  if (!["资产", "负债", "权益", "成本", "损益"].includes(category)) throw new Error("category_invalid");
  run(
    `INSERT INTO accounts (account_set_id, code, name, category, direction, contra, is_leaf)
     VALUES (?,?,?,?,?,0,1)`,
    setId, String(code), name, category, direction
  );
  return listAccounts(setId);
}

// ---------------------------------------------------------------- 期初
export function setOpeningBalances(setId, items = []) {
  getAccountSet(setId);
  const del = db.prepare(`DELETE FROM opening_balances WHERE account_set_id=? AND code=?`);
  const ins = db.prepare(
    `INSERT INTO opening_balances (account_set_id, code, debit, credit) VALUES (?,?,?,?)`
  );
  for (const it of items) {
    const code = String(it.code);
    const acc = row(`SELECT * FROM accounts WHERE account_set_id=? AND code=?`, setId, code);
    if (!acc) throw new Error(`account_not_found:${code}`);
    del.run(setId, code);
    ins.run(setId, code, r2(it.debit), r2(it.credit));
  }
  return getOpeningBalances(setId);
}
export function getOpeningBalances(setId) {
  getAccountSet(setId);
  return rows(`SELECT code, debit, credit FROM opening_balances WHERE account_set_id=? ORDER BY code`, setId);
}

// ---------------------------------------------------------------- 期间
export function listPeriods(setId) {
  getAccountSet(setId);
  return rows(`SELECT period, status FROM periods WHERE account_set_id=? ORDER BY period`, setId);
}
export function ensurePeriod(setId, period) {
  if (!/^\d{4}-\d{2}$/.test(String(period || ""))) throw new Error("period_invalid");
  run(`INSERT OR IGNORE INTO periods (account_set_id, period, status) VALUES (?,?,'open')`, setId, period);
  return row(`SELECT period, status FROM periods WHERE account_set_id=? AND period=?`, setId, period);
}
export function setPeriodStatus(setId, period, status) {
  if (!["open", "closed"].includes(status)) throw new Error("status_invalid");
  const p = row(`SELECT * FROM periods WHERE account_set_id=? AND period=?`, setId, period);
  if (!p) throw new Error("period_not_found");
  run(`UPDATE periods SET status=? WHERE account_set_id=? AND period=?`, status, setId, period);
  return { period, status };
}
/** 返回 set/period 的期间状态；未登记过则按 open 处理。 */
export function periodStatus(setId, period) {
  const p = row(`SELECT status FROM periods WHERE account_set_id=? AND period=?`, setId, period);
  return p ? p.status : "open";
}

// ---------------------------------------------------------------- 凭证
export function checkVoucher(setId, entries = []) {
  const errors = [];
  if (!Array.isArray(entries) || entries.length < 2) errors.push("至少需要两条分录");
  let td = 0, tc = 0;
  entries.forEach((e, i) => {
    const d = r2(e.debit), c = r2(e.credit);
    td += d; tc += c;
    if (d < 0 || c < 0) errors.push(`第${i + 1}行金额不能为负`);
    if (d > 0 && c > 0) errors.push(`第${i + 1}行借贷不能同时有值`);
    if (d === 0 && c === 0) errors.push(`第${i + 1}行金额不能为 0`);
    if (e.code) {
      const acc = row(`SELECT * FROM accounts WHERE account_set_id=? AND code=?`, setId, String(e.code));
      if (!acc) errors.push(`第${i + 1}行科目不存在：${e.code}`);
    } else {
      errors.push(`第${i + 1}行缺少科目`);
    }
  });
  if (Math.abs(td - tc) > EPS) errors.push(`借贷不平：借方 ${r2(td)} / 贷方 ${r2(tc)}`);
  return { ok: errors.length === 0, errors, total_debit: r2(td), total_credit: r2(tc) };
}

function nextNumber(setId, period, word) {
  const r = row(
    `SELECT MAX(number) AS n FROM vouchers WHERE account_set_id=? AND period=? AND word=?`,
    setId, period, word
  );
  return (r?.n || 0) + 1;
}

export function createVoucher(setId, v = {}) {
  getAccountSet(setId);
  const period = String(v.period || "");
  ensurePeriod(setId, period);
  if (periodStatus(setId, period) === "closed") throw new Error("period_closed");
  const entries = v.entries || [];
  const chk = checkVoucher(setId, entries);
  if (!chk.ok) {
    const err = new Error("voucher_invalid");
    err.details = chk;
    throw err;
  }
  const status = v.status === "posted" ? "posted" : "draft";
  const word = v.word || "记";
  const number = v.number || nextNumber(setId, period, word);
  const info = run(
    `INSERT INTO vouchers (account_set_id, period, voucher_date, word, number, summary, status, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    setId, period, v.voucher_date || `${period}-01`, word, number, v.summary || "", status, now()
  );
  const vid = Number(info.lastInsertRowid);
  const ins = db.prepare(
    `INSERT INTO voucher_entries (voucher_id, line_no, code, summary, debit, credit) VALUES (?,?,?,?,?,?)`
  );
  entries.forEach((e, i) => ins.run(vid, i + 1, String(e.code), e.summary || v.summary || "", r2(e.debit), r2(e.credit)));
  return getVoucher(setId, vid);
}

export function listVouchers(setId, { period, status } = {}) {
  getAccountSet(setId);
  const where = [`account_set_id=?`];
  const args = [setId];
  if (period) { where.push("period=?"); args.push(period); }
  if (status) { where.push("status=?"); args.push(status); }
  const vs = rows(
    `SELECT * FROM vouchers WHERE ${where.join(" AND ")} ORDER BY period DESC, number DESC`,
    ...args
  );
  return vs.map(hydrate);
}
const hydrate = (v) => ({
  ...v,
  entries: rows(`SELECT line_no, code, summary, debit, credit FROM voucher_entries WHERE voucher_id=? ORDER BY line_no`, v.id),
  total_debit: r2(row(`SELECT COALESCE(SUM(debit),0) s FROM voucher_entries WHERE voucher_id=?`, v.id).s),
  total_credit: r2(row(`SELECT COALESCE(SUM(credit),0) s FROM voucher_entries WHERE voucher_id=?`, v.id).s),
});

export function getVoucher(setId, id) {
  const v = row(`SELECT * FROM vouchers WHERE account_set_id=? AND id=?`, setId, id);
  if (!v) throw new Error("voucher_not_found");
  return hydrate(v);
}

export function postVoucher(setId, id) {
  const v = getVoucher(setId, id);
  if (v.status === "posted") return v;
  if (periodStatus(setId, v.period) === "closed") throw new Error("period_closed");
  const chk = checkVoucher(setId, v.entries);
  if (!chk.ok) { const e = new Error("voucher_invalid"); e.details = chk; throw e; }
  run(`UPDATE vouchers SET status='posted' WHERE id=?`, id);
  return getVoucher(setId, id);
}
export function unpostVoucher(setId, id) {
  getVoucher(setId, id);
  run(`UPDATE vouchers SET status='draft' WHERE id=?`, id);
  return getVoucher(setId, id);
}
export function deleteVoucher(setId, id) {
  const v = getVoucher(setId, id);
  if (v.status === "posted") throw new Error("posted_voucher_requires_unpost");
  run(`DELETE FROM vouchers WHERE id=?`, id);
  return { deleted: id };
}

// ---------------------------------------------------------------- 余额
/** 计算账套在 period 的科目余额（含期初 + 已过账发生额）。 */
export function accountBalances(setId, period) {
  const s = getAccountSet(setId);
  const accs = listAccounts(setId);
  if (!/^\d{4}-\d{2}$/.test(String(period || ""))) throw new Error("period_invalid");
  const open = new Map(getOpeningBalances(setId).map((o) => [o.code, o]));
  const mv = rows(
    `SELECT e.code AS code,
            COALESCE(SUM(e.debit),0)  AS debit,
            COALESCE(SUM(e.credit),0) AS credit
       FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
      WHERE v.account_set_id=? AND v.status='posted' AND v.period BETWEEN ? AND ?
      GROUP BY e.code`,
    setId, s.start_period, period
  );
  const mvMap = new Map(mv.map((m) => [m.code, m]));
  const out = new Map();
  for (const a of accs) {
    const o = open.get(a.code) || { debit: 0, credit: 0 };
    const m = mvMap.get(a.code) || { debit: 0, credit: 0 };
    const net = r2((o.debit - o.credit) + (m.debit - m.credit));
    const natural = a.direction === "debit" ? net : -net;
    out.set(a.code, {
      code: a.code, name: a.name, category: a.category, direction: a.direction,
      contra: !!a.contra,
      opening_debit: r2(o.debit), opening_credit: r2(o.credit),
      period_debit: r2(m.debit), period_credit: r2(m.credit),
      net, natural, balance: natural,
    });
  }
  return out;
}

/** 仅统计指定区间的发生额（用于利润表本期/本年累计）。 */
function netForRange(setId, codes, fromPeriod, toPeriod) {
  if (!codes.length) return 0;
  const ph = codes.map(() => "?").join(",");
  const r = row(
    `SELECT COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c
       FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
      WHERE v.account_set_id=? AND v.status='posted' AND v.period BETWEEN ? AND ?
        AND e.code IN (${ph})`,
    setId, fromPeriod, toPeriod, ...codes
  );
  return { debit: r2(r.d), credit: r2(r.c) };
}
function naturalRange(setId, codes, fromPeriod, toPeriod) {
  const { debit, credit } = netForRange(setId, codes, fromPeriod, toPeriod);
  const dir = row(`SELECT direction FROM accounts WHERE account_set_id=? AND code=?`, setId, codes[0]);
  const d = dir?.direction || "debit";
  return r2(d === "debit" ? debit - credit : credit - debit);
}

const codes = (setId, prefixList) =>
  listAccounts(setId).filter((a) => prefixList.some((p) => a.code.startsWith(p))).map((a) => a.code);

// ---------------------------------------------------------------- 报表
export function trialBalance(setId, period) {
  const bal = accountBalances(setId, period);
  const lines = [...bal.values()].map((b) => ({
    code: b.code, name: b.name, direction: b.direction,
    opening_debit: b.opening_debit, opening_credit: b.opening_credit,
    period_debit: b.period_debit, period_credit: b.period_credit,
    closing_debit: b.net > 0 ? b.net : 0, closing_credit: b.net < 0 ? -b.net : 0,
  }));
  const sum = (k) => r2(lines.reduce((s, l) => s + l[k], 0));
  return {
    period, lines,
    totals: {
      opening_debit: sum("opening_debit"), opening_credit: sum("opening_credit"),
      period_debit: sum("period_debit"), period_credit: sum("period_credit"),
      closing_debit: sum("closing_debit"), closing_credit: sum("closing_credit"),
    },
  };
}

export function balanceSheet(setId, period) {
  const bal = accountBalances(setId, period);
  const nat = (code) => bal.get(code)?.natural || 0;
  const sum = (list) => r2(list.reduce((s, c) => s + nat(c), 0));

  const 货币资金 = sum(["1001", "1002", "1012"]);
  const 短期投资 = sum(["1101"]);
  const 应收票据 = sum(["1121"]);
  const 应收账款 = sum(["1122"]);
  const 预付账款 = sum(["1123"]);
  const 其他应收款 = sum(["1131", "1132", "1221"]);
  const 存货 = sum(codes(setId, ["1401", "1402", "1403", "1405", "1408", "1411"]));
  const 固定资产原价 = sum(["1601"]);
  const 累计折旧 = sum(["1602"]);
  const 固定资产 = r2(固定资产原价 - 累计折旧);
  const 在建工程 = sum(["1604"]);
  const 无形资产原价 = sum(["1701"]);
  const 累计摊销 = sum(["1702"]);
  const 无形资产 = r2(无形资产原价 - 累计摊销);
  const 长期待摊费用 = sum(["1801"]);
  const 资产合计 = r2(货币资金 + 短期投资 + 应收票据 + 应收账款 + 预付账款 + 其他应收款 +
    存货 + 固定资产 + 在建工程 + 无形资产 + 长期待摊费用);

  const 短期借款 = sum(["2001"]);
  const 应付票据 = sum(["2201"]);
  const 应付账款 = sum(["2202"]);
  const 预收账款 = sum(["2203"]);
  const 应付职工薪酬 = sum(["2211"]);
  const 应交税费 = sum(["2221"]);
  const 其他应付款 = sum(["2231", "2232", "2241"]);
  const 长期借款 = sum(["2501", "2701"]);
  const 负债合计 = r2(短期借款 + 应付票据 + 应付账款 + 预收账款 + 应付职工薪酬 +
    应交税费 + 其他应付款 + 长期借款);

  const 实收资本 = sum(["3001", "3002"]);
  const 盈余公积 = sum(["3101"]);
  const 已分配利润 = sum(["3104"]);
  const 损益科目 = listAccounts(setId).filter((a) => a.category === "损益").map((a) => a.code);
  // 本年利润 = 贷方(收入) - 借方(成本费用) = -Σ(borrow-credit)
  const 本年利润 = r2(-损益科目.reduce((s, c) => s + (bal.get(c)?.net || 0), 0));
  const 未分配利润 = r2(已分配利润 + 本年利润);
  const 所有者权益合计 = r2(实收资本 + 盈余公积 + 未分配利润);

  return {
    period,
    assets: [
      { label: "货币资金", value: 货币资金 },
      { label: "短期投资", value: 短期投资 },
      { label: "应收票据", value: 应收票据 },
      { label: "应收账款", value: 应收账款 },
      { label: "预付账款", value: 预付账款 },
      { label: "其他应收款", value: 其他应收款 },
      { label: "存货", value: 存货 },
      { label: "固定资产原价", value: 固定资产原价 },
      { label: "减：累计折旧", value: 累计折旧 },
      { label: "固定资产账面价值", value: 固定资产 },
      { label: "在建工程", value: 在建工程 },
      { label: "无形资产账面价值", value: 无形资产 },
      { label: "长期待摊费用", value: 长期待摊费用 },
      { label: "资产总计", value: 资产合计, strong: true },
    ],
    liabilities: [
      { label: "短期借款", value: 短期借款 },
      { label: "应付票据", value: 应付票据 },
      { label: "应付账款", value: 应付账款 },
      { label: "预收账款", value: 预收账款 },
      { label: "应付职工薪酬", value: 应付职工薪酬 },
      { label: "应交税费", value: 应交税费 },
      { label: "其他应付款", value: 其他应付款 },
      { label: "长期借款", value: 长期借款 },
      { label: "负债合计", value: 负债合计, strong: true },
      { label: "实收资本", value: 实收资本 },
      { label: "盈余公积", value: 盈余公积 },
      { label: "未分配利润", value: 未分配利润 },
      { label: "所有者权益合计", value: 所有者权益合计, strong: true },
      { label: "负债和所有者权益总计", value: r2(负债合计 + 所有者权益合计), strong: true },
    ],
    totals: { assets: 资产合计, liabilities: 负债合计, equity: 所有者权益合计 },
    balanced: Math.abs(资产合计 - (负债合计 + 所有者权益合计)) < EPS,
  };
}

export function incomeStatement(setId, period) {
  const s = getAccountSet(setId);
  const year = String(period).slice(0, 4);
  const ytdStart = s.start_period > `${year}-01` ? s.start_period : `${year}-01`;
  const N = (list, from, to) => naturalRange(setId, list, from, to);

  const build = (from, to) => {
    const 营业收入 = r2(N(["5001"], from, to) + N(["5051"], from, to));
    const 营业成本 = r2(N(["5401"], from, to) + N(["5402"], from, to));
    const 税金及附加 = N(["5403"], from, to);
    const 销售费用 = N(["5601"], from, to);
    const 管理费用 = N(["5602"], from, to);
    const 财务费用 = N(["5603"], from, to);
    const 投资收益 = N(["5111"], from, to);
    const 营业利润 = r2(营业收入 - 营业成本 - 税金及附加 - 销售费用 - 管理费用 - 财务费用 + 投资收益);
    const 营业外收入 = N(["5301"], from, to);
    const 营业外支出 = N(["5711"], from, to);
    const 利润总额 = r2(营业利润 + 营业外收入 - 营业外支出);
    const 所得税费用 = N(["5801"], from, to);
    const 净利润 = r2(利润总额 - 所得税费用);
    return { 营业收入, 营业成本, 税金及附加, 销售费用, 管理费用, 财务费用, 投资收益,
             营业利润, 营业外收入, 营业外支出, 利润总额, 所得税费用, 净利润 };
  };
  return { period, current: build(period, period), ytd: build(ytdStart, period) };
}

export function generalLedger(setId, code, period) {
  const s = getAccountSet(setId);
  const acc = row(`SELECT * FROM accounts WHERE account_set_id=? AND code=?`, setId, code);
  if (!acc) throw new Error("account_not_found");
  const o = row(`SELECT debit, credit FROM opening_balances WHERE account_set_id=? AND code=?`, setId, code) || { debit: 0, credit: 0 };
  let running = r2(o.debit - o.credit);
  const items = rows(
    `SELECT v.period, v.voucher_date, v.word, v.number, v.summary AS vsummary,
            e.summary, e.debit, e.credit, v.id AS voucher_id
       FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
      WHERE v.account_set_id=? AND v.status='posted' AND v.period BETWEEN ? AND ? AND e.code=?
      ORDER BY v.period, v.number, e.line_no`,
    setId, s.start_period, period, code
  ).map((it) => {
    running = r2(running + it.debit - it.credit);
    return { ...it, balance: running };
  });
  return {
    code, name: acc.name, direction: acc.direction, period,
    opening: { debit: r2(o.debit), credit: r2(o.credit) },
    items,
  };
}

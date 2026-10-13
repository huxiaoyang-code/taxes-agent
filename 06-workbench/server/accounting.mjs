// accounting.mjs — 复式记账领域逻辑 + 报表
import { db } from "./db.mjs";
import { COA } from "./coa.mjs";

const now = () => new Date().toISOString();
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const EPS = 0.005;

const row = (sql, ...args) => db.prepare(sql).get(...args);
const rows = (sql, ...args) => db.prepare(sql).all(...args);
const run = (sql, ...args) => db.prepare(sql).run(...args);

// 期间校验：YYYY-MM 且月份 01-12；createAccountSet/ensurePeriod/createVoucher 共用。
const PERIOD_RE = /^(\d{4})-(\d{2})$/;
function parsePeriod(period) {
  const m = PERIOD_RE.exec(String(period ?? ""));
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${m[1]}-${m[2]}`;
}
function requirePeriod(period, code = "period_invalid") {
  const p = parsePeriod(period);
  if (!p) throw new Error(code);
  return p;
}

// 嵌套安全的事务保存点：可在外层 BEGIN 内使用，失败时回滚到保存点。
let savepointSeq = 0;
function withSavepoint(fn) {
  const sp = `sp_${++savepointSeq}`;
  db.exec(`SAVEPOINT ${sp}`);
  try {
    const out = fn();
    db.exec(`RELEASE ${sp}`);
    return out;
  } catch (e) {
    try { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); } catch { /* ignore */ }
    throw e;
  }
}

// ---------------------------------------------------------------- 账套
export function createAccountSet({ name, taxpayer_type, accounting_standard, start_period }) {
  if (!name) throw new Error("name_required");
  const startPeriod = requirePeriod(start_period, "start_period_invalid");
  const info = run(
    `INSERT INTO account_sets (name, taxpayer_type, accounting_standard, start_period, created_at)
     VALUES (?,?,?,?,?)`,
    name,
    taxpayer_type || "小规模纳税人",
    accounting_standard || "小企业会计准则",
    startPeriod,
    now()
  );
  const id = Number(info.lastInsertRowid);
  const insAcc = db.prepare(
    `INSERT INTO accounts (account_set_id, code, name, category, direction, contra, is_leaf)
     VALUES (?,?,?,?,?,?,1)`
  );
  for (const a of COA) insAcc.run(id, a.code, a.name, a.category, a.direction, a.contra ? 1 : 0);
  ensurePeriod(id, startPeriod);
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
  if (!Array.isArray(items)) throw new Error("opening_items_invalid");

  // 已有已过账凭证或封账期间时，禁止改写期初。
  const posted = row(`SELECT COUNT(*) n FROM vouchers WHERE account_set_id=? AND status='posted'`, setId).n;
  if (posted > 0) throw new Error("opening_rewrite_after_posting");
  const closed = row(`SELECT COUNT(*) n FROM periods WHERE account_set_id=? AND status='closed'`, setId).n;
  if (closed > 0) throw new Error("opening_rewrite_period_closed");

  // 先全量预校验，再动数据库；避免部分写入。
  const resolved = [];
  for (const it of items) {
    const code = String(it?.code ?? "");
    if (!code) throw new Error("opening_code_required");
    const acc = row(`SELECT 1 FROM accounts WHERE account_set_id=? AND code=?`, setId, code);
    if (!acc) throw new Error(`account_not_found:${code}`);
    const rawDebit = Number(it?.debit ?? 0);
    const rawCredit = Number(it?.credit ?? 0);
    if (!Number.isFinite(rawDebit) || !Number.isFinite(rawCredit)) throw new Error(`opening_amount_invalid:${code}`);
    const debit = r2(rawDebit);
    const credit = r2(rawCredit);
    if (debit < 0 || credit < 0) throw new Error(`opening_amount_invalid:${code}`);
    if (debit > 0 && credit > 0) throw new Error(`opening_borrow_lend_conflict:${code}`);
    resolved.push({ code, debit, credit });
  }

  // 与已有期初合并后的整体必须借贷平衡。
  const merged = new Map(getOpeningBalances(setId).map((o) => [o.code, { debit: r2(o.debit), credit: r2(o.credit) }]));
  for (const it of resolved) merged.set(it.code, { debit: it.debit, credit: it.credit });
  let td = 0, tc = 0;
  for (const v of merged.values()) { td += v.debit; tc += v.credit; }
  if (Math.abs(r2(td) - r2(tc)) > EPS) {
    const err = new Error("opening_unbalanced");
    err.details = { total_debit: r2(td), total_credit: r2(tc) };
    throw err;
  }

  return withSavepoint(() => {
    const del = db.prepare(`DELETE FROM opening_balances WHERE account_set_id=? AND code=?`);
    const ins = db.prepare(
      `INSERT INTO opening_balances (account_set_id, code, debit, credit) VALUES (?,?,?,?)`
    );
    for (const it of resolved) {
      del.run(setId, it.code);
      ins.run(setId, it.code, it.debit, it.credit);
    }
    return getOpeningBalances(setId);
  });
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
  const s = getAccountSet(setId);
  const p = requirePeriod(period);
  if (p < s.start_period) throw new Error("period_before_start");
  run(`INSERT OR IGNORE INTO periods (account_set_id, period, status) VALUES (?,?,'open')`, setId, p);
  return row(`SELECT period, status FROM periods WHERE account_set_id=? AND period=?`, setId, p);
}
export function setPeriodStatus(setId, period, status) {
  if (!["open", "closed"].includes(status)) throw new Error("status_invalid");
  const s = getAccountSet(setId);
  const p = requirePeriod(period);
  if (p < s.start_period) throw new Error("period_before_start");
  const existing = row(`SELECT * FROM periods WHERE account_set_id=? AND period=?`, setId, p);

  if (status === "open") {
    // 反结账：已登记则置 open；未登记则新建期间。
    if (!existing) ensurePeriod(setId, p);
    else if (existing.status !== "open")
      run(`UPDATE periods SET status='open' WHERE account_set_id=? AND period=?`, setId, p);
    return { period: p, status: "open" };
  }

  // 结账：期间须已存在，当期无草稿且试算平衡（不强制已做损益结转）。
  if (!existing) throw new Error("period_not_found");
  const drafts = row(`SELECT COUNT(*) n FROM vouchers WHERE account_set_id=? AND period=? AND status='draft'`, setId, p).n;
  if (drafts > 0) throw new Error("period_has_draft_vouchers");
  const tb = trialBalance(setId, p);
  if (Math.abs(tb.totals.closing_debit - tb.totals.closing_credit) > EPS) throw new Error("period_unbalanced");
  if (existing.status !== "closed")
    run(`UPDATE periods SET status='closed' WHERE account_set_id=? AND period=?`, setId, p);
  return { period: p, status: "closed" };
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
  const s = getAccountSet(setId);
  // 先校验，后落库：校验失败不产生期间/凭证等副作用。
  const period = requirePeriod(v.period);
  if (period < s.start_period) throw new Error("period_before_start");
  if (periodStatus(setId, period) === "closed") throw new Error("period_closed");
  const entries = v.entries || [];
  const chk = checkVoucher(setId, entries);
  if (!chk.ok) {
    const err = new Error("voucher_invalid");
    err.details = chk;
    throw err;
  }
  return withSavepoint(() => {
    ensurePeriod(setId, period);
    const status = v.status === "posted" ? "posted" : "draft";
    const kind = v.kind || "normal";
    const word = v.word || "记";
    const number = v.number || nextNumber(setId, period, word);
    const info = run(
      `INSERT INTO vouchers (account_set_id, period, voucher_date, word, number, summary, status, kind, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      setId, period, v.voucher_date || `${period}-01`, word, number, v.summary || "", status, kind, now()
    );
    const vid = Number(info.lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO voucher_entries (voucher_id, line_no, code, summary, debit, credit) VALUES (?,?,?,?,?,?)`
    );
    entries.forEach((e, i) => ins.run(vid, i + 1, String(e.code), e.summary || v.summary || "", r2(e.debit), r2(e.credit)));
    return getVoucher(setId, vid);
  });
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
  const v = getVoucher(setId, id);
  if (periodStatus(setId, v.period) === "closed") throw new Error("period_closed");
  run(`UPDATE vouchers SET status='draft' WHERE id=?`, id);
  return getVoucher(setId, id);
}
export function deleteVoucher(setId, id) {
  const v = getVoucher(setId, id);
  if (periodStatus(setId, v.period) === "closed") throw new Error("period_closed");
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
      WHERE v.account_set_id=? AND v.status='posted' AND v.kind<>'carryforward' AND v.period BETWEEN ? AND ?
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
  // 未分配利润 = 利润分配 + 本年利润(3103) + 尚未结转的本年损益
  // 尚未结转损益 = 贷方(收入) - 借方(成本费用) = -Σ(debit-credit)
  const 未结转损益 = r2(-损益科目.reduce((s, c) => s + (bal.get(c)?.net || 0), 0));
  const 本年利润 = r2((bal.get("3103")?.natural || 0) + 未结转损益);
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
  const plAccounts = listAccounts(setId).filter((a) => a.category === "损益");

  // 按科目名称/编码尾号归集，兼容小企业(5xxx)与企业会计准则(6xxx)两套编码
  const TAIL = {
    "001": "营业收入", "051": "营业收入", "111": "投资收益", "301": "营业外收入",
    "401": "营业成本", "402": "营业成本", "403": "税金及附加", "601": "销售费用",
    "602": "管理费用", "603": "财务费用", "711": "营业外支出", "801": "所得税费用",
  };
  const lineOf = (a) => {
    const n = a.name || "";
    if (/主营业务收入|其他业务收入/.test(n)) return "营业收入";
    if (/主营业务成本|其他业务成本/.test(n)) return "营业成本";
    if (/税金及附加/.test(n)) return "税金及附加";
    if (/销售费用/.test(n)) return "销售费用";
    if (/管理费用/.test(n)) return "管理费用";
    if (/财务费用/.test(n)) return "财务费用";
    if (/投资收益/.test(n)) return "投资收益";
    if (/营业外收入/.test(n)) return "营业外收入";
    if (/营业外支出/.test(n)) return "营业外支出";
    if (/所得税费用/.test(n)) return "所得税费用";
    if (TAIL[a.code.slice(-3)]) return TAIL[a.code.slice(-3)];
    return a.direction === "credit" ? "其他收入" : "其他费用";
  };

  const build = (from, to) => {
    const acc = {};
    for (const a of plAccounts) {
      const v = naturalRange(setId, [a.code], from, to);
      if (Math.abs(v) < EPS) continue;
      const line = lineOf(a);
      acc[line] = r2((acc[line] || 0) + v);
    }
    const g = (k) => acc[k] || 0;
    const 其他收入 = g("其他收入"), 其他费用 = g("其他费用");
    const 营业收入 = r2(g("营业收入") + 其他收入);
    const 营业成本 = r2(g("营业成本") + 其他费用);
    const 税金及附加 = g("税金及附加");
    const 销售费用 = g("销售费用");
    const 管理费用 = g("管理费用");
    const 财务费用 = g("财务费用");
    const 投资收益 = g("投资收益");
    const 营业利润 = r2(营业收入 - 营业成本 - 税金及附加 - 销售费用 - 管理费用 - 财务费用 + 投资收益);
    const 营业外收入 = g("营业外收入");
    const 营业外支出 = g("营业外支出");
    const 利润总额 = r2(营业利润 + 营业外收入 - 营业外支出);
    const 所得税费用 = g("所得税费用");
    const 净利润 = r2(利润总额 - 所得税费用);
    return { 营业收入, 营业成本, 税金及附加, 销售费用, 管理费用, 财务费用, 投资收益,
             其他收入, 其他费用, 营业利润, 营业外收入, 营业外支出, 利润总额, 所得税费用, 净利润 };
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

// ================================================================ P1 能力

const pad2 = (n) => String(n).padStart(2, "0");
function lastDay(period) {
  const [y, m] = period.split("-").map(Number);
  return `${y}-${pad2(m)}-${new Date(Date.UTC(y, m, 0)).getUTCDate()}`;
}
function prevPeriod(period) {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

// ---------------------------------------------------------------- 期末结转损益
/**
 * 结转本期损益到 3103 本年利润；yearEnd=true 时再结转 3103 -> 3104。
 * 结转凭证 kind='carryforward'，不计入利润表发生额，避免重复计算。
 */
export function carryForwardProfit(setId, period, { yearEnd = false } = {}) {
  getAccountSet(setId);
  ensurePeriod(setId, period);
  if (periodStatus(setId, period) === "closed") throw new Error("period_closed");
  if (row(`SELECT id FROM vouchers WHERE account_set_id=? AND period=? AND kind='carryforward'`, setId, period))
    throw new Error("already_carried_forward");

  const bal = accountBalances(setId, period);
  const entries = [];
  let revenue = 0, expense = 0;
  for (const a of listAccounts(setId).filter((x) => x.category === "损益")) {
    const b = bal.get(a.code);
    if (!b || Math.abs(b.natural) < EPS) continue;
    if (a.direction === "credit") {
      revenue = r2(revenue + b.natural);
      entries.push({ code: a.code, summary: "结转本期损益", debit: b.natural, credit: 0 });
    } else {
      expense = r2(expense + b.natural);
      entries.push({ code: a.code, summary: "结转本期损益", debit: 0, credit: b.natural });
    }
  }
  if (!entries.length) return { voucher: null, note: "本期无损益发生额" };

  const profit = r2(revenue - expense);
  entries.push(profit >= 0
    ? { code: "3103", summary: "结转本期损益", debit: 0, credit: profit }
    : { code: "3103", summary: "结转本期损益", debit: -profit, credit: 0 });

  const voucher = createVoucher(setId, {
    period, voucher_date: lastDay(period), summary: "结转本期损益",
    kind: "carryforward", status: "posted", entries,
  });

  let yearEndVoucher = null;
  if (yearEnd) {
    const p3103 = accountBalances(setId, period).get("3103")?.natural || 0;
    if (Math.abs(p3103) >= EPS) {
      const es = p3103 > 0
        ? [{ code: "3103", debit: p3103, credit: 0, summary: "结转本年利润" },
           { code: "3104", debit: 0, credit: p3103, summary: "结转本年利润" }]
        : [{ code: "3103", debit: 0, credit: -p3103, summary: "结转本年利润" },
           { code: "3104", debit: -p3103, credit: 0, summary: "结转本年利润" }];
      yearEndVoucher = createVoucher(setId, {
        period, voucher_date: lastDay(period), summary: "结转本年利润",
        kind: "carryforward", status: "posted", entries: es,
      });
    }
  }
  return { voucher, yearEndVoucher, revenue, expense, profit };
}

// ---------------------------------------------------------------- 资产卡片
export function listAssetCards(setId) {
  getAccountSet(setId);
  return rows(
    `SELECT c.*, COALESCE((SELECT SUM(r.amount) FROM asset_depreciation_runs r WHERE r.asset_id=c.id),0) AS accumulated
       FROM asset_cards c WHERE c.account_set_id=? ORDER BY c.id`, setId
  ).map((c) => ({
    ...c,
    depreciable: r2(c.original_cost * (1 - c.residual_rate)),
    monthly: r2((c.original_cost * (1 - c.residual_rate)) / c.useful_life_months),
    remaining: r2(c.original_cost * (1 - c.residual_rate) - c.accumulated),
    months_done: row(`SELECT COUNT(*) n FROM asset_depreciation_runs WHERE asset_id=?`, c.id).n,
  }));
}

export function addAssetCard(setId, c = {}) {
  getAccountSet(setId);
  const kind = c.kind === "intangible" ? "intangible" : "fixed";
  const name = String(c.name || "").trim();
  const cost = Number(c.original_cost);
  const life = parseInt(c.useful_life_months, 10);
  if (!name) throw new Error("name_required");
  if (!(cost > 0)) throw new Error("original_cost_invalid");
  if (!(life >= 1)) throw new Error("useful_life_months_invalid");
  const start_period = String(c.start_period || "");
  if (!/^\d{4}-\d{2}$/.test(start_period)) throw new Error("start_period_invalid");
  const residual = c.residual_rate === undefined ? (kind === "fixed" ? 0.05 : 0) : Number(c.residual_rate);
  if (residual < 0 || residual >= 1) throw new Error("residual_rate_invalid");
  const asset_account = c.asset_account || (kind === "fixed" ? "1601" : "1701");
  const accum_account = c.accum_account || (kind === "fixed" ? "1602" : "1702");
  const expense_account = c.expense_account || "5602";
  for (const code of [asset_account, accum_account, expense_account]) {
    if (!row(`SELECT 1 FROM accounts WHERE account_set_id=? AND code=?`, setId, code))
      throw new Error(`account_not_found:${code}`);
  }
  const info = run(
    `INSERT INTO asset_cards (account_set_id, kind, name, original_cost, residual_rate, useful_life_months,
       start_period, asset_account, accum_account, expense_account, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    setId, kind, name, r2(cost), residual, life, start_period, asset_account, accum_account, expense_account, now()
  );
  return listAssetCards(setId).find((x) => x.id === Number(info.lastInsertRowid));
}

export function deleteAssetCard(setId, id) {
  getAccountSet(setId);
  const used = row(`SELECT COUNT(*) n FROM asset_depreciation_runs WHERE account_set_id=? AND asset_id=?`, setId, id).n;
  if (used) throw new Error("asset_has_depreciation_runs");
  run(`DELETE FROM asset_cards WHERE account_set_id=? AND id=?`, setId, id);
  return { deleted: id };
}

export function listDepreciationRuns(setId, { period } = {}) {
  getAccountSet(setId);
  const where = ["account_set_id=?"]; const args = [setId];
  if (period) { where.push("period=?"); args.push(period); }
  return rows(`SELECT * FROM asset_depreciation_runs WHERE ${where.join(" AND ")} ORDER BY period DESC, id`, ...args);
}

// ---------------------------------------------------------------- 折旧/摊销计提
/** 按直线法对全部资产卡计提指定期间折旧/摊销，生成一张凭证并记录 runs。 */
export function generateDepreciation(setId, period) {
  getAccountSet(setId);
  ensurePeriod(setId, period);
  if (periodStatus(setId, period) === "closed") throw new Error("period_closed");
  const cards = rows(`SELECT * FROM asset_cards WHERE account_set_id=? ORDER BY id`, setId);
  const entries = [];
  const pending = [];
  for (const c of cards) {
    if (c.start_period > period) continue;
    if (row(`SELECT 1 FROM asset_depreciation_runs WHERE account_set_id=? AND asset_id=? AND period=?`, setId, c.id, period))
      continue;
    const depreciable = r2(c.original_cost * (1 - c.residual_rate));
    const monthly = r2(depreciable / c.useful_life_months);
    const done = r2(row(`SELECT COALESCE(SUM(amount),0) s FROM asset_depreciation_runs WHERE asset_id=?`, c.id).s);
    const remaining = r2(depreciable - done);
    if (remaining <= EPS) continue;
    const amount = Math.min(monthly, remaining);
    const label = c.kind === "fixed" ? "折旧" : "摊销";
    entries.push({ code: c.expense_account, summary: `计提${label}-${c.name}`, debit: amount, credit: 0 });
    entries.push({ code: c.accum_account, summary: `计提${label}-${c.name}`, debit: 0, credit: amount });
    pending.push({ asset_id: c.id, amount });
  }
  if (!entries.length) return { voucher: null, runs: [], note: "本期无需计提（已提足或未到计提期）" };
  const voucher = createVoucher(setId, {
    period, voucher_date: lastDay(period), summary: "计提折旧与摊销",
    kind: "depreciation", status: "posted", entries,
  });
  const ins = db.prepare(
    `INSERT INTO asset_depreciation_runs (account_set_id, asset_id, period, amount, voucher_id, created_at)
     VALUES (?,?,?,?,?,?)`
  );
  for (const p of pending) ins.run(setId, p.asset_id, period, p.amount, voucher.id, now());
  return { voucher, runs: pending };
}

// ---------------------------------------------------------------- 现金流量表
/**
 * 现金流量表：以货币资金科目的对方科目分类（经营/投资/筹资），
 * 并附「净利润 -> 经营活动净额」的间接法补充资料。
 */
export function cashFlowStatement(setId, period) {
  getAccountSet(setId);
  if (!/^\d{4}-\d{2}$/.test(String(period || ""))) throw new Error("period_invalid");
  const CASH = new Set(["1001", "1002", "1012"]);
  const classify = (code) => {
    if (/^(1101|1501|1511|1601|1602|1604|1606|1701|1702|1801)/.test(code)) return "investing";
    if (/^(2001|2231|2232|2501|2701|3001|3002|3101|3103|3104)/.test(code)) return "financing";
    return "operating";
  };
  const names = new Map(listAccounts(setId).map((a) => [a.code, a.name]));
  const bucket = { operating: new Map(), investing: new Map(), financing: new Map() };

  for (const v of rows(
    `SELECT id FROM vouchers WHERE account_set_id=? AND status='posted' AND kind<>'carryforward' AND period=?`,
    setId, period)) {
    const es = rows(`SELECT code, debit, credit FROM voucher_entries WHERE voucher_id=?`, v.id);
    let cashDelta = 0;
    const others = [];
    for (const e of es) {
      if (CASH.has(e.code)) cashDelta += e.debit - e.credit;
      else others.push(e);
    }
    if (Math.abs(cashDelta) < EPS) continue;
    const othersMag = others.reduce((s, e) => s + Math.abs(e.debit) + Math.abs(e.credit), 0);
    if (othersMag < EPS) continue;
    for (const e of others) {
      const mag = Math.abs(e.debit) + Math.abs(e.credit);
      const part = cashDelta * (mag / othersMag);
      const cat = classify(e.code);
      bucket[cat].set(e.code, r2((bucket[cat].get(e.code) || 0) + part));
    }
  }

  const toLines = (cat) => [...bucket[cat].entries()]
    .filter(([, v]) => Math.abs(v) >= EPS)
    .map(([code, value]) => ({ code, name: names.get(code) || code, value }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const operating = toLines("operating"), investing = toLines("investing"), financing = toLines("financing");
  const sum = (a) => r2(a.reduce((s, l) => s + l.value, 0));
  const opT = sum(operating), inT = sum(investing), fiT = sum(financing), net = r2(opT + inT + fiT);

  const balEnd = accountBalances(setId, period);
  const balBegin = accountBalances(setId, prevPeriod(period));
  const cashAt = (bal) => r2(["1001", "1002", "1012"].reduce((s, c) => s + (bal.get(c)?.natural || 0), 0));
  const cash_begin = cashAt(balBegin), cash_end = cashAt(balEnd);

  const is = incomeStatement(setId, period);
  const dep = r2(row(
    `SELECT COALESCE(SUM(e.credit),0) c FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
      WHERE v.account_set_id=? AND v.status='posted' AND v.kind<>'carryforward' AND v.period=?
        AND e.code IN ('1602','1702')`, setId, period).c);
  const natSum = (bal, codes) => r2(codes.reduce((s, c) => s + (bal.get(c)?.natural || 0), 0));
  const RECV = ["1121", "1122", "1123", "1131", "1132", "1221"];
  const INV = ["1401", "1402", "1403", "1405", "1408", "1411"];
  const PAY = ["2201", "2202", "2203", "2211", "2221", "2231", "2232", "2241"];
  const dRecv = r2(natSum(balEnd, RECV) - natSum(balBegin, RECV));
  const dInv = r2(natSum(balEnd, INV) - natSum(balBegin, INV));
  const dPay = r2(natSum(balEnd, PAY) - natSum(balBegin, PAY));

  return {
    period, method: "直接法（按对方科目分类）",
    operating, investing, financing,
    totals: { operating: opT, investing: inT, financing: fiT, net_increase: net },
    cash: { begin: cash_begin, end: cash_end, change: r2(cash_end - cash_begin) },
    reconciles: Math.abs(net - (cash_end - cash_begin)) < EPS,
    supplement_indirect: {
      净利润: is.current["净利润"],
      加_折旧与摊销: dep,
      减_经营性应收的增加: dRecv,
      减_存货的增加: dInv,
      加_经营性应付的增加: dPay,
      经营活动产生的现金流量净额: opT,
    },
  };
}

// ================================================================ 导入旧账

const normKey = (s) => String(s ?? "").trim().toLowerCase().replace(/[\s_\u3000]/g, "");

export function parseCsv(text) {
  const s = String(text ?? "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ""));
}

const numOr0 = (v) => {
  const n = Number(String(v ?? "").replace(/[,\s\u00a5\uffe5]/g, ""));
  return Number.isFinite(n) ? r2(n) : 0;
};
const DIRECTIONS = { 借: "debit", debit: "debit", d: "debit", 借方: "debit", 贷: "credit", credit: "credit", c: "credit", 贷方: "credit" };

function headerMap(rows, synonyms, positions) {
  const first = (rows[0] || []).map(normKey);
  const idx = {}; let matched = 0;
  for (const key of Object.keys(synonyms)) {
    const i = first.findIndex((h) => synonyms[key].includes(h));
    if (i >= 0) { idx[key] = i; matched++; }
  }
  if (matched >= 2) return { idx, start: 1 };
  const pos = {}; Object.keys(synonyms).forEach((k, n) => { pos[k] = positions[n]; });
  return { idx: pos, start: 0 };
}

const CSV_COLS = {
  accounts: {
    code: ["科目编码", "科目代码", "编码", "code"],
    name: ["科目名称", "名称", "name"],
    category: ["类别", "科目类别", "category"],
    direction: ["方向", "余额方向", "direction"],
  },
  openings: {
    code: ["科目编码", "科目代码", "编码", "code"],
    debit: ["借方", "期初借方", "借方余额", "debit"],
    credit: ["贷方", "期初贷方", "贷方余额", "credit"],
  },
  vouchers: {
    period: ["期间", "会计期间", "period"],
    date: ["日期", "凭证日期", "date"],
    word: ["字号", "凭证字", "word"],
    number: ["凭证号", "号码", "number"],
    summary: ["摘要", "summary"],
    code: ["科目编码", "科目代码", "code"],
    debit: ["借方", "借方金额", "debit"],
    credit: ["贷方", "贷方金额", "credit"],
  },
};
const META_KEYS = {
  账套名称: "name", 名称: "name", name: "name",
  纳税人性质: "taxpayer_type", 纳税人类型: "taxpayer_type", taxpayer_type: "taxpayer_type",
  会计准则: "accounting_standard", accounting_standard: "accounting_standard",
  启用期间: "start_period", start_period: "start_period",
};

/** 把 4 张 CSV 文本解析成导入 payload（不落库）。 */
export function parseImportTexts(texts = {}, metaOverride = {}) {
  const payload = { account_set: { ...metaOverride }, accounts: [], opening_balances: [], vouchers: [] };
  if (texts.meta) {
    for (const r of parseCsv(texts.meta)) {
      if (r.length < 2) continue;
      const key = META_KEYS[normKey(r[0])];
      if (key) payload.account_set[key] = String(r[1]).trim();
    }
  }
  if (texts.accounts) {
    const rows = parseCsv(texts.accounts);
    const { idx, start } = headerMap(rows, CSV_COLS.accounts, [0, 1, 2, 3]);
    for (let i = start; i < rows.length; i++) {
      const row = rows[i];
      payload.accounts.push({
        code: String(row[idx.code] ?? "").trim(), name: String(row[idx.name] ?? "").trim(),
        category: String(row[idx.category] ?? "").trim(),
        direction: DIRECTIONS[normKey(row[idx.direction])] || String(row[idx.direction] ?? "").trim(),
      });
    }
  }
  if (texts.openings) {
    const rows = parseCsv(texts.openings);
    const { idx, start } = headerMap(rows, CSV_COLS.openings, [0, 1, 2]);
    for (let i = start; i < rows.length; i++) {
      const row = rows[i];
      payload.opening_balances.push({ code: String(row[idx.code] ?? "").trim(), debit: numOr0(row[idx.debit]), credit: numOr0(row[idx.credit]) });
    }
  }
  if (texts.vouchers) {
    const rows = parseCsv(texts.vouchers);
    const { idx, start } = headerMap(rows, CSV_COLS.vouchers, [0, 1, 2, 3, 4, 5, 6, 7]);
    const groups = new Map();
    for (let i = start; i < rows.length; i++) {
      const row = rows[i];
      const period = String(row[idx.period] ?? "").trim();
      const word = String(row[idx.word] ?? "").trim() || "记";
      const number = parseInt(row[idx.number], 10) || 1;
      const key = `${period}|${word}|${number}`;
      if (!groups.has(key)) groups.set(key, {
        period, word, number,
        date: String(row[idx.date] ?? "").trim(), summary: String(row[idx.summary] ?? "").trim(), entries: [],
      });
      groups.get(key).entries.push({
        code: String(row[idx.code] ?? "").trim(), summary: String(row[idx.summary] ?? "").trim(),
        debit: numOr0(row[idx.debit]), credit: numOr0(row[idx.credit]),
      });
    }
    payload.vouchers = [...groups.values()];
  }
  return payload;
}

/** 校验导入 payload，返回错误/警告/统计。 */
export function validateImportPayload(payload = {}) {
  const errors = [], warnings = [];
  const meta = payload.account_set || {};
  if (!String(meta.name || "").trim()) errors.push("缺少账套名称");
  if (!/^\d{4}-\d{2}$/.test(String(meta.start_period || ""))) errors.push("启用期间格式应为 YYYY-MM");

  const coaCodes = new Set(COA.map((a) => a.code));
  const accs = payload.accounts || [];
  accs.forEach((a, i) => {
    if (!a.code || !a.name) return errors.push(`科目第 ${i + 1} 行缺少编码或名称`);
    if (a.direction && !["debit", "credit"].includes(a.direction)) errors.push(`科目 ${a.code} 方向非法：${a.direction}`);
    if (a.category && !["资产", "负债", "权益", "成本", "损益"].includes(a.category)) errors.push(`科目 ${a.code} 类别非法：${a.category}`);
    if (coaCodes.has(String(a.code))) warnings.push(`科目 ${a.code} 已存在标准科目，将保留标准名称`);
  });
  const codes = new Set([...coaCodes, ...accs.map((a) => String(a.code))]);

  let od = 0, oc = 0;
  (payload.opening_balances || []).forEach((o, i) => {
    if (!codes.has(String(o.code))) errors.push(`期初余额第 ${i + 1} 行科目不存在：${o.code}`);
    od += Number(o.debit) || 0; oc += Number(o.credit) || 0;
  });
  if (Math.abs(od - oc) > EPS) errors.push(`期初余额借贷不平：借 ${r2(od)} / 贷 ${r2(oc)}`);

  let entryCount = 0;
  (payload.vouchers || []).forEach((v, i) => {
    if (!/^\d{4}-\d{2}$/.test(String(v.period || ""))) return errors.push(`凭证 ${i + 1} 期间非法：${v.period}`);
    const es = v.entries || []; entryCount += es.length;
    if (es.length < 2) errors.push(`凭证 ${i + 1}（${v.period} ${v.word}-${v.number}）至少两条分录`);
    let d = 0, c = 0;
    es.forEach((e) => {
      if (!codes.has(String(e.code))) errors.push(`凭证 ${i + 1} 科目不存在：${e.code}`);
      d += Number(e.debit) || 0; c += Number(e.credit) || 0;
    });
    if (Math.abs(d - c) > EPS) errors.push(`凭证 ${i + 1}（${v.period} ${v.word}-${v.number}）借贷不平：借 ${r2(d)} / 贷 ${r2(c)}`);
  });

  return {
    ok: errors.length === 0, errors, warnings,
    summary: {
      account_set: meta.name || null, start_period: meta.start_period || null,
      accounts: accs.length, opening_balances: (payload.opening_balances || []).length,
      vouchers: (payload.vouchers || []).length, entries: entryCount,
    },
  };
}

/** 先预检（dryRun）再落库；落库在一个事务里，失败回滚。 */
export function importAccountSet(payload = {}, { dryRun = false } = {}) {
  const validation = validateImportPayload(payload);
  if (dryRun || !validation.ok) return { dryRun: true, validation, created: null };
  const meta = payload.account_set || {};
  db.exec("BEGIN");
  try {
    const set = createAccountSet({
      name: meta.name, taxpayer_type: meta.taxpayer_type || "小规模纳税人",
      accounting_standard: meta.accounting_standard || "小企业会计准则", start_period: meta.start_period,
    });
    const have = new Set(listAccounts(set.id).map((a) => a.code));
    for (const a of payload.accounts || []) {
      if (have.has(String(a.code))) continue;
      addAccount(set.id, { code: a.code, name: a.name, category: a.category, direction: a.direction });
      have.add(String(a.code));
    }
    if ((payload.opening_balances || []).length) setOpeningBalances(set.id, payload.opening_balances);
    let vcount = 0;
    for (const v of payload.vouchers || []) {
      createVoucher(set.id, {
        period: v.period, voucher_date: v.date || `${v.period}-01`, word: v.word || "记",
        number: v.number, summary: v.summary, kind: "normal", status: "posted", entries: v.entries,
      });
      vcount++;
    }
    db.exec("COMMIT");
    return {
      dryRun: false, validation,
      created: {
        id: set.id, name: set.name, start_period: set.start_period,
        accounts: listAccounts(set.id).length, opening_balances: getOpeningBalances(set.id).length, vouchers: vcount,
      },
    };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// tax-import.mjs — 税局浏览器采集结果的落库导入（批量建账 / 绑定空账套）
//
// 规则（与 docs/TAX-BROWSER.md 对应）：
//   - 只接受「服务端会话采集结果」生成的 items（含税号），导入前再次严格校验税号；
//     请求里伪造的 company 对象一律不会进入本层。
//   - 建账只用企业基本档案（名称+税号+地区+来源+时间）：建空账套、载入标准科目，
//     不造历史凭证、不造期初余额；启用期间/会计准则/纳税人类型必须由调用方显式给出。
//   - 同一税号重复导入：返回已绑定账套（existing），不重复建、不覆盖已有账套。
//   - 绑定已有账套：仅允许空账套（无凭证、无期初、无资产卡片）；该账套不能已绑定其他
//     税号，该税号也不能已绑定其他账套；名称变更必须显式预览确认后才改。
//   - 批量导入在一个事务里完成，任何一项失败整体回滚（原子性）。
//   - 绑定关系落 tax_enterprise_bindings 表（taxpayerId / region / city / source / importedAt），
//     可追溯；删除账套级联删除绑定。

import { db } from "./db.mjs";
import * as A from "./accounting.mjs";
import { STANDARDS } from "./coa.mjs";
import { validateTaxpayerId, maskTaxpayerId } from "./tax-browser.mjs";

export class TaxImportError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = "TaxImportError";
    this.code = code;
    this.details = details;
  }
}

const TAXPAYER_TYPES = ["小规模纳税人", "一般纳税人"];
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_ITEMS = 200;

const row = (sql, ...args) => db.prepare(sql).get(...args);

function sanitizeEnterpriseName(raw) {
  const name = String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (name.length < 2 || name.length > 80) return null;
  return name;
}

function requireCreateFields(create) {
  const c = create && typeof create === "object" ? create : {};
  const start_period = String(c.start_period ?? "").trim();
  if (!start_period) throw new TaxImportError("start_period_required", "必须显式选择启用期间（YYYY-MM）：该参数由用户确认，不代表税局数据");
  if (!PERIOD_RE.test(start_period)) throw new TaxImportError("start_period_invalid", `启用期间格式应为 YYYY-MM，收到：${start_period}`);
  const accounting_standard = String(c.accounting_standard ?? "").trim();
  if (!accounting_standard) throw new TaxImportError("accounting_standard_required", "必须显式选择会计准则：该参数由用户确认，不代表税局数据");
  if (!STANDARDS.includes(accounting_standard)) {
    throw new TaxImportError("accounting_standard_invalid", `会计准则必须是：${STANDARDS.join(" / ")}；收到：${accounting_standard}`);
  }
  const taxpayer_type = String(c.taxpayer_type ?? "").trim();
  if (!taxpayer_type) throw new TaxImportError("taxpayer_type_required", "必须显式选择纳税人类型：该参数由用户确认，不代表税局数据");
  if (!TAXPAYER_TYPES.includes(taxpayer_type)) {
    throw new TaxImportError("taxpayer_type_invalid", `纳税人类型必须是：${TAXPAYER_TYPES.join(" / ")}；收到：${taxpayer_type}`);
  }
  return { start_period, accounting_standard, taxpayer_type };
}

function accountSetUsage(setId) {
  return row(
    `SELECT
       (SELECT COUNT(*) FROM vouchers WHERE account_set_id = ?) AS vouchers,
       (SELECT COUNT(*) FROM opening_balances WHERE account_set_id = ?) AS openings,
       (SELECT COUNT(*) FROM asset_cards WHERE account_set_id = ?) AS assets`,
    setId, setId, setId
  );
}

function bindingByTaxpayerId(taxpayerId) {
  return row(`SELECT * FROM tax_enterprise_bindings WHERE taxpayer_id = ?`, taxpayerId) || null;
}
function bindingByAccountSetId(setId) {
  return row(`SELECT * FROM tax_enterprise_bindings WHERE account_set_id = ?`, setId) || null;
}

/**
 * 导入税局采集企业。
 * @param {object}   args
 * @param {Array}    args.items      服务端会话生成的候选（candidateId/name/taxpayerId）
 * @param {string}   args.mode       "create"（批量新建账套）或 "bind"（绑定一个已有空账套）
 * @param {object}   [args.create]   mode=create 必填：{start_period, accounting_standard, taxpayer_type}
 * @param {number}   [args.accountSetId] mode=bind 必填：目标账套
 * @param {boolean}  [args.dryRun]   预览（不落库）
 * @param {boolean}  [args.confirmNameChange] mode=bind 且名称变化时必须显式确认
 * @param {string}   args.region / args.city / args.source  绑定溯源字段（来自会话，不可由请求伪造）
 */
export function importFromTaxBrowser({
  items, mode = "create", create = null, accountSetId = null,
  dryRun = false, confirmNameChange = false, region = null, city = null, source = "tax-browser",
} = {}) {
  if (mode !== "create" && mode !== "bind") {
    throw new TaxImportError("import_mode_invalid", "mode 必须是 create（批量新建账套）或 bind（绑定已有空账套）");
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
    throw new TaxImportError("items_invalid", `候选企业列表必须是非空数组且不超过 ${MAX_ITEMS} 条`);
  }
  if (!region || !city) throw new TaxImportError("region_required", "缺少地区溯源信息（region/city）");

  // ---- 预校验（全部通过才可能落库，失败即整体拒绝）
  const seenIds = new Set();
  const normalized = items.map((it) => {
    const taxpayerId = validateTaxpayerId(it?.taxpayerId);
    if (!taxpayerId) {
      throw new TaxImportError("taxpayer_id_invalid", `企业税号严格校验未通过（${maskTaxpayerId(it?.taxpayerId)}）：仅接受 18 位统一社会信用代码（校验位须正确）或 15 位纳税人识别号`);
    }
    if (seenIds.has(taxpayerId)) {
      throw new TaxImportError("taxpayer_id_duplicated", `同一批请求中税号重复：${maskTaxpayerId(taxpayerId)}`);
    }
    seenIds.add(taxpayerId);
    const name = sanitizeEnterpriseName(it?.name);
    if (!name) {
      throw new TaxImportError("enterprise_name_invalid", `企业名称不合法（${maskTaxpayerId(taxpayerId)}）：长度须为 2–80 个字符`);
    }
    return { candidateId: String(it?.candidateId ?? ""), taxpayerId, name };
  });

  const importedAt = new Date().toISOString();

  if (mode === "bind") {
    if (normalized.length !== 1) {
      throw new TaxImportError("bind_single_candidate_only", "绑定已有账套一次只能选择 1 家企业（批量请使用 create 模式）");
    }
    const id = Number(accountSetId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new TaxImportError("accountSetId_required", "绑定模式必须显式提供目标账套 accountSetId");
    }
    let set;
    try {
      set = A.getAccountSet(id);
    } catch {
      throw new TaxImportError("account_set_not_found", `本地账套不存在：${id}`);
    }
    const target = normalized[0];
    const setBinding = bindingByAccountSetId(id);
    if (setBinding && setBinding.taxpayer_id !== target.taxpayerId) {
      throw new TaxImportError("account_set_already_bound", `账套 ${id} 已绑定其他税号（${maskTaxpayerId(setBinding.taxpayer_id)}），不能重复绑定`);
    }
    if (setBinding && setBinding.taxpayer_id === target.taxpayerId) {
      return {
        dryRun: false, idempotent: true,
        results: [{
          candidateId: target.candidateId, taxpayerId: target.taxpayerId, name: set.name,
          action: "bound_idempotent", accountSetId: id, nameChange: null,
        }],
        summary: { created: 0, existing: 0, bound: 0, idempotent: 1 },
      };
    }
    const taxBinding = bindingByTaxpayerId(target.taxpayerId);
    if (taxBinding && taxBinding.account_set_id !== id) {
      throw new TaxImportError("taxpayer_id_already_bound", `该税号已绑定账套 ${taxBinding.account_set_id}：请直接使用该账套，或先在原账套解除绑定`);
    }
    const usage = accountSetUsage(id);
    if (usage.vouchers > 0 || usage.openings > 0 || usage.assets > 0) {
      throw new TaxImportError("account_set_not_empty", `账套 ${id} 不是空账套（凭证 ${usage.vouchers} / 期初 ${usage.openings} / 资产 ${usage.assets}）：绑定导入只允许空账套，不会覆盖已有数据`);
    }
    const nameChange = set.name === target.name ? null : { from: set.name, to: target.name };
    const preview = {
      candidateId: target.candidateId, taxpayerId: target.taxpayerId, name: target.name,
      action: "bind", accountSetId: id, nameChange, requiresNameChangeConfirm: !!nameChange,
    };
    if (dryRun) {
      return { dryRun: true, results: [preview], summary: { created: 0, existing: 0, bound: 1, idempotent: 0 } };
    }
    if (nameChange && !confirmNameChange) {
      throw new TaxImportError("name_change_confirmation_required", `账套名称将由「${set.name}」改为税局登记名称「${target.name}」：请先 dryRun 预览并以 confirmNameChange=true 显式确认`);
    }
    db.exec("BEGIN");
    try {
      if (nameChange) {
        db.prepare(`UPDATE account_sets SET name = ? WHERE id = ?`).run(target.name, id);
      }
      db.prepare(
        `INSERT INTO tax_enterprise_bindings (account_set_id, taxpayer_id, region, city, source, imported_at)
         VALUES (?,?,?,?,?,?)`
      ).run(id, target.taxpayerId, String(region), String(city), String(source), importedAt);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return {
      dryRun: false,
      results: [{ ...preview, action: "bound" }],
      summary: { created: 0, existing: 0, bound: 1, idempotent: 0 },
    };
  }

  // ---- mode === "create"
  const fields = requireCreateFields(create);
  const plan = normalized.map((target) => ({
    target,
    existing: bindingByTaxpayerId(target.taxpayerId),
  }));
  const results = plan.map(({ target, existing }) => ({
    candidateId: target.candidateId,
    taxpayerId: target.taxpayerId,
    name: target.name,
    action: existing ? "existing" : "create",
    accountSetId: existing ? existing.account_set_id : null,
  }));
  if (dryRun) {
    return {
      dryRun: true, results,
      summary: {
        created: results.filter((r) => r.action === "create").length,
        existing: results.filter((r) => r.action === "existing").length,
        bound: 0, idempotent: 0,
      },
    };
  }

  db.exec("BEGIN");
  try {
    for (const { target, existing } of plan) {
      if (existing) continue; // 幂等：同税号返回现有账套，不重复建、不覆盖
      const set = A.createAccountSet({
        name: target.name,
        taxpayer_type: fields.taxpayer_type,
        accounting_standard: fields.accounting_standard,
        start_period: fields.start_period,
      });
      db.prepare(
        `INSERT INTO tax_enterprise_bindings (account_set_id, taxpayer_id, region, city, source, imported_at)
         VALUES (?,?,?,?,?,?)`
      ).run(set.id, target.taxpayerId, String(region), String(city), String(source), importedAt);
      const hit = results.find((r) => r.candidateId === target.candidateId && r.action === "create");
      if (hit) { hit.action = "created"; hit.accountSetId = set.id; }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return {
    dryRun: false, results,
    summary: {
      created: results.filter((r) => r.action === "created").length,
      existing: results.filter((r) => r.action === "existing").length,
      bound: 0, idempotent: 0,
    },
    note: "新建账套仅包含企业基本档案与标准科目表；历史凭证、期初余额需另行导入，本次不生成。",
  };
}

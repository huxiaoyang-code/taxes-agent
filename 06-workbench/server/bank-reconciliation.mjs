import { assertBankPublicAdmission } from './bank-storage.mjs';
import { hasActiveAuditExecution,deferBankImportFailure,auditConnectionQuarantined } from './local-audit-storage.mjs';
import { runDomainOperation,operationErrorEvidence } from './local-audit-coordinator.mjs';
import { auditCanonicalDigest } from './local-audit.mjs';
// bank-reconciliation.mjs — LOCAL-04 银行流水落库、持久对账、人工匹配与余额调节领域逻辑。
//
// 关键边界：
// 1) 本文件不 import db.mjs / accounting.mjs：数据库连接由调用方显式注入，
//    因此导入本模块不会打开默认库、不会触发全局迁移。账务数据一律通过已核实的当前结构
//    只读查询（vouchers / voucher_entries / opening_balances / accounts / account_sets）。
// 2) 银行账户不是第二本账套：一个 bankAccountId 属于一个 accountSetId，绑定该账套内
//    一个明确、有效、可独立归属的银行存款叶子科目。首版只支持 CNY（分）。
// 3) 匹配只来自当前 posted 凭证的银行科目分录（voucher_id + entry_id + line_no），
//    草稿不参与；候选不是已匹配，任何多候选都保持人工选择。
// 4) 所有 status / query / candidates / confirm / reconcile 都重新核验已确认账务内容：
//    反过账、删除、改分录 / 日期 / 期间 / 科目 / 金额后立即失效，保存失效事件并降级状态；
//    失效后即使原样重新过账也不会自动恢复匹配。
// 5) 余额调节不生成、不修改任何账务凭证，也不改动 periods 状态。

import {
  DIRECTIONS,
  MAX_AMOUNT_CENTS,
  NORMALIZATION_VERSION,
  ENTITY_ID_RE,
  formatCents,
  isValidPeriod,
  normalizeDateText,
  previewCsvImport,
  sha256Hex,
} from "./bank-import.mjs";
import {
  appendAuditEvent,
  assertBankSchemaReady,
  bankConnectionState,
  bankError,
  bankSchemaState,
  countBatchesByStatus,
  countMatchesByStatus,
  countPendingAmbiguities,
  countPendingAmbiguitiesOnOrBefore,
  countTransactionMatchStates,
  countUnresolvedInvalidatedMatches,
  findActiveMatchForEntry,
  findActiveMatchForTransaction,
  findBatchByFile,
  findTransactionByRefId,
  getAmbiguity,
  getBankAccount,
  getBatch,
  getMatch,
  getTransaction,
  insertAmbiguity,
  insertBatch,
  insertBatchRow,
  insertMatch,
  insertReconcileRun,
  insertTransaction,
  inTransaction,
  listAllMatches,
  listAmbiguities,
  listAuditEvents,
  listBatchRows,
  listBatches,
  listConfirmedMatchSides,
  listMatches,
  listMatchesForTransactionIds,
  listPendingAmbiguitiesOnOrBefore,
  listReconcileRuns,
  listTransactions,
  listUnresolvedInvalidatedMatches,
  markBatchFailed,
  markReconcileRunsStale,
  removeFailedBatch,
  resolveAmbiguityRecord,
  updateBatch,
} from "./bank-storage.mjs";

import { inspectAuxiliarySchema } from "./auxiliary-storage.mjs";
import { entryPartyAllocation } from "./auxiliary-accounting.mjs";

/** Live display only: no party field enters matching, snapshots or invalidation. */
function entryPartyView(db, accountSetId, entryId) {
  const coreVersion = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version;
  const state = inspectAuxiliarySchema(db, coreVersion);
  if (!state.present) return { installed: false, status: "not_installed", accountSetId, entryId };
  if (state.problems.length) throw bankError("aux_structure_invalid", "辅助组件结构或版本损坏，不能展示往来分配");
  const target = db.prepare("SELECT 1 FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE e.id=? AND v.account_set_id=?").get(entryId, accountSetId);
  if (!target) return { installed: true, status: "entry_unavailable", accountSetId, entryId };
  return { installed: true, ...entryPartyAllocation(db, { accountSetId, entryId }) };
}

const MAX_CENTS = BigInt(MAX_AMOUNT_CENTS);
const BATCH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REASON_MAX = 500;

const nowIso = () => new Date().toISOString();

// ------------------------------------------------------------------ 基础校验
function positiveInt(value, code, label) {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isInteger(n) || n <= 0) throw bankError(code, `${label}必须是正整数`, { value });
  return n;
}

function requireDate(value, code = "date_invalid", label = "日期") {
  const date = normalizeDateText(value);
  if (!date) throw bankError(code, `${label}必须是真实的 YYYY-MM-DD 日期`, { value });
  return date;
}

function requireReason(value, code = "reason_required") {
  const reason = String(value ?? "").trim();
  if (!reason) throw bankError(code, "该操作必须提供明确理由");
  if (reason.length > REASON_MAX) throw bankError("reason_too_long", `理由不能超过 ${REASON_MAX} 字符`);
  return reason;
}

function boundedInt(value, min, max, code) {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isInteger(n) || n < min || n > max) {
    throw bankError(code, `数值必须是 ${min}..${max} 的整数`, { value });
  }
  return n;
}

function toInputCents(value, code) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw bankError(code, "金额必须是安全整数分", { value });
    return BigInt(value);
  }
  const text = String(value ?? "").trim();
  if (!/^-?\d+$/.test(text)) throw bankError(code, "金额必须是整数分（不允许小数文本）", { value });
  return BigInt(text);
}

/** 数据库中的 REAL 金额 -> 整数分；非精确到分时结构化拒绝，不静默四舍五入。 */
function moneyCents(value, field) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) throw bankError("money_not_finite", `账务金额不是有限数字：${field}`, { field });
  const scaled = n * 100;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-4) {
    throw bankError("money_not_integer_cents", `账务金额不是精确到分：${field}`, { field, value: n });
  }
  return BigInt(rounded);
}

function assertCentsRange(value, field) {
  const big = typeof value === "bigint" ? value : BigInt(value);
  if (big > MAX_CENTS || big < -MAX_CENTS) {
    throw bankError("amount_overflow", `金额合计超界：${field}`, { field });
  }
  return big;
}

const centsNumber = (big) => Number(assertCentsRange(big, "output"));

function sumCents(list, pick) {
  let total = 0n;
  for (const item of list) total += pick(item);
  return total;
}

function dateDiffDays(a, b) {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const left = Date.UTC(ay, am - 1, ad);
  const right = Date.UTC(by, bm - 1, bd);
  return Math.round((left - right) / 86400000);
}

function addDays(date, days) {
  const [y, m, d] = date.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d + days));
  return `${probe.getUTCFullYear()}-${String(probe.getUTCMonth() + 1).padStart(2, "0")}-${String(probe.getUTCDate()).padStart(2, "0")}`;
}

function periodOf(date) {
  return String(date ?? "").slice(0, 7);
}

function parseSnapshot(match) {
  try {
    return JSON.parse(match.snapshot_json || "{}");
  } catch {
    return {};
  }
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// ------------------------------------------------------------------ 账户 / 范围
function validateGlAccount(db, accountSetId, code) {
  const row = db.prepare(`SELECT code, name, category, direction, is_leaf
                            FROM accounts WHERE account_set_id=? AND code=?`)
    .get(accountSetId, code);
  if (!row) {
    throw bankError("bank_gl_account_not_found", `账套内不存在该科目：${code}`, { accountSetId, code });
  }
  const child = db.prepare(`SELECT COUNT(*) AS n FROM accounts
                             WHERE account_set_id=? AND code<>? AND code LIKE ?`)
    .get(accountSetId, code, `${code}%`);
  if (Number(row.is_leaf) !== 1 || Number(child.n) > 0) {
    throw bankError("bank_gl_account_not_leaf", `银行账户必须绑定叶子科目：${code}`, { code });
  }
  if (row.category !== "资产" || row.direction !== "debit") {
    throw bankError("bank_gl_account_invalid", `银行账户科目必须是资产类借方科目：${code}`, { code });
  }
  if (!(code === "1002" || code.startsWith("1002"))) {
    throw bankError("bank_gl_account_invalid", "银行账户科目必须是 1002 银行存款或其显式明细科目", { code });
  }
  return row;
}

/** 解析并核验账套 / 银行账户 / 币种范围；任何跨账套引用都在这里拒绝。 */
export function resolveBankScope(db, { accountSetId, bankAccountId, currency = null } = {}) {
  const setId = positiveInt(accountSetId, "account_set_id_invalid", "账套 ID");
  const accountSet = db.prepare(`SELECT * FROM account_sets WHERE id=?`).get(setId);
  if (!accountSet) throw bankError("account_set_not_found", `账套不存在：${setId}`, { accountSetId: setId });
  // 组件版本 / 结构契约统一门槛：未来版本、矛盾版本、缺表 / 缺列 / 主键 / UNIQUE / FK 动作损坏
  // 都在任何业务读写之前拒绝（不用 CREATE IF NOT EXISTS 修补）。
  assertBankSchemaReady(db);
  const account = getBankAccount(db, { accountSetId: setId, bankAccountId: String(bankAccountId ?? "").trim() });
  if (!account) {
    throw bankError("bank_account_not_registered", `账套 ${setId} 未登记该银行账户：${bankAccountId}`, {
      accountSetId: setId, bankAccountId,
    });
  }
  if (currency !== null && currency !== undefined) {
    const wanted = String(currency).trim().toUpperCase();
    if (wanted !== account.currency) {
      throw bankError("bank_account_currency_mismatch", `币种与登记账户不一致：请求 ${wanted} / 登记 ${account.currency}`, {
        accountCurrency: account.currency, requestedCurrency: wanted,
      });
    }
  }
  if (account.currency !== "CNY") {
    throw bankError("currency_unsupported", `本版本只支持 CNY，登记账户为 ${account.currency}`);
  }
  const glAccount = validateGlAccount(db, setId, account.gl_account_code);
  return { setId, accountSet, account, glAccount };
}

/**
 * 登记银行账户：显式 accountSetId + bankAccountId + sourceId + 银行存款叶子科目。
 * 同一账套同一叶子科目只允许绑定一个银行账户；同一 bankAccountId 的绑定不允许静默改写。
 */
function registerBankAccountBody(db, options = {}) {
  const {
    accountSetId, bankAccountId, sourceId, glAccountCode,
    currency = "CNY", displayName = "", bankAccountNo = "", actor = "local-operator",
  } = options;
  const setId = positiveInt(accountSetId, "account_set_id_invalid", "账套 ID");
  assertBankSchemaReady(db);
  if (!db.prepare(`SELECT id FROM account_sets WHERE id=?`).get(setId)) {
    throw bankError("account_set_not_found", `账套不存在：${setId}`, { accountSetId: setId });
  }
  const accountId = String(bankAccountId ?? "").trim();
  if (!ENTITY_ID_RE.test(accountId)) throw bankError("bank_account_id_invalid", "bankAccountId 格式非法");
  const source = String(sourceId ?? "").trim();
  if (!ENTITY_ID_RE.test(source)) throw bankError("source_id_invalid", "sourceId 格式非法");
  if (String(currency ?? "").trim().toUpperCase() !== "CNY") {
    throw bankError("currency_unsupported", "首版只支持人民币 CNY（分）");
  }
  const glCode = String(glAccountCode ?? "").trim();
  if (!glCode) throw bankError("gl_account_code_required", "必须显式指定绑定的银行存款叶子科目");
  validateGlAccount(db, setId, glCode);

  return inTransaction(db, () => {
    const existing = getBankAccount(db, { accountSetId: setId, bankAccountId: accountId });
    if (existing) {
      if (existing.gl_account_code !== glCode || existing.source_id !== source || existing.currency !== "CNY") {
        throw bankError("bank_account_conflict", "同一 bankAccountId 已登记为不同绑定，拒绝静默改写", {
          existing: {
            glAccountCode: existing.gl_account_code,
            sourceId: existing.source_id,
            currency: existing.currency,
          },
        });
      }
      return { created: false, account: existing };
    }
    const bound = db.prepare(`SELECT bank_account_id FROM bank_accounts
                               WHERE account_set_id=? AND gl_account_code=?`).get(setId, glCode);
    if (bound) {
      throw bankError("bank_gl_account_already_bound",
        "该银行存款科目已绑定另一个银行账户；首版没有可靠辅助维度，拒绝把同科目多账户混为一谈", {
          glAccountCode: glCode, boundBankAccountId: bound.bank_account_id,
        });
    }
    const info = db.prepare(`INSERT INTO bank_accounts
                  (account_set_id, bank_account_id, source_id, currency, gl_account_code,
                   display_name, bank_account_no, created_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(setId, accountId, source, "CNY", glCode, String(displayName ?? ""), String(bankAccountNo ?? ""), nowIso());
    void info;
    const account = getBankAccount(db, { accountSetId: setId, bankAccountId: accountId });
    appendAuditEvent(db, {
      accountSetId: setId,
      bankAccountId: accountId,
      eventType: "bank_account_registered",
      subjectType: "bank_account",
      subjectId: accountId,
      detail: { glAccountCode: glCode, sourceId: source, currency: "CNY", displayName, bankAccountNo, actor },
    });
    return { created: true, account };
  });
}

// ------------------------------------------------------------------ 预检 / 导入
export function previewBankImport(db, options = {}) {
  const { accountSetId, bankAccountId, sourceId, period, csvText, mapping } = options;
  const scope = resolveBankScope(db, { accountSetId, bankAccountId });
  const source = String(sourceId ?? "").trim();
  if (!ENTITY_ID_RE.test(source)) throw bankError("source_id_invalid", "sourceId 格式非法");
  if (!isValidPeriod(period)) throw bankError("period_invalid", "必须显式提供账务期间 YYYY-MM");
  if (String(period) < scope.accountSet.start_period) {
    throw bankError("period_before_start", "导入期间早于账套启用期间", {
      period, startPeriod: scope.accountSet.start_period,
    });
  }
  const preview = previewCsvImport({ csvText, mapping, period });
  return {
    scope: scopeSummary(scope),
    sourceId: source,
    period,
    preview,
  };
}

function scopeSummary(scope) {
  return {
    accountSetId: scope.setId,
    accountSetName: scope.accountSet.name,
    accountSetStartPeriod: scope.accountSet.start_period,
    bankAccountId: scope.account.bank_account_id,
    currency: scope.account.currency,
    glAccountCode: scope.account.gl_account_code,
    glAccountName: scope.glAccount.name,
    registeredSourceId: scope.account.source_id,
  };
}

/**
 * 执行一批银行流水导入（单事务）。
 *
 * 幂等与冲突：
 *  - 同一 batchId + 同文件摘要 + 同映射 + 同期间：直接回放，不新增流水；改内容 / 映射 / 期间 → batch_content_conflict。
 *  - 同文件（同内容摘要 + 同映射）用另一个 batchId 再导入：识别为已完成来源，新建批次到既有流水的逐行追踪，
 *    不新增流水。
 *  - 有稳定银行流水 ID：按 账套+账户+来源+ID 去重；同 ID 同规范内容复用，改内容结构化冲突。
 *  - 无稳定 ID：只按行指纹作为疑似重复信号；与既有流水同特征的行保存为待人工判定的歧义记录，
 *    不进入已确认流水；同一文件内的相同记录按来源行证据各自保留。
 */
function importBankBatchBody(db, options = {}) {
  const {
    accountSetId, bankAccountId, sourceId, batchId, period, csvText, mapping,
  } = options;
  const scope = resolveBankScope(db, { accountSetId, bankAccountId });
  const setId = scope.setId;
  const source = String(sourceId ?? "").trim();
  const batch = String(batchId ?? "").trim();
  if (!ENTITY_ID_RE.test(source)) throw bankError("source_id_invalid", "sourceId 格式非法");
  if (!BATCH_ID_RE.test(batch)) throw bankError("batch_id_invalid", "batchId 格式非法（字母数字开头，允许 . _ : -）");
  if (!isValidPeriod(period)) throw bankError("period_invalid", "必须显式提供账务期间 YYYY-MM");
  if (String(period) < scope.accountSet.start_period) {
    throw bankError("period_before_start", "导入期间早于账套启用期间", {
      period, startPeriod: scope.accountSet.start_period,
    });
  }

  const preview = previewCsvImport({ csvText, mapping, period });
  const fileDigest = preview.fileDigest ?? sha256Hex(String(csvText ?? ""));
  const mappingFingerprint = preview.mappingFingerprint ?? sha256Hex("invalid-mapping");
  const normalizationVersion = preview.normalizationVersion ?? NORMALIZATION_VERSION;

  if (!preview.ok) {
    throw bankError("import_rejected", "预检未通过，未写入任何流水", {
      stage: preview.stage,
      errorCount: preview.stats.errorCount,
      errors: preview.errors.slice(0, 50),
      errorsTruncated: preview.errorsTruncated || preview.errors.length > 50,
    });
  }

  try {
    return inTransaction(db, () => {
      const current = resolveBankScope(db, { accountSetId: setId, bankAccountId: scope.account.bank_account_id });
      let existingBatch = getBatch(db, { accountSetId: setId, bankAccountId: scope.account.bank_account_id, batchId: batch });
      let priorAttempts = 1;
      if (existingBatch) {
        const sameIdentity = existingBatch.content_sha256 === fileDigest
          && existingBatch.mapping_fingerprint === mappingFingerprint
          && existingBatch.period === period
          && existingBatch.source_id === source;
        if (!sameIdentity) {
          if (existingBatch.status !== "failed") {
            throw bankError("batch_content_conflict",
              "同一批次 ID 已存在且文件内容 / 映射 / 期间 / 来源不一致，拒绝覆盖", {
                batchId: batch,
                existing: {
                  contentSha256: existingBatch.content_sha256,
                  mappingFingerprint: existingBatch.mapping_fingerprint,
                  period: existingBatch.period,
                  sourceId: existingBatch.source_id,
                  status: existingBatch.status,
                },
                incoming: { contentSha256: fileDigest, mappingFingerprint, period, sourceId: source },
              });
          }
          // 失败批次没有留下任何业务数据（业务事务已整体回滚），允许修正后重试；保留尝试次数。
          priorAttempts = Number(existingBatch.attempts) + 1;
          if (!removeFailedBatch(db, {
            accountSetId: setId, bankAccountId: scope.account.bank_account_id, batchId: batch,
          })) {
            throw bankError("batch_content_conflict", "失败批次状态已变化，拒绝覆盖", { batchId: batch });
          }
          existingBatch = null;
        } else if (existingBatch.status === "completed" || existingBatch.status === "pending_review") {
          return {
            replay: true,
            replayKind: existingBatch.status === "completed" ? "same-batch" : "same-batch-pending",
            batch: batchView(db, existingBatch),
            rows: listBatchRows(db, { accountSetId: setId, bankAccountId: existingBatch.bank_account_id, batchId: batch }),
          };
        } else {
          priorAttempts = Number(existingBatch.attempts) + 1;
        }
      }

      // ---- 同文件（内容摘要 + 映射）换新 batchId：识别为已完成来源，不新增流水 ----
      const earlier = findBatchByFile(db, {
        accountSetId: setId,
        bankAccountId: scope.account.bank_account_id,
        sourceId: source,
        contentSha256: fileDigest,
        mappingFingerprint,
      });
      if (earlier && earlier.batch_id !== batch) {
        return replayFileBatch(db, {
          scope: current, earlier, batchId: batch, period, mappingFingerprint, normalizationVersion,
          preview, existingBatch, priorAttempts,
        });
      }

      // ---- 正常导入 ----
      if (!existingBatch) {
        insertBatch(db, {
          accountSetId: setId, bankAccountId: scope.account.bank_account_id, sourceId: source,
          batchId: batch, currency: "CNY", period, contentSha256: fileDigest,
          mappingFingerprint, normalizationVersion, status: "pending", attempts: priorAttempts,
        });
      }
      const priorMap = new Map();
      const priorRows = db.prepare(`SELECT id, row_fingerprint FROM bank_transactions
                                     WHERE account_set_id=? AND bank_account_id=? AND source_id=?
                                     ORDER BY id`)
        .all(setId, scope.account.bank_account_id, source);
      for (const row of priorRows) {
        const list = priorMap.get(row.row_fingerprint) ?? [];
        list.push(Number(row.id));
        priorMap.set(row.row_fingerprint, list);
      }

      let importedRows = 0;
      let reusedRows = 0;
      let ambiguousRows = 0;
      const created = [];
      for (const row of preview.rows) {
        const rowSha = sha256Hex(`${fileDigest}:${row.rowNumber}:${row.contentFingerprint}`);
        if (row.refId) {
          const existingTxn = findTransactionByRefId(db, {
            accountSetId: setId, bankAccountId: scope.account.bank_account_id, sourceId: source, bankRefId: row.refId,
          });
          if (existingTxn) {
            if (existingTxn.content_fingerprint !== row.contentFingerprint) {
              throw bankError("source_transaction_content_changed",
                "同一银行稳定流水 ID 的规范内容发生变化，拒绝覆盖既有流水", {
                  rowNumber: row.rowNumber,
                  refId: row.refId,
                  existing: {
                    transactionId: Number(existingTxn.id),
                    date: existingTxn.txn_date,
                    direction: existingTxn.direction,
                    amountCents: Number(existingTxn.amount_cents),
                    summary: existingTxn.summary,
                  },
                  incoming: {
                    date: row.date,
                    direction: row.direction,
                    amountCents: row.amountCents,
                    summary: row.summary,
                  },
                });
            }
            insertBatchRow(db, {
              accountSetId: setId, bankAccountId: scope.account.bank_account_id, batchId: batch,
              rowIndex: row.rowNumber, rowSha256: rowSha, rowFingerprint: row.rowFingerprint,
              status: "duplicate_reused", transactionId: Number(existingTxn.id), note: `ref:${row.refId}`,
            });
            reusedRows += 1;
            continue;
          }
          const txn = insertTransaction(db, {
            accountSetId: setId, bankAccountId: scope.account.bank_account_id, sourceId: source,
            currency: "CNY", txnDate: row.date, period, direction: row.direction,
            amountCents: row.amountCents, summary: row.summary, bankRefId: row.refId,
            balanceAfterCents: row.balanceCents, contentFingerprint: row.contentFingerprint,
            rowFingerprint: row.rowFingerprint, batchId: batch, rowIndex: row.rowNumber, origin: "imported",
          });
          insertBatchRow(db, {
            accountSetId: setId, bankAccountId: scope.account.bank_account_id, batchId: batch,
            rowIndex: row.rowNumber, rowSha256: rowSha, rowFingerprint: row.rowFingerprint,
            status: "imported", transactionId: Number(txn.id), note: `ref:${row.refId}`,
          });
          importedRows += 1;
          created.push(Number(txn.id));
          continue;
        }

        // 无稳定 ID：只把「本批次之前就存在」的同特征流水视为疑似重复。
        const prior = priorMap.get(row.rowFingerprint) ?? [];
        if (prior.length) {
          const ambiguity = insertAmbiguity(db, {
            accountSetId: setId, bankAccountId: scope.account.bank_account_id, sourceId: source,
            batchId: batch, rowIndex: row.rowNumber, txnDate: row.date, period,
            direction: row.direction, amountCents: row.amountCents, summary: row.summary,
            currency: "CNY", rowFingerprint: row.rowFingerprint,
            contentFingerprint: row.contentFingerprint, batchRowSha256: rowSha,
            candidateTransactionIds: prior.slice(0, 50),
          });
          insertBatchRow(db, {
            accountSetId: setId, bankAccountId: scope.account.bank_account_id, batchId: batch,
            rowIndex: row.rowNumber, rowSha256: rowSha, rowFingerprint: row.rowFingerprint,
            status: "ambiguity_pending", ambiguityId: Number(ambiguity.id),
            note: "no-stable-bank-ref-id:suspected-duplicate",
          });
          ambiguousRows += 1;
          continue;
        }
        const txn = insertTransaction(db, {
          accountSetId: setId, bankAccountId: scope.account.bank_account_id, sourceId: source,
          currency: "CNY", txnDate: row.date, period, direction: row.direction,
          amountCents: row.amountCents, summary: row.summary, bankRefId: null,
          balanceAfterCents: row.balanceCents, contentFingerprint: row.contentFingerprint,
          rowFingerprint: row.rowFingerprint, batchId: batch, rowIndex: row.rowNumber, origin: "imported",
        });
        insertBatchRow(db, {
          accountSetId: setId, bankAccountId: scope.account.bank_account_id, batchId: batch,
          rowIndex: row.rowNumber, rowSha256: rowSha, rowFingerprint: row.rowFingerprint,
          status: "imported", transactionId: Number(txn.id), note: "no-stable-bank-ref-id",
        });
        importedRows += 1;
        created.push(Number(txn.id));
      }

      const status = ambiguousRows > 0 ? "pending_review" : "completed";
      const updated = updateBatch(db, {
        accountSetId: setId, bankAccountId: scope.account.bank_account_id, batchId: batch,
        status, rowCount: preview.rows.length, importedRows, reusedRows, ambiguousRows,
        attempts: existingBatch ? priorAttempts : null,
        result: {
          fileDigest,
          mappingFingerprint,
          normalizationVersion,
          sourceId: source,
          period,
          importedRows,
          reusedRows,
          ambiguousRows,
          transactionIds: created,
          noNewTransactions: false,
        },
      });
      appendAuditEvent(db, {
        accountSetId: setId,
        bankAccountId: scope.account.bank_account_id,
        eventType: status === "completed" ? "import_completed" : "import_pending_review",
        subjectType: "bank_batch",
        subjectId: batch,
        detail: {
          sourceId: source, period, rowCount: preview.rows.length, importedRows, reusedRows,
          ambiguousRows, fileDigest, mappingFingerprint,
        },
      });
      return {
        replay: false,
        batch: batchView(db, updated),
        rows: listBatchRows(db, { accountSetId: setId, bankAccountId: scope.account.bank_account_id, batchId: batch }),
        transactionIds: created,
      };
    });
  } catch (e) {
    // 只有「银行可自行开事务并确认回滚」的连接才能继续在独立事务里写失败审计：
    // 回滚未确认 / 状态未知时不得假称「失败已留痕」；调用方事务仍在进行时也不能把审计写进去
    //（那会跟调用方事务一起被提交 / 回滚，属于「误写 + 虚称已记录」），且不在那层事务里再开事务。
    if(hasActiveAuditExecution(db)) {
      deferBankImportFailure(db,e,{accountSetId:setId,bankAccountId:scope.account.bank_account_id,batchId:batch,sourceId:source,currency:'CNY',period,contentSha256:fileDigest,mappingFingerprint,normalizationVersion,errorCode:e.code??'import_failed',errorMessage:e.message});
      e.auditRecorded=false;throw e;
    }
    const connection = bankConnectionState(db);
    if (!connection.writable) {
      e.auditRecorded = false;
      e.auditFailure = connection.externalTransaction
        ? "调用方事务仍在进行（银行未启动自己的事务），本次失败审计未写入；请由调用方提交或回滚自己的事务后再重试"
        : "连接事务状态未确认（回滚失败），本次失败审计未写入；需先恢复或丢弃连接";
      throw e;
    }
    // 业务事务已确认回滚；失败审计在独立事务里写，写入失败也如实返回。
    const failure = {
      accountSetId: setId, bankAccountId: scope.account.bank_account_id, batchId: batch, sourceId: source,
      currency: "CNY", period, contentSha256: fileDigest, mappingFingerprint,
      normalizationVersion, errorCode: e.code ?? "import_failed", errorMessage: e.message,
    };
    if (!e.auditRecorded) {
      try {
        inTransaction(db, () => markBatchFailed(db, failure));
        e.auditRecorded = true;
      } catch (auditErr) {
        e.auditRecorded = false;
        // 固定措辞 + 可选稳定错误码，不回显原始 SQL / 驱动文本 / 路径。
        const auditCode = typeof auditErr?.code === "string" && /^[a-z][a-z0-9_]{2,60}$/i.test(auditErr.code)
          ? auditErr.code : null;
        e.auditFailure = auditCode
          ? `失败审计未能写入（${auditCode}）`
          : "失败审计未能写入（已如实返回）";
      }
    }
    throw e;
  }
}

function replayFileBatch(db, {
  scope, earlier, batchId, period, mappingFingerprint, normalizationVersion, preview,
  existingBatch = null, priorAttempts = 1,
}) {
  const setId = scope.setId;
  const accountId = scope.account.bank_account_id;
  const earlierRows = listBatchRows(db, { accountSetId: setId, bankAccountId: accountId, batchId: earlier.batch_id });
  if (earlierRows.length !== preview.rows.length) {
    throw bankError("replay_row_mismatch",
      "同内容文件的历史批次行数与当前规范化行数不一致，拒绝回放", {
        earlierBatchId: earlier.batch_id,
        earlierRows: earlierRows.length,
        incomingRows: preview.rows.length,
      });
  }
  if (existingBatch) {
    // 只有失败批次会走到这里（已完成 / 待判定批次在上层直接回放）。
    if (!removeFailedBatch(db, { accountSetId: setId, bankAccountId: accountId, batchId })) {
      throw bankError("batch_content_conflict", "失败批次状态已变化，拒绝覆盖", { batchId });
    }
  }
  insertBatch(db, {
    accountSetId: setId, bankAccountId: accountId, sourceId: earlier.source_id, batchId,
    currency: "CNY", period, contentSha256: preview.fileDigest,
    mappingFingerprint, normalizationVersion, status: "pending",
    result: { replayOfBatchId: earlier.batch_id }, attempts: priorAttempts,
  });
  let reusedRows = 0;
  let ambiguousRows = 0;
  for (let i = 0; i < preview.rows.length; i += 1) {
    const row = preview.rows[i];
    const priorRow = earlierRows[i];
    if (Number(priorRow.row_index) !== row.rowNumber) {
      throw bankError("replay_row_mismatch", "同内容文件的行顺序与历史批次不一致，拒绝回放", {
        earlierBatchId: earlier.batch_id, expectedRowIndex: priorRow.row_index, actualRowIndex: row.rowNumber,
      });
    }
    insertBatchRow(db, {
      accountSetId: setId, bankAccountId: accountId, batchId, rowIndex: row.rowNumber,
      rowSha256: sha256Hex(`${preview.fileDigest}:${row.rowNumber}:${row.contentFingerprint}`),
      rowFingerprint: row.rowFingerprint,
      status: "replayed",
      transactionId: priorRow.transaction_id === null ? null : Number(priorRow.transaction_id),
      ambiguityId: priorRow.ambiguity_id === null ? null : Number(priorRow.ambiguity_id),
      note: `replay:${earlier.batch_id}`,
    });
    if (priorRow.status === "ambiguity_pending" || priorRow.status === "ambiguity_resolved_same"
      || priorRow.status === "ambiguity_resolved_distinct") {
      ambiguousRows += 1;
    } else {
      reusedRows += 1;
    }
  }
  const status = earlier.status === "pending_review" ? "pending_review" : "completed";
  const updated = updateBatch(db, {
    accountSetId: setId, bankAccountId: accountId, batchId,
    status, rowCount: preview.rows.length, importedRows: 0, reusedRows, ambiguousRows,
    attempts: existingBatch ? priorAttempts : null,
    result: {
      replayOfBatchId: earlier.batch_id,
      fileDigest: preview.fileDigest,
      mappingFingerprint,
      normalizationVersion,
      noNewTransactions: true,
      reusedRows,
      ambiguousRows,
    },
    replayOfBatch: earlier.batch_id,
  });
  appendAuditEvent(db, {
    accountSetId: setId,
    bankAccountId: accountId,
    eventType: "import_file_replay",
    subjectType: "bank_batch",
    subjectId: batchId,
    detail: { replayOfBatchId: earlier.batch_id, rowCount: preview.rows.length, fileDigest: preview.fileDigest },
  });
  return {
    replay: true,
    replayKind: "same-file-new-batch",
    replayOfBatchId: earlier.batch_id,
    batch: batchView(db, updated),
    rows: listBatchRows(db, { accountSetId: setId, bankAccountId: accountId, batchId }),
  };
}

function batchView(db, batch) {
  if (!batch) return null;
  return {
    accountSetId: Number(batch.account_set_id),
    bankAccountId: batch.bank_account_id,
    batchId: batch.batch_id,
    sourceId: batch.source_id,
    currency: batch.currency,
    period: batch.period,
    status: batch.status,
    rowCount: Number(batch.row_count),
    importedRows: Number(batch.imported_rows),
    reusedRows: Number(batch.reused_rows),
    ambiguousRows: Number(batch.ambiguous_rows),
    pendingAmbiguities: countPendingAmbiguities(db, {
      accountSetId: Number(batch.account_set_id),
      bankAccountId: batch.bank_account_id,
      batchId: batch.batch_id,
    }),
    attempts: Number(batch.attempts),
    replayOfBatch: batch.replay_of_batch ?? null,
    contentSha256: batch.content_sha256,
    mappingFingerprint: batch.mapping_fingerprint,
    normalizationVersion: batch.normalization_version,
    result: parseJson(batch.result_json, {}),
    errorCode: batch.error_code ?? null,
    errorMessage: batch.error_message ?? null,
    createdAt: batch.created_at,
    updatedAt: batch.updated_at,
  };
}

export function listBatchesView(db, options = {}) {
  const scope = resolveBankScope(db, options);
  return listBatches(db, {
    accountSetId: scope.setId, bankAccountId: scope.account.bank_account_id,
    limit: options.limit ?? 200,
  }).map((b) => batchView(db, b));
}

// ------------------------------------------------------------------ 查询视图
function txnView(txn, match = null) {
  return {
    transactionId: Number(txn.id),
    accountSetId: Number(txn.account_set_id),
    bankAccountId: txn.bank_account_id,
    sourceId: txn.source_id,
    currency: txn.currency,
    date: txn.txn_date,
    period: txn.period,
    direction: txn.direction,
    amountCents: Number(txn.amount_cents),
    amountText: formatCents(txn.amount_cents),
    summary: txn.summary,
    bankRefId: txn.bank_ref_id ?? null,
    balanceAfterCents: txn.balance_after_cents === null ? null : Number(txn.balance_after_cents),
    batchId: txn.batch_id,
    rowIndex: Number(txn.row_index),
    origin: txn.origin,
    matchId: match ? Number(match.id) : null,
    matchStatus: match ? match.status : "unmatched",
  };
}

/**
 * 流水查询：先核验该范围内已确认匹配的当前有效性（失效则保存事件并降级），再返回视图。
 */
function listTransactionsViewBody(db, options = {}) {
  const scope = resolveBankScope(db, options);
  const refresh = refreshMatchStatesBody(db, {
    accountSetId: scope.setId,
    bankAccountId: scope.account.bank_account_id,
    persist: options.persistInvalidations !== false,
  });
  const from = options.from ? requireDate(options.from, "date_from_invalid", "起始日期") : null;
  const to = options.to ? requireDate(options.to, "date_to_invalid", "截止日期") : null;
  if (from && to && from > to) throw bankError("date_window_invalid", "起始日期不能晚于截止日期");
  const rows = listTransactions(db, {
    accountSetId: scope.setId,
    bankAccountId: scope.account.bank_account_id,
    from,
    to,
    limit: options.limit ?? 500,
  });
  // 只按当前页的流水 ID 取有效匹配：既不漏（不是先取一页匹配再过滤），也不依赖总匹配数。
  const matches = listMatchesForTransactionIds(db, {
    accountSetId: scope.setId,
    bankAccountId: scope.account.bank_account_id,
    transactionIds: rows.map((r) => Number(r.id)),
  });
  const byTxn = new Map(matches.map((m) => [Number(m.transaction_id), m]));
  const items = rows.map((txn) => txnView(txn, byTxn.get(Number(txn.id)) ?? null));
  const filtered = options.status === "matched"
    ? items.filter((i) => i.matchId !== null)
    : options.status === "unmatched"
      ? items.filter((i) => i.matchId === null)
      : items;
  const inflow = sumCents(filtered.filter((i) => i.direction === DIRECTIONS.INFLOW), (i) => BigInt(i.amountCents));
  const outflow = sumCents(filtered.filter((i) => i.direction === DIRECTIONS.OUTFLOW), (i) => BigInt(i.amountCents));
  return {
    scope: scopeSummary(scope),
    from,
    to,
    status: options.status ?? "all",
    transactions: filtered,
    totals: {
      count: filtered.length,
      matched: filtered.filter((i) => i.matchId !== null).length,
      unmatched: filtered.filter((i) => i.matchId === null).length,
      inflowCents: centsNumber(inflow),
      outflowCents: centsNumber(outflow),
      inflowText: formatCents(inflow),
      outflowText: formatCents(outflow),
    },
    invalidations: refresh.invalidated,
  };
}

// ------------------------------------------------------------------ 匹配有效性
/** 逐条核验已确认匹配与当前账务是否一致；不一致返回结构化失效原因。 */
export function evaluateMatch(db, match) {
  const snapshot = parseSnapshot(match);
  const txn = match.transaction_id === null || match.transaction_id === undefined
    ? null
    : db.prepare(`SELECT * FROM bank_transactions WHERE id=?`).get(Number(match.transaction_id));
  if (!txn) return { ok: false, reason: "bank_transaction_missing", details: {} };
  if (Number(txn.account_set_id) !== Number(match.account_set_id)
    || txn.bank_account_id !== match.bank_account_id) {
    return { ok: false, reason: "bank_transaction_scope_changed", details: {} };
  }
  if (txn.content_fingerprint !== snapshot.transactionFingerprint) {
    return { ok: false, reason: "bank_transaction_changed", details: {} };
  }
  const row = db.prepare(`SELECT v.id voucher_id, v.account_set_id, v.period, v.voucher_date, v.status,
                                 v.word, v.number,
                                 e.id entry_id, e.line_no, e.code, e.debit, e.credit, e.summary
                            FROM vouchers v
                            LEFT JOIN voucher_entries e ON e.voucher_id = v.id AND e.id = ?
                           WHERE v.id = ?`)
    .get(Number(match.entry_id), Number(match.voucher_id));
  if (!row) return { ok: false, reason: "voucher_missing", details: { voucherId: Number(match.voucher_id) } };
  if (Number(row.account_set_id) !== Number(match.account_set_id)) {
    return { ok: false, reason: "account_set_mismatch", details: { voucherId: Number(row.voucher_id) } };
  }
  if (row.status !== "posted") {
    return { ok: false, reason: "voucher_unposted", details: { voucherId: Number(row.voucher_id), status: row.status } };
  }
  if (row.entry_id === null || row.entry_id === undefined) {
    return { ok: false, reason: "voucher_entry_missing", details: { voucherId: Number(row.voucher_id), entryId: Number(match.entry_id) } };
  }
  if (row.code !== snapshot.code || Number(row.entry_id) !== Number(snapshot.entryId)) {
    return {
      ok: false, reason: "entry_account_changed",
      details: { entryId: Number(row.entry_id), expectedCode: snapshot.code, actualCode: row.code },
    };
  }
  if (Number(row.line_no) !== Number(snapshot.lineNo)) {
    return {
      ok: false, reason: "entry_line_changed",
      details: { entryId: Number(row.entry_id), expectedLineNo: Number(snapshot.lineNo), actualLineNo: Number(row.line_no) },
    };
  }
  let debitCents;
  let creditCents;
  try {
    debitCents = moneyCents(row.debit, "voucher_entries.debit");
    creditCents = moneyCents(row.credit, "voucher_entries.credit");
  } catch (e) {
    return { ok: false, reason: "entry_amount_unreadable", details: { entryId: Number(row.entry_id), errorCode: e.code ?? null } };
  }
  if (debitCents !== BigInt(snapshot.debitCents) || creditCents !== BigInt(snapshot.creditCents)) {
    return {
      ok: false, reason: "entry_amount_changed",
      details: {
        entryId: Number(row.entry_id),
        expected: { debitCents: Number(snapshot.debitCents), creditCents: Number(snapshot.creditCents) },
        actual: { debitCents: centsNumber(debitCents), creditCents: centsNumber(creditCents) },
      },
    };
  }
  if (String(row.voucher_date) !== String(snapshot.voucherDate)) {
    return {
      ok: false, reason: "voucher_date_changed",
      details: { voucherId: Number(row.voucher_id), expectedDate: snapshot.voucherDate, actualDate: row.voucher_date },
    };
  }
  if (String(row.period) !== String(snapshot.period)) {
    return {
      ok: false, reason: "voucher_period_changed",
      details: { voucherId: Number(row.voucher_id), expectedPeriod: snapshot.period, actualPeriod: row.period },
    };
  }
  if (String(row.period) !== periodOf(row.voucher_date)) {
    return {
      ok: false, reason: "voucher_period_date_mismatch",
      details: { voucherId: Number(row.voucher_id), period: row.period, voucherDate: row.voucher_date },
    };
  }
  return { ok: true, reason: null };
}

/**
 * 重新核验范围内所有已确认匹配的当前有效性。
 * 失效时事务性保存匹配状态与审计事件（只写一次，不重复刷审计），并把旧的对账运行记录标记 stale。
 */
function refreshMatchStatesBody(db, { accountSetId, bankAccountId, persist = true } = {}) {
  const scope = resolveBankScope(db, { accountSetId, bankAccountId });
  // 内部完整判定：必须核验**全部**有效匹配，展示分页（默认 500）不得截断核验范围。
  const confirmed = listAllMatches(db, {
    accountSetId: scope.setId, bankAccountId: scope.account.bank_account_id, statuses: ["confirmed"],
  });
  const invalidated = [];
  for (const match of confirmed) {
    const check = evaluateMatch(db, match);
    if (check.ok) continue;
    invalidated.push({ matchId: Number(match.id), reason: check.reason, details: check.details });
    if (!persist) continue;
    inTransaction(db, () => {
      const current = getMatch(db, {
        accountSetId: scope.setId, bankAccountId: scope.account.bank_account_id, matchId: Number(match.id),
      });
      if (!current || current.status !== "confirmed") return; // 已被其他调用处理，不重复写审计
      const info = db.prepare(`UPDATE bank_matches
                                  SET status='invalidated', invalidated_at=?, invalidation_reason=?
                                WHERE id=? AND status='confirmed'`)
        .run(nowIso(), check.reason, Number(match.id));
      if (Number(info.changes || 0) === 0) return;
      appendAuditEvent(db, {
        accountSetId: scope.setId,
        bankAccountId: scope.account.bank_account_id,
        eventType: "match_invalidated",
        subjectType: "bank_match",
        subjectId: String(match.id),
        detail: {
          reason: check.reason,
          details: check.details,
          transactionId: match.transaction_id === null ? null : Number(match.transaction_id),
          voucherId: Number(match.voucher_id),
          entryId: Number(match.entry_id),
        },
      });
      markReconcileRunsStale(db, {
        accountSetId: scope.setId,
        bankAccountId: scope.account.bank_account_id,
        reason: `match_invalidated:${check.reason}`,
      });
    });
  }
  return { checked: confirmed.length, invalidated };
}

// ------------------------------------------------------------------ 候选
const MAX_TOLERANCE_DAYS = 31;

/**
 * 列出某条银行流水的候选账务分录（只读；候选不是已匹配）。
 * 候选来自同一库内当前 posted 凭证的银行科目分录，日期窗口显式且有限（默认同日）。
 */
function listCandidatesBody(db, options = {}) {
  const scope = resolveBankScope(db, options);
  const transactionId = positiveInt(options.transactionId, "transaction_id_invalid", "流水 ID");
  refreshMatchStatesBody(db, { accountSetId: scope.setId, bankAccountId: scope.account.bank_account_id });
  const txn = getTransaction(db, {
    accountSetId: scope.setId, bankAccountId: scope.account.bank_account_id, transactionId,
  });
  if (!txn) throw bankError("bank_transaction_not_found", `银行流水不存在：${transactionId}`, { transactionId });
  const tolerance = boundedInt(options.dateToleranceDays ?? 0, 0, MAX_TOLERANCE_DAYS, "date_tolerance_invalid");
  const txnDate = String(txn.txn_date);
  // 默认窗口 = 同日；显式给出偏差时默认窗口随之对称扩展（仍然有限）。
  const from = options.from
    ? requireDate(options.from, "date_from_invalid", "起始日期")
    : addDays(txnDate, -tolerance);
  const to = options.to
    ? requireDate(options.to, "date_to_invalid", "截止日期")
    : addDays(txnDate, tolerance);
  if (from > to) throw bankError("date_window_invalid", "起始日期不能晚于截止日期");
  const minDate = addDays(txnDate, -tolerance);
  const maxDate = addDays(txnDate, tolerance);
  if (from < minDate || to > maxDate) {
    throw bankError("date_window_too_wide", `日期窗口必须在流水日期 ±${tolerance} 天内`, {
      txnDate, minDate, maxDate, from, to, dateToleranceDays: tolerance,
    });
  }
  if (options.period !== undefined && options.period !== null && String(options.period) !== "") {
    if (!isValidPeriod(options.period)) throw bankError("period_invalid", "账务期间必须是 YYYY-MM");
  }
  const period = options.period ? String(options.period) : null;

  const activeTxnMatch = findActiveMatchForTransaction(db, {
    accountSetId: scope.setId, bankAccountId: scope.account.bank_account_id, transactionId,
  });

  // 候选占用逐行按分录直接查当前有效匹配：不先取一页匹配再判断占用，确保超过一页后仍正确标记 available=false。
  const claimForEntry = (entryId) => findActiveMatchForEntry(db, { accountSetId: scope.setId, entryId });

  const sql = `SELECT v.id AS voucher_id, v.period, v.voucher_date, v.word, v.number, v.status,
                      v.summary AS voucher_summary,
                      e.id AS entry_id, e.line_no, e.code, e.debit, e.credit, e.summary AS entry_summary
                 FROM vouchers v
                 JOIN voucher_entries e ON e.voucher_id = v.id
                WHERE v.account_set_id=? AND v.status='posted' AND e.code=?
                  AND v.voucher_date BETWEEN ? AND ?
                  ${period ? "AND v.period=?" : ""}
                ORDER BY v.voucher_date, v.id, e.line_no`;
  const args = [scope.setId, scope.account.gl_account_code, from, to];
  if (period) args.push(period);
  const rows = db.prepare(sql).all(...args);

  const candidates = [];
  const skipped = [];
  const sameDirection = [];
  for (const row of rows) {
    let debitCents;
    let creditCents;
    try {
      debitCents = moneyCents(row.debit, "voucher_entries.debit");
      creditCents = moneyCents(row.credit, "voucher_entries.credit");
    } catch (e) {
      skipped.push({
        voucherId: Number(row.voucher_id), entryId: Number(row.entry_id),
        code: e.code ?? "entry_amount_unreadable",
      });
      continue;
    }
    const direction = debitCents > 0n && creditCents === 0n
      ? DIRECTIONS.INFLOW
      : creditCents > 0n && debitCents === 0n
        ? DIRECTIONS.OUTFLOW
        : null;
    const amount = direction === DIRECTIONS.INFLOW ? debitCents : creditCents;
    const claim = claimForEntry(Number(row.entry_id));
    const item = {
      voucherId: Number(row.voucher_id),
      entryId: Number(row.entry_id),
      partyAllocation: entryPartyView(db, scope.setId, Number(row.entry_id)),
      lineNo: Number(row.line_no),
      period: row.period,
      voucherDate: row.voucher_date,
      word: row.word,
      number: Number(row.number),
      code: row.code,
      direction,
      amountCents: direction ? centsNumber(amount) : null,
      amountText: direction ? formatCents(amount) : null,
      summary: row.entry_summary || row.voucher_summary || "",
      available: !claim,
      claimedByMatchId: claim ? Number(claim.id) : null,
      periodDateConsistent: String(row.period) === periodOf(row.voucher_date),
    };
    if (!direction) {
      skipped.push({ voucherId: Number(row.voucher_id), entryId: Number(row.entry_id), code: "entry_amount_ambiguous" });
      continue;
    }
    if (!item.periodDateConsistent) {
      skipped.push({ voucherId: Number(row.voucher_id), entryId: Number(row.entry_id), code: "voucher_period_date_mismatch" });
      continue;
    }
    if (direction !== txn.direction) continue;
    if (amount !== BigInt(txn.amount_cents)) {
      sameDirection.push(item);
      continue;
    }
    candidates.push(item);
  }

  let selection;
  if (activeTxnMatch) selection = "already_matched";
  else if (candidates.length === 1) selection = "single";
  else if (candidates.length > 1) selection = "requires_manual_choice";
  else selection = "none";

  // 组匹配仅做提示，绝不自动组合或占用：明确标记为未实现。
  let groupMatch = { supported: false, code: null, pairs: [] };
  if (!candidates.length && !activeTxnMatch) {
    const pool = sameDirection.filter((c) => c.available);
    const pairs = [];
    if (pool.length >= 2 && pool.length <= 16) {
      for (let i = 0; i < pool.length; i += 1) {
        for (let j = i + 1; j < pool.length; j += 1) {
          if (BigInt(pool[i].amountCents) + BigInt(pool[j].amountCents) === BigInt(txn.amount_cents)) {
            pairs.push([pool[i].entryId, pool[j].entryId]);
          }
        }
      }
    }
    groupMatch = {
      supported: false,
      code: pairs.length ? "group_match_requires_manual" : "unsupported_group_match",
      pairs,
      note: "一对多 / 多对一自动组匹配尚未实现；不会自动占用任何分录，请人工处理。",
    };
  }

  return {
    scope: scopeSummary(scope),
    transaction: txnView(txn, activeTxnMatch),
    window: { from, to, dateToleranceDays: tolerance, period },
    candidates,
    skipped,
    selection,
    activeMatchId: activeTxnMatch ? Number(activeTxnMatch.id) : null,
    groupMatch,
    note: "候选不是已匹配；多候选必须由操作者显式确认。",
  };
}

// ------------------------------------------------------------------ 确认 / 取消
function loadEntryForConfirm(db, accountSetId, voucherId, entryId) {
  const row = db.prepare(`SELECT v.id AS voucher_id, v.account_set_id, v.period, v.voucher_date, v.status,
                                 v.word, v.number, v.summary AS voucher_summary,
                                 e.id AS entry_id, e.line_no, e.code, e.debit, e.credit, e.summary AS entry_summary
                            FROM vouchers v
                            JOIN voucher_entries e ON e.voucher_id = v.id
                           WHERE v.id = ? AND e.id = ?`)
    .get(voucherId, entryId);
  if (!row) throw bankError("voucher_entry_not_found", "未找到该凭证分录", { voucherId, entryId });
  if (Number(row.account_set_id) !== accountSetId) {
    throw bankError("entry_account_set_mismatch", "凭证不属于该账套，拒绝跨账套匹配", {
      voucherId, entryId, accountSetId,
    });
  }
  return {
    voucherId: Number(row.voucher_id),
    entryId: Number(row.entry_id),
    lineNo: Number(row.line_no),
    period: row.period,
    voucherDate: row.voucher_date,
    status: row.status,
    word: row.word,
    number: Number(row.number),
    code: row.code,
    debitCents: moneyCents(row.debit, "voucher_entries.debit"),
    creditCents: moneyCents(row.credit, "voucher_entries.credit"),
    summary: row.entry_summary || row.voucher_summary || "",
  };
}

/**
 * 人工确认一条银行流水与一条账务分录的匹配。
 * 在事务内用最新账务快照复核：账套 / posted / 科目 / 方向 / 金额 / 日期窗口 / 期间一致，
 * 并靠数据库部分唯一索引保证同一流水、同一分录同时只被占用一次。
 */
function confirmMatchBody(db, options = {}) {
  const scope = resolveBankScope(db, options);
  const transactionId = positiveInt(options.transactionId, "transaction_id_invalid", "流水 ID");
  const voucherId = positiveInt(options.voucherId, "voucher_id_invalid", "凭证 ID");
  const entryId = positiveInt(options.entryId, "entry_id_invalid", "分录 ID");
  const reason = requireReason(options.reason);
  const tolerance = boundedInt(options.dateToleranceDays ?? 0, 0, MAX_TOLERANCE_DAYS, "date_tolerance_invalid");
  refreshMatchStatesBody(db, {
    accountSetId: scope.setId, bankAccountId: scope.account.bank_account_id,
  });

  try {
    return inTransaction(db, () => {
      const txn = getTransaction(db, {
        accountSetId: scope.setId, bankAccountId: scope.account.bank_account_id, transactionId,
      });
      if (!txn) throw bankError("bank_transaction_not_found", `银行流水不存在：${transactionId}`, { transactionId });
      const activeTxn = findActiveMatchForTransaction(db, {
        accountSetId: scope.setId, bankAccountId: scope.account.bank_account_id, transactionId,
      });
      if (activeTxn) {
        throw bankError("match_already_confirmed", "该银行流水已被确认匹配", {
          transactionId, matchId: Number(activeTxn.id),
        });
      }
      const entry = loadEntryForConfirm(db, scope.setId, voucherId, entryId);
      if (entry.status !== "posted") {
        throw bankError("voucher_not_posted", "只有已过账凭证的分录才能参与匹配", {
          voucherId, status: entry.status,
        });
      }
      if (entry.code !== scope.account.gl_account_code) {
        throw bankError("entry_not_bank_account",
          "分录科目不是该银行账户绑定的银行存款科目", {
            entryCode: entry.code, glAccountCode: scope.account.gl_account_code,
          });
      }
      const direction = entry.debitCents > 0n && entry.creditCents === 0n
        ? DIRECTIONS.INFLOW
        : entry.creditCents > 0n && entry.debitCents === 0n
          ? DIRECTIONS.OUTFLOW
          : null;
      if (!direction) {
        throw bankError("entry_amount_ambiguous", "分录借贷方向不明确，拒绝匹配", { voucherId, entryId });
      }
      const amount = direction === DIRECTIONS.INFLOW ? entry.debitCents : entry.creditCents;
      if (direction !== txn.direction || amount !== BigInt(txn.amount_cents)) {
        throw bankError("match_amount_mismatch", "方向或金额与银行流水不一致，拒绝匹配", {
          transaction: { direction: txn.direction, amountCents: Number(txn.amount_cents) },
          entry: { direction, amountCents: centsNumber(amount) },
        });
      }
      const diff = Math.abs(dateDiffDays(entry.voucherDate, txn.txn_date));
      if (!Number.isFinite(diff) || diff > tolerance) {
        throw bankError("match_date_out_of_window", "凭证日期超出允许的日期偏差", {
          txnDate: txn.txn_date, voucherDate: entry.voucherDate, dateToleranceDays: tolerance,
        });
      }
      if (String(entry.period) !== periodOf(entry.voucherDate)) {
        throw bankError("voucher_period_date_mismatch", "凭证期间与凭证日期不一致，先修正账务再匹配", {
          voucherId, period: entry.period, voucherDate: entry.voucherDate,
        });
      }
      const activeEntry = findActiveMatchForEntry(db, { accountSetId: scope.setId, entryId });
      if (activeEntry) {
        throw bankError("entry_already_matched", "该账务分录已被另一条流水占用", {
          entryId, matchId: Number(activeEntry.id), transactionId: Number(activeEntry.transaction_id),
        });
      }
      const snapshot = {
        capturedAt: nowIso(),
        accountSetId: scope.setId,
        bankAccountId: scope.account.bank_account_id,
        currency: "CNY",
        transactionId,
        transactionFingerprint: txn.content_fingerprint,
        transactionDate: txn.txn_date,
        direction,
        amountCents: Number(txn.amount_cents),
        voucherId: entry.voucherId,
        entryId: entry.entryId,
        lineNo: entry.lineNo,
        period: entry.period,
        voucherDate: entry.voucherDate,
        voucherWord: entry.word,
        voucherNumber: entry.number,
        code: entry.code,
        debitCents: centsNumber(entry.debitCents),
        creditCents: centsNumber(entry.creditCents),
        entryFingerprint: sha256Hex([
          entry.voucherId, entry.entryId, entry.lineNo, entry.code, entry.period,
          entry.voucherDate, String(entry.debitCents), String(entry.creditCents),
        ].join("|")),
      };
      const match = insertMatch(db, {
        accountSetId: scope.setId,
        bankAccountId: scope.account.bank_account_id,
        currency: "CNY",
        transactionId,
        voucherId: entry.voucherId,
        entryId: entry.entryId,
        entryLineNo: entry.lineNo,
        snapshot,
        reason,
      });
      appendAuditEvent(db, {
        accountSetId: scope.setId,
        bankAccountId: scope.account.bank_account_id,
        eventType: "match_confirmed",
        subjectType: "bank_match",
        subjectId: String(match.id),
        detail: {
          transactionId, voucherId: entry.voucherId, entryId: entry.entryId, reason,
          direction, amountCents: Number(txn.amount_cents),
        },
      });
      markReconcileRunsStale(db, {
        accountSetId: scope.setId,
        bankAccountId: scope.account.bank_account_id,
        reason: "match_confirmed",
      });
      return { created: true, match: matchView(db, match) };
    });
  } catch (e) {
    if (/UNIQUE constraint failed/i.test(String(e?.message || ""))) {
      throw bankError("match_already_confirmed", "该流水或分录已被其他确认占用（并发冲突）", {
        transactionId, voucherId, entryId,
      });
    }
    throw e;
  }
}

function matchView(db, match) {
  const snapshot = parseSnapshot(match);
  let validity = null;
  if (match.status === "confirmed") {
    const check = evaluateMatch(db, match);
    validity = { ok: check.ok, reason: check.reason };
  }
  return {
    matchId: Number(match.id),
    accountSetId: Number(match.account_set_id),
    bankAccountId: match.bank_account_id,
    currency: match.currency,
    transactionId: match.transaction_id === null ? null : Number(match.transaction_id),
    voucherId: Number(match.voucher_id),
    entryId: Number(match.entry_id),
    partyAllocation: entryPartyView(db, Number(match.account_set_id), Number(match.entry_id)),
    entryLineNo: Number(match.entry_line_no),
    status: match.status,
    reason: match.reason,
    confirmedAt: match.confirmed_at,
    cancelledAt: match.cancelled_at ?? null,
    cancelReason: match.cancel_reason ?? null,
    invalidatedAt: match.invalidated_at ?? null,
    invalidationReason: match.invalidation_reason ?? null,
    snapshot,
    validity,
  };
}

function listMatchesViewBody(db, options = {}) {
  const scope = resolveBankScope(db, options);
  const refresh = refreshMatchStatesBody(db, {
    accountSetId: scope.setId, bankAccountId: scope.account.bank_account_id,
  });
  const statuses = options.status
    ? String(options.status).split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  const matches = listMatches(db, {
    accountSetId: scope.setId,
    bankAccountId: scope.account.bank_account_id,
    statuses,
    limit: options.limit ?? 500,
  });
  return {
    scope: scopeSummary(scope),
    matches: matches.map((m) => matchView(db, m)),
    invalidations: refresh.invalidated,
  };
}

/**
 * 取消匹配：必须给理由；释放占用但保留原匹配、成员、确认与取消事件。
 * 重复取消幂等（不新增审计事件）。
 */
function cancelMatchBody(db, options = {}) {
  const scope = resolveBankScope(db, options);
  const matchId = positiveInt(options.matchId, "match_id_invalid", "匹配 ID");
  const reason = requireReason(options.reason, "cancel_reason_required");
  return inTransaction(db, () => {
    const match = getMatch(db, {
      accountSetId: scope.setId, bankAccountId: scope.account.bank_account_id, matchId,
    });
    if (!match) throw bankError("match_not_found", `匹配记录不存在：${matchId}`, { matchId });
    if (match.status === "cancelled") {
      return { cancelled: false, idempotent: true, match: matchView(db, match) };
    }
    if (match.status !== "confirmed" && match.status !== "invalidated") {
      throw bankError("match_status_invalid", `当前匹配状态不可取消：${match.status}`, { matchId, status: match.status });
    }
    const info = db.prepare(`UPDATE bank_matches SET status='cancelled', cancelled_at=?, cancel_reason=?
                              WHERE id=? AND status IN ('confirmed','invalidated')`)
      .run(nowIso(), reason, matchId);
    if (Number(info.changes || 0) === 0) {
      const latest = getMatch(db, {
        accountSetId: scope.setId, bankAccountId: scope.account.bank_account_id, matchId,
      });
      return { cancelled: false, idempotent: true, match: matchView(db, latest) };
    }
    appendAuditEvent(db, {
      accountSetId: scope.setId,
      bankAccountId: scope.account.bank_account_id,
      eventType: "match_cancelled",
      subjectType: "bank_match",
      subjectId: String(matchId),
      detail: {
        reason,
        previousStatus: match.status,
        transactionId: match.transaction_id === null ? null : Number(match.transaction_id),
        voucherId: Number(match.voucher_id),
        entryId: Number(match.entry_id),
      },
    });
    markReconcileRunsStale(db, {
      accountSetId: scope.setId,
      bankAccountId: scope.account.bank_account_id,
      reason: "match_cancelled",
    });
    const updated = getMatch(db, {
      accountSetId: scope.setId, bankAccountId: scope.account.bank_account_id, matchId,
    });
    return { cancelled: true, idempotent: false, match: matchView(db, updated) };
  });
}

// ------------------------------------------------------------------ 歧义判定
/**
 * 人工判定一条无稳定 ID 的疑似重复行：
 *  - decision=same：确认「同一笔」，关联到既有流水（不新增）；
 *  - decision=distinct：确认「不同一笔」，新增流水并保留来源行证据。
 * 需理由；已判定的同一决定幂等返回，不同决定拒绝。
 */
function resolveAmbiguityBody(db, options = {}) {
  const scope = resolveBankScope(db, options);
  const ambiguityId = positiveInt(options.ambiguityId, "ambiguity_id_invalid", "歧义记录 ID");
  const decision = String(options.decision ?? "").trim();
  if (!["same", "distinct"].includes(decision)) {
    throw bankError("ambiguity_decision_invalid", "decision 必须是 same 或 distinct");
  }
  const reason = requireReason(options.reason, "ambiguity_reason_required");

  return inTransaction(db, () => {
    const ambiguity = getAmbiguity(db, {
      accountSetId: scope.setId, bankAccountId: scope.account.bank_account_id, ambiguityId,
    });
    if (!ambiguity) throw bankError("ambiguity_not_found", `歧义记录不存在：${ambiguityId}`, { ambiguityId });
    if (ambiguity.status !== "pending") {
      if (ambiguity.decision === decision) {
        return { resolved: false, idempotent: true, ambiguity: ambiguityView(db, ambiguity) };
      }
      throw bankError("ambiguity_already_resolved", "该疑似重复行已按另一决定处理，拒绝覆盖", {
        ambiguityId, existingDecision: ambiguity.decision, requestedDecision: decision,
      });
    }
    const candidates = parseJson(ambiguity.candidate_transaction_ids, []).map(Number);
    let transactionId;
    if (decision === "same") {
      const explicit = options.transactionId === undefined || options.transactionId === null
        ? null
        : positiveInt(options.transactionId, "transaction_id_invalid", "流水 ID");
      const target = explicit ?? (candidates.length === 1 ? candidates[0] : null);
      if (!target) {
        throw bankError("ambiguity_target_required",
          "判定为同一笔时必须显式指定要关联的既有流水 ID", { candidates });
      }
      const txn = getTransaction(db, {
        accountSetId: scope.setId, bankAccountId: scope.account.bank_account_id, transactionId: target,
      });
      if (!txn) throw bankError("bank_transaction_not_found", `既有流水不存在：${target}`, { transactionId: target });
      if (txn.source_id !== ambiguity.source_id) {
        throw bankError("ambiguity_target_scope_mismatch", "既有流水不属于同一来源命名空间", {
          expectedSourceId: ambiguity.source_id, actualSourceId: txn.source_id,
        });
      }
      transactionId = target;
    } else {
      const txn = insertTransaction(db, {
        accountSetId: scope.setId,
        bankAccountId: scope.account.bank_account_id,
        sourceId: ambiguity.source_id,
        currency: ambiguity.currency,
        txnDate: ambiguity.txn_date,
        period: ambiguity.period,
        direction: ambiguity.direction,
        amountCents: Number(ambiguity.amount_cents),
        summary: ambiguity.summary,
        bankRefId: null,
        balanceAfterCents: null,
        contentFingerprint: ambiguity.content_fingerprint,
        rowFingerprint: ambiguity.row_fingerprint,
        batchId: ambiguity.batch_id,
        rowIndex: Number(ambiguity.row_index),
        origin: "ambiguity_distinct",
      });
      transactionId = Number(txn.id);
    }
    const updated = resolveAmbiguityRecord(db, {
      ambiguityId,
      decision,
      reason,
      transactionId,
      status: decision === "same" ? "resolved_same" : "resolved_distinct",
    });
    const rowStatus = decision === "same" ? "ambiguity_resolved_same" : "ambiguity_resolved_distinct";
    db.prepare(`UPDATE bank_batch_rows
                   SET status=?, transaction_id=?, note=?
                 WHERE account_set_id=? AND bank_account_id=? AND batch_id=? AND row_index=?`)
      .run(rowStatus, transactionId, `ambiguity:${decision}:${reason}`.slice(0, 500),
        scope.setId, scope.account.bank_account_id, ambiguity.batch_id, Number(ambiguity.row_index));
    const pending = countPendingAmbiguities(db, {
      accountSetId: scope.setId,
      bankAccountId: scope.account.bank_account_id,
      batchId: ambiguity.batch_id,
    });
    if (pending === 0) {
      db.prepare(`UPDATE bank_batches SET status='completed', updated_at=?
                   WHERE account_set_id=? AND bank_account_id=? AND batch_id=? AND status='pending_review'`)
        .run(nowIso(), scope.setId, scope.account.bank_account_id, ambiguity.batch_id);
    }
    appendAuditEvent(db, {
      accountSetId: scope.setId,
      bankAccountId: scope.account.bank_account_id,
      eventType: "ambiguity_resolved",
      subjectType: "bank_ambiguity",
      subjectId: String(ambiguityId),
      detail: {
        decision, reason, transactionId, batchId: ambiguity.batch_id,
        rowIndex: Number(ambiguity.row_index), pendingAfter: pending,
      },
    });
    markReconcileRunsStale(db, {
      accountSetId: scope.setId,
      bankAccountId: scope.account.bank_account_id,
      reason: "ambiguity_resolved",
    });
    return {
      resolved: true,
      idempotent: false,
      ambiguity: ambiguityView(db, updated),
      transactionId,
      pendingInBatch: pending,
    };
  });
}

function ambiguityView(db, ambiguity) {
  const batch = getBatch(db, {
    accountSetId: Number(ambiguity.account_set_id),
    bankAccountId: ambiguity.bank_account_id,
    batchId: ambiguity.batch_id,
  });
  return {
    ambiguityId: Number(ambiguity.id),
    accountSetId: Number(ambiguity.account_set_id),
    bankAccountId: ambiguity.bank_account_id,
    sourceId: ambiguity.source_id,
    batchId: ambiguity.batch_id,
    batchStatus: batch ? batch.status : null,
    rowIndex: Number(ambiguity.row_index),
    date: ambiguity.txn_date,
    period: ambiguity.period,
    direction: ambiguity.direction,
    amountCents: Number(ambiguity.amount_cents),
    amountText: formatCents(ambiguity.amount_cents),
    summary: ambiguity.summary,
    status: ambiguity.status,
    decision: ambiguity.decision ?? null,
    decisionReason: ambiguity.decision_reason ?? null,
    candidateTransactionIds: parseJson(ambiguity.candidate_transaction_ids, []).map(Number),
    resolvedTransactionId: ambiguity.resolved_transaction_id === null ? null : Number(ambiguity.resolved_transaction_id),
    resolvedAt: ambiguity.resolved_at ?? null,
    createdAt: ambiguity.created_at,
  };
}

export function listAmbiguitiesView(db, options = {}) {
  const scope = resolveBankScope(db, options);
  const rows = listAmbiguities(db, {
    accountSetId: scope.setId,
    bankAccountId: scope.account.bank_account_id,
    status: options.status ?? null,
    limit: options.limit ?? 500,
  });
  return {
    scope: scopeSummary(scope),
    ambiguities: rows.map((a) => ambiguityView(db, a)),
    pending: countPendingAmbiguities(db, {
      accountSetId: scope.setId, bankAccountId: scope.account.bank_account_id,
    }),
  };
}

// ------------------------------------------------------------------ 余额调节
/**
 * 余额调节：账面截止余额 = 真实期初 + 截止日全部历史 posted 银行分录；
 * 银行截止余额由操作者显式声明的对账单期初 / 期末 + 覆盖证据支持。
 * 输出四类未达项、两边调节后余额与差额；不生成或修改任何凭证。
 */
function reconcileBankBody(db, options = {}) {
  const scope = resolveBankScope(db, options);
  const setId = scope.setId;
  const accountId = scope.account.bank_account_id;
  const gl = scope.account.gl_account_code;
  const currency = String(options.currency ?? "CNY").trim().toUpperCase();
  if (currency !== "CNY") throw bankError("currency_unsupported", "首版只支持人民币 CNY（分）");
  const period = String(options.period ?? "").trim();
  if (!isValidPeriod(period)) throw bankError("period_invalid", "必须显式提供账务期间 YYYY-MM");
  if (period < scope.accountSet.start_period) {
    throw bankError("period_before_start", "对账期间早于账套启用期间", {
      period, startPeriod: scope.accountSet.start_period,
    });
  }
  const asOf = requireDate(options.asOf, "as_of_invalid", "截止日期 asOf");
  if (periodOf(asOf) !== period) {
    throw bankError("as_of_period_mismatch", "截止日期必须落在对账期间内", { asOf, period });
  }
  const coverageFrom = requireDate(options.coverageFrom, "statement_coverage_required", "对账单覆盖起始日");
  const coverageTo = requireDate(options.coverageTo, "statement_coverage_required", "对账单覆盖截止日");
  if (coverageFrom > coverageTo) {
    throw bankError("statement_coverage_invalid", "对账单覆盖起始日不能晚于截止日", { coverageFrom, coverageTo });
  }
  const statementSource = String(options.statementSource ?? "").trim();
  if (!statementSource) {
    throw bankError("statement_source_required", "必须显式声明对账单期初 / 截止余额的来源与覆盖证据");
  }
  const statementOpen = assertCentsRange(
    toInputCents(options.statementOpenCents, "statement_open_invalid"), "statementOpenCents",
  );
  const statementClose = assertCentsRange(
    toInputCents(options.statementCloseCents, "statement_close_invalid"), "statementCloseCents",
  );

  const refresh = refreshMatchStatesBody(db, { accountSetId: setId, bankAccountId: accountId });

  // ---- 账面：期初 + 截止日（含）全部历史 posted 银行分录 ----
  const openingRow = db.prepare(`SELECT debit, credit FROM opening_balances
                                  WHERE account_set_id=? AND code=?`).get(setId, gl);
  const bookOpening = openingRow
    ? moneyCents(openingRow.debit, "opening_balances.debit") - moneyCents(openingRow.credit, "opening_balances.credit")
    : 0n;
  const entryRows = db.prepare(`SELECT v.id AS voucher_id, v.period, v.voucher_date, v.status,
                                       e.id AS entry_id, e.line_no, e.code, e.debit, e.credit, e.summary
                                  FROM vouchers v
                                  JOIN voucher_entries e ON e.voucher_id = v.id
                                 WHERE v.account_set_id=? AND v.status='posted' AND e.code=?
                                   AND v.voucher_date <= ?
                                 ORDER BY v.voucher_date, v.id, e.line_no`)
    .all(setId, gl, asOf);
  const issues = [];
  const periodMismatch = [];
  let bookNet = 0n;
  const bookEntries = [];
  for (const row of entryRows) {
    const debit = moneyCents(row.debit, "voucher_entries.debit");
    const credit = moneyCents(row.credit, "voucher_entries.credit");
    bookNet += debit - credit;
    const voucherDate = normalizeDateText(row.voucher_date);
    if (!voucherDate) {
      issues.push({
        code: "voucher_date_invalid", severity: "incomplete",
        message: `已过账凭证日期非法：凭证 ${row.voucher_id} / ${row.voucher_date}`,
        details: { voucherId: Number(row.voucher_id), voucherDate: row.voucher_date },
      });
    }
    if (String(row.period) !== periodOf(row.voucher_date)) {
      periodMismatch.push({
        voucherId: Number(row.voucher_id), period: row.period, voucherDate: row.voucher_date,
        entryId: Number(row.entry_id),
      });
    }
    bookEntries.push({
      voucherId: Number(row.voucher_id),
      entryId: Number(row.entry_id),
      lineNo: Number(row.line_no),
      period: row.period,
      voucherDate: row.voucher_date,
      direction: debit > 0n ? DIRECTIONS.INFLOW : DIRECTIONS.OUTFLOW,
      amountCents: centsNumber(debit > 0n ? debit : credit),
      summary: row.summary ?? "",
    });
  }
  const bookClose = bookOpening + bookNet;

  // ---- 银行流水（截止日含）与对账单覆盖窗口 ----
  const txnRows = db.prepare(`SELECT * FROM bank_transactions
                               WHERE account_set_id=? AND bank_account_id=? AND txn_date <= ?
                               ORDER BY txn_date, id`).all(setId, accountId, asOf);
  // 有效匹配的双方日期：全部读取（不分页）。
  // 截止日视角：只有当匹配的**两侧都已发生**（凭证日期与银行流水日期都 <= asOf）时，
  // 这一对才能从截止日未达项中消除；跨日合法匹配保留为「已确认但未发生」的未达项，
  // 不因此禁止跨日匹配，也不回写账务凑平。
  const confirmedMatchSides = listConfirmedMatchSides(db, { accountSetId: setId, bankAccountId: accountId });
  const settledEntryIds = new Set();
  const settledTxnIds = new Set();
  for (const match of confirmedMatchSides) {
    const voucherDate = match.voucher_date === null || match.voucher_date === undefined
      ? null : String(match.voucher_date);
    const txnDate = match.txn_date === null || match.txn_date === undefined
      ? null : String(match.txn_date);
    if (!voucherDate || !txnDate) continue; // 任一侧缺失（被删除）时不得当作已消除
    if (voucherDate > asOf || txnDate > asOf) continue;
    settledEntryIds.add(Number(match.entry_id));
    if (match.transaction_id !== null && match.transaction_id !== undefined) {
      settledTxnIds.add(Number(match.transaction_id));
    }
  }

  let statementNet = 0n;
  for (const txn of txnRows) {
    if (txn.txn_date < coverageFrom || txn.txn_date > coverageTo) continue;
    const amount = BigInt(txn.amount_cents);
    statementNet += txn.direction === DIRECTIONS.INFLOW ? amount : -amount;
  }
  const statementComputedClose = statementOpen + statementNet;
  const statementDifference = statementClose - statementComputedClose;

  const coverageCoversAsOf = coverageFrom <= asOf && coverageTo >= asOf;
  if (!coverageCoversAsOf) {
    issues.push({
      code: "statement_coverage_incomplete", severity: "incomplete",
      message: "对账单覆盖范围没有包含截止日 asOf，无法声称余额完整",
      details: { coverageFrom, coverageTo, asOf },
    });
  }
  if (periodMismatch.length) {
    issues.push({
      code: "voucher_period_date_mismatch", severity: "pending",
      message: "存在已过账凭证的期间与凭证日期不一致，账面余额不能直接视为可对平",
      details: { count: periodMismatch.length, items: periodMismatch.slice(0, 20) },
    });
  }
  if (statementDifference !== 0n) {
    issues.push({
      code: "statement_balance_mismatch", severity: "pending",
      message: "声明的对账单期末余额与「期初 + 覆盖期流水净额」不一致，保留差异",
      details: {
        statementOpenCents: centsNumber(statementOpen),
        statementCloseCents: centsNumber(statementClose),
        computedCloseCents: centsNumber(statementComputedClose),
        differenceCents: centsNumber(statementDifference),
        differenceText: formatCents(statementDifference),
      },
    });
  }
  if (!openingRow) {
    issues.push({
      code: "book_opening_absent", severity: "info",
      message: "该银行存款科目没有登记期初余额记录，账面期初按 0 处理",
      details: { glAccountCode: gl },
    });
  }

  // ---- 四类未达项 ----
  const bookReceivedBankMissing = bookEntries
    .filter((e) => e.direction === DIRECTIONS.INFLOW && !settledEntryIds.has(e.entryId));
  const bookPaidBankMissing = bookEntries
    .filter((e) => e.direction === DIRECTIONS.OUTFLOW && !settledEntryIds.has(e.entryId));
  const bankReceivedBookMissing = [];
  const bankPaidBookMissing = [];
  for (const txn of txnRows) {
    if (settledTxnIds.has(Number(txn.id))) continue;
    const item = {
      transactionId: Number(txn.id),
      date: txn.txn_date,
      direction: txn.direction,
      amountCents: Number(txn.amount_cents),
      amountText: formatCents(txn.amount_cents),
      summary: txn.summary,
      sourceId: txn.source_id,
      batchId: txn.batch_id,
      rowIndex: Number(txn.row_index),
      bankRefId: txn.bank_ref_id ?? null,
    };
    if (txn.direction === DIRECTIONS.INFLOW) bankReceivedBookMissing.push(item);
    else bankPaidBookMissing.push(item);
  }

  const totals = {
    bookReceivedBankMissingCents: centsNumber(sumCents(bookReceivedBankMissing, (i) => BigInt(i.amountCents))),
    bookPaidBankMissingCents: centsNumber(sumCents(bookPaidBankMissing, (i) => BigInt(i.amountCents))),
    bankReceivedBookMissingCents: centsNumber(sumCents(bankReceivedBookMissing, (i) => BigInt(i.amountCents))),
    bankPaidBookMissingCents: centsNumber(sumCents(bankPaidBookMissing, (i) => BigInt(i.amountCents))),
  };
  const adjustedBook = bookClose
    + BigInt(totals.bankReceivedBookMissingCents)
    - BigInt(totals.bankPaidBookMissingCents);
  const adjustedBank = statementClose
    + BigInt(totals.bookReceivedBankMissingCents)
    - BigInt(totals.bookPaidBankMissingCents);
  const difference = adjustedBook - adjustedBank;

  // ---- 未决歧义 / 失效匹配：即使两边数字相等也不能声明已完成 ----
  // 计数用 SQL 聚合 / 先过滤再限条，不拿展示分页长度当真实数量。
  const pendingAmbiguityCount = countPendingAmbiguitiesOnOrBefore(db, {
    accountSetId: setId, bankAccountId: accountId, asOf,
  });
  const pendingAmbiguities = listPendingAmbiguitiesOnOrBefore(db, {
    accountSetId: setId, bankAccountId: accountId, asOf, limit: 20,
  });
  const unresolvedInvalidatedCount = countUnresolvedInvalidatedMatches(db, {
    accountSetId: setId, bankAccountId: accountId,
  });
  const unresolvedInvalidatedMatches = listUnresolvedInvalidatedMatches(db, {
    accountSetId: setId, bankAccountId: accountId, limit: 20,
  });
  if (pendingAmbiguityCount) {
    issues.push({
      code: "unresolved_ambiguity", severity: "pending",
      message: "存在未判定来源的疑似重复行，未达项与调整后余额不能视为完整",
      details: {
        count: pendingAmbiguityCount,
        items: pendingAmbiguities.map((a) => ({
          ambiguityId: Number(a.id), date: a.txn_date, amountCents: Number(a.amount_cents),
          direction: a.direction, batchId: a.batch_id, rowIndex: Number(a.row_index),
        })),
      },
    });
  }
  if (unresolvedInvalidatedCount) {
    issues.push({
      code: "match_invalidated", severity: "pending",
      message: "存在已失效的匹配（反过账 / 修改 / 删除后），必须复核后才能声明已对平",
      details: {
        count: unresolvedInvalidatedCount,
        items: unresolvedInvalidatedMatches.map((m) => ({
          matchId: Number(m.id), reason: m.invalidation_reason, voucherId: Number(m.voucher_id),
          entryId: Number(m.entry_id),
          transactionId: m.transaction_id === null ? null : Number(m.transaction_id),
        })),
      },
    });
  }
  if (refresh.invalidated.length) {
    issues.push({
      code: "match_invalidated_now", severity: "pending",
      message: "本次核验发现刚失效的匹配，已保存失效事件并降级本对账结果",
      details: { count: refresh.invalidated.length, items: refresh.invalidated.slice(0, 20) },
    });
  }
  if (difference !== 0n) {
    issues.push({
      code: "adjusted_balance_difference", severity: "pending",
      message: "调节后账面余额与调节后银行余额存在差额，不能自动补项凑平",
      details: { differenceCents: centsNumber(difference), differenceText: formatCents(difference) },
    });
  }

  const incompleteIssues = issues.filter((i) => i.severity === "incomplete");
  const pendingIssues = issues.filter((i) => i.severity === "pending");
  const status = incompleteIssues.length ? "incomplete" : pendingIssues.length ? "pending_review" : "reconciled";

  const result = {
    scope: scopeSummary(scope),
    period,
    asOf,
    currency,
    asOfPeriodConsistent: true,
    statement: {
      source: statementSource,
      coverageFrom,
      coverageTo,
      coverageCoversAsOf,
      openCents: centsNumber(statementOpen),
      closeCents: centsNumber(statementClose),
      netCents: centsNumber(statementNet),
      computedCloseCents: centsNumber(statementComputedClose),
      differenceCents: centsNumber(statementDifference),
      openText: formatCents(statementOpen),
      closeText: formatCents(statementClose),
      netText: formatCents(statementNet),
      computedCloseText: formatCents(statementComputedClose),
      differenceText: formatCents(statementDifference),
    },
    book: {
      openingCents: centsNumber(bookOpening),
      netCents: centsNumber(bookNet),
      closingCents: centsNumber(bookClose),
      openingText: formatCents(bookOpening),
      netText: formatCents(bookNet),
      closingText: formatCents(bookClose),
      postedEntryCount: bookEntries.length,
      // 截止日两侧都已发生并被人工确认的银行分录数（跨日未发生的匹配不计入已核销）。
      matchedEntryCount: new Set(bookEntries
        .filter((e) => settledEntryIds.has(e.entryId)).map((e) => e.entryId)).size,
    },
    outstanding: {
      bookReceivedBankMissing,
      bookPaidBankMissing,
      bankReceivedBookMissing,
      bankPaidBookMissing,
      totals,
      totalsText: {
        bookReceivedBankMissing: formatCents(totals.bookReceivedBankMissingCents),
        bookPaidBankMissing: formatCents(totals.bookPaidBankMissingCents),
        bankReceivedBookMissing: formatCents(totals.bankReceivedBookMissingCents),
        bankPaidBookMissing: formatCents(totals.bankPaidBookMissingCents),
      },
    },
    adjusted: {
      bookCents: centsNumber(adjustedBook),
      bankCents: centsNumber(adjustedBank),
      differenceCents: centsNumber(difference),
      bookText: formatCents(adjustedBook),
      bankText: formatCents(adjustedBank),
      differenceText: formatCents(difference),
      formula: {
        book: "账面截止余额 + 银行已收企业未收 - 银行已付企业未付",
        bank: "银行截止余额 + 企业已收银行未收 - 企业已付银行未付",
      },
    },
    status,
    issues,
    matches: {
      confirmed: confirmedMatchSides.length,
      invalidatedNow: refresh.invalidated.length,
      invalidatedUnresolved: unresolvedInvalidatedCount,
    },
    ambiguities: { pending: pendingAmbiguityCount },
    accountingUntouched: true,
    note: noteField(options.note),
  };

  // 旧运行记录失效 + 新运行记录 + 审计必须同一事务：
  // 任一插入失败（如合成触发器）都不能留下「无审计的新结果」或误废弃旧结果。
  // 若调用方已经开启外层事务 / 保存点，inTransaction 继续使用保存点，与外层保持兼容。
  const runId = inTransaction(db, () => {
    const id = insertReconcileRun(db, {
      accountSetId: setId,
      bankAccountId: accountId,
      currency,
      period,
      asOf,
      status,
      bookCloseCents: centsNumber(bookClose),
      adjustedBookCents: centsNumber(adjustedBook),
      statementCloseCents: centsNumber(statementClose),
      adjustedBankCents: centsNumber(adjustedBank),
      differenceCents: centsNumber(difference),
      result: {
        status, issues: issues.map((i) => i.code), differenceCents: centsNumber(difference),
        statementDifferenceCents: centsNumber(statementDifference),
        coverage: { coverageFrom, coverageTo }, statementSource,
      },
    });
    appendAuditEvent(db, {
      accountSetId: setId,
      bankAccountId: accountId,
      eventType: "reconcile_computed",
      subjectType: "bank_reconcile_run",
      subjectId: String(id),
      detail: {
        period, asOf, status, differenceCents: centsNumber(difference),
        statementDifferenceCents: centsNumber(statementDifference),
        issueCodes: issues.map((i) => i.code),
      },
    });
    return id;
  });
  return { reconcileRunId: runId, ...result };
}

function noteField(note) {
  const text = String(note ?? "").trim();
  return text ? text.slice(0, 500) : null;
}

// ------------------------------------------------------------------ 状态
function getBankStatusBody(db, options = {}) {
  const scope = resolveBankScope(db, options);
  const setId = scope.setId;
  const accountId = scope.account.bank_account_id;
  const refresh = refreshMatchStatesBody(db, { accountSetId: setId, bankAccountId: accountId });
  // 状态计数一律用 SQL 聚合（真实数量）；items 仍可保留展示分页边界（默认 200）。
  const batchCounts = countBatchesByStatus(db, { accountSetId: setId, bankAccountId: accountId });
  const batches = listBatches(db, {
    accountSetId: setId, bankAccountId: accountId, limit: options.batchLimit ?? 200,
  }).map((b) => batchView(db, b));
  const transactionCounts = countTransactionMatchStates(db, {
    accountSetId: setId, bankAccountId: accountId,
  });
  const matchCounts = countMatchesByStatus(db, { accountSetId: setId, bankAccountId: accountId });
  const pending = countPendingAmbiguities(db, { accountSetId: setId, bankAccountId: accountId });
  const lastRuns = listReconcileRuns(db, { accountSetId: setId, bankAccountId: accountId, limit: 5 });
  return {
    scope: scopeSummary(scope),
    schema: bankSchemaState(db),
    batches: {
      total: batchCounts.total,
      completed: batchCounts.completed,
      pendingReview: batchCounts.pendingReview,
      failed: batchCounts.failed,
      itemsTruncated: batchCounts.total > batches.length,
      itemsLimit: options.batchLimit ?? 200,
      items: batches,
    },
    transactions: {
      total: transactionCounts.total,
      matched: transactionCounts.matched,
      unmatched: transactionCounts.unmatched,
    },
    matches: {
      confirmed: matchCounts.confirmed,
      cancelled: matchCounts.cancelled,
      invalidated: matchCounts.invalidated,
    },
    ambiguities: { pending },
    invalidations: refresh.invalidated,
    reconciles: lastRuns,
    lastReconcileStatus: lastRuns.length ? lastRuns[0].status : null,
  };
}

/** 只读审计查询（append-only 证据）。 */
export function readBankAudit(db, options = {}) {
  const scope = resolveBankScope(db, options);
  const events = listAuditEvents(db, {
    accountSetId: scope.setId,
    bankAccountId: scope.account.bank_account_id,
    limit: options.limit ?? 200,
  }).map((row) => ({
    id: Number(row.id),
    accountSetId: row.account_set_id === null ? null : Number(row.account_set_id),
    bankAccountId: row.bank_account_id,
    eventType: row.event_type,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    detail: parseJson(row.detail_json, {}),
    createdAt: row.created_at,
  }));
  return { scope: scopeSummary(scope), events };
}

// Fixed public admissions include the real refresh side effects of query-shaped entries.
function auditedBankCall(db,action,entry,body,options) {
 try{return auditedBankCallBody(db,action,entry,body,options);}catch(error){
  const fact=operationErrorEvidence(error);
  if(fact?.applied==='unknown'&&auditConnectionQuarantined(db)) {error.code='bank_transaction_rollback_failed';error.message='事务回滚未确认，失败审计未写入；须核对本机现场';error.auditRecorded=false;error.auditFailure='事务回滚未确认，失败审计未写入';}
  else if(error?.code==='bank_transaction_conflict'){error.auditRecorded=false;error.auditFailure='调用方事务仍在进行，本次失败审计未写入';}
  throw error;
 }
}
function auditedBankCallBody(db,action,entry,body,options) {
 assertBankPublicAdmission(db);
 const setId=positiveInt(options.accountSetId,'account_set_id_invalid','账套 ID');
 assertBankSchemaReady(db);if(!db.prepare('SELECT 1 FROM account_sets WHERE id=?').get(setId))throw bankError('account_set_not_found','账套不存在');
 const request={entry,...options};for(const key of ['statementOpenCents','statementCloseCents'])if(typeof request[key]==='bigint')request[key]=request[key].toString();
 let changed=false;
 return runDomainOperation(db,{action,scope:{kind:'account_set',value:setId},request,classify:()=>changed?'succeeded':'no_change',refs:v=>{
  const refs=options.bankAccountId?[{type:'bank_account_key',keyDigest:auditCanonicalDigest([options.accountSetId,options.bankAccountId])}]:[];
  for(const [type,id] of [['bank_match',v?.match?.matchId],['bank_ambiguity',v?.ambiguity?.ambiguityId],['bank_reconcile_run',v?.reconcileRunId]])if(Number.isSafeInteger(id)&&id>0)refs.push({type,id});
  for(const id of new Set(v?.transactionIds??[]))refs.push({type:'bank_transaction',id});
  return refs;
 }},()=>{const before=db.prepare('SELECT total_changes() n').get().n;const out=body(db,options);changed=db.prepare('SELECT total_changes() n').get().n!==before;return out;});
}
export function registerBankAccount(db,options={}) {return auditedBankCall(db,'bank.account.register','registerBankAccount',registerBankAccountBody,options);}
export function importBankBatch(db,options={}) {return auditedBankCall(db,'bank.import','importBankBatch',importBankBatchBody,options);}
export function refreshMatchStates(db,options={}) {if(options.persist===false)return refreshMatchStatesBody(db,options);return auditedBankCall(db,'bank.refresh','refreshMatchStates',refreshMatchStatesBody,options);}
export function listTransactionsView(db,options={}) {return auditedBankCall(db,'bank.refresh','listTransactionsView',listTransactionsViewBody,options);}
export function listCandidates(db,options={}) {return auditedBankCall(db,'bank.refresh','listCandidates',listCandidatesBody,options);}
export function confirmMatch(db,options={}) {return auditedBankCall(db,'bank.match.confirm','confirmMatch',confirmMatchBody,options);}
export function listMatchesView(db,options={}) {return auditedBankCall(db,'bank.refresh','listMatchesView',listMatchesViewBody,options);}
export function cancelMatch(db,options={}) {return auditedBankCall(db,'bank.match.cancel','cancelMatch',cancelMatchBody,options);}
export function resolveAmbiguity(db,options={}) {return auditedBankCall(db,'bank.ambiguity.resolve','resolveAmbiguity',resolveAmbiguityBody,options);}
export function reconcileBank(db,options={}) {return auditedBankCall(db,'bank.reconcile','reconcileBank',reconcileBankBody,options);}
export function getBankStatus(db,options={}) {return auditedBankCall(db,'bank.refresh','getBankStatus',getBankStatusBody,options);}

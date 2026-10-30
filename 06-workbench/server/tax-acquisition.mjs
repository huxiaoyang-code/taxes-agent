// 业务工具只返回安全引用及覆盖范围，原始业务记录不离开此层。
import { randomBytes } from "node:crypto";
import { TaxError } from "./tax-gateway.mjs";
import { buildTaxPreparation } from "./tax-preparation.mjs";

export const ACQUISITION_RESOURCES = Object.freeze([
  "identity", "authorized_enterprises", "enterprise_profile", "tax_assessments", "declaration_status",
  "accounting_filing", "current_obligations", "declaration_history", "invoices", "payments",
]);
const periodOf = (value) => {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new TaxError("tax_period_invalid", "必须提供合法 YYYY-MM 期间");
  }
  return value;
};
function input(args, allowed) {
  if (!args || typeof args !== "object" || Array.isArray(args)
      || Object.keys(args).some((key) => !allowed.includes(key))
      || typeof args.sessionId !== "string" || !args.sessionId
      || args.sessionId !== args.sessionId.trim()) {
    throw new TaxError("tax_acquisition_input_invalid", "参数必须严格符合工具契约，不接受凭据、地址、请求头或业务原文");
  }
}

export class TaxAcquisition {
  constructor({ gateway, accounting, buildPreparation = buildTaxPreparation }) {
    this.gateway = gateway;
    this.accounting = accounting;
    this.buildPreparation = buildPreparation;
    this.records = new Map();
    this.links = new Map();
    this.inflight = new Map();
    this.recordKeys = new Map();
  }

  async verifySession(args = {}) {
    input(args, ["sessionId"]);
    return this.gateway.verifyScope(args);
  }

  async collect(args = {}) {
    input(args, ["sessionId", "resource", "period"]);
    const period = periodOf(args.period);
    if (!ACQUISITION_RESOURCES.includes(args.resource)) throw new TaxError("tax_resource_unknown", "未知资源类别");
    // 按调用顺序串行刷新，包括首次范围核验；
    // 核验失败也须使前次成功摘要失效。
    const requestKey = JSON.stringify([args.sessionId, period, args.resource]);
    const operation = Symbol();
    this.inflight.set(requestKey, operation);
    let key = this.recordKeys.get(requestKey);
    if (key) this.records.delete(key);
    const assertCurrent = () => {
      if (this.inflight.get(requestKey) !== operation) {
        throw new TaxError("tax_read_superseded", "已有更新的采集操作，丢弃迟到结果");
      }
    };
    try {
      const scope = await this.verifySession({ sessionId: args.sessionId });
      assertCurrent();
      key = JSON.stringify([scope.scopeRef, period, args.resource]);
      this.recordKeys.set(requestKey, key);
      this.records.delete(key);
      const result = await this.gateway.collectResource({ ...args, period });
      assertCurrent();
      const after = await this.verifySession({ sessionId: args.sessionId });
      assertCurrent();
      if (scope.scopeRef !== after.scopeRef || result.scopeRef !== scope.scopeRef) {
        throw new TaxError("tax_scope_changed", "作用域变化，未保存采集结果");
      }
      this.records.set(key, Object.freeze({ ...result }));
      return { ...result };
    } catch (error) {
      const statuses = { tax_resource_unsupported: "unsupported", tax_permission_denied: "permission_denied",
        tax_session_expired: "session_expired" };
      if (key && this.inflight.get(requestKey) === operation) this.records.set(key, Object.freeze({ resource: args.resource, period, status: statuses[error.code] || "failed",
        complete: false, count: null, evidenceLevel: "unverified", sourceRef: null,
        errorCode: error instanceof TaxError ? error.code : "tax_query_failed" }));
      throw error;
    } finally {
      if (this.inflight.get(requestKey) === operation) this.inflight.delete(requestKey);
    }
  }

  async coverage(args = {}) {
    input(args, ["sessionId", "period"]);
    const period = periodOf(args.period);
    const scope = await this.verifySession({ sessionId: args.sessionId });
    return { companyRef: scope.scopeRef, period, resources: ACQUISITION_RESOURCES.map((resource) => ({
      ...(this.records.get(JSON.stringify([scope.scopeRef, period, resource])) || {
        resource, period, status: scope.supportedResources.includes(resource) ? "not_acquired" : "unsupported", complete: false, count: null,
        evidenceLevel: "unverified", sourceRef: null,
      }),
    })) };
  }

  async linkAccountSet(args = {}) {
    input(args, ["sessionId", "accountSetId"]);
    const id = args.accountSetId;
    if (!((typeof id === "number" && Number.isSafeInteger(id)) || (typeof id === "string" && /^[1-9]\d*$/.test(id)))
        || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) {
      throw new TaxError("accountSetId_invalid", "账套 ID 必须为正整数");
    }
    const scope = await this.verifySession({ sessionId: args.sessionId });
    if (scope.boundAccountSetId !== null && scope.boundAccountSetId !== undefined && scope.boundAccountSetId !== Number(id)) {
      throw new TaxError("tax_account_set_mismatch", "指定账套与会话绑定的账套不一致");
    }
    try { this.accounting.getAccountSet(Number(id)); }
    catch { throw new TaxError("account_set_not_found", "指定的已有账套不存在"); }
    const link = { id: Number(id), accountSetRef: `book_${randomBytes(18).toString("hex")}` };
    this.links.set(scope.scopeRef, link);
    return { companyRef: scope.scopeRef, accountSetRef: link.accountSetRef, linked: true,
      relationship: "operator_selected", identityMatched: false, persistence: "process_memory" };
  }

  async prepare(args = {}) {
    input(args, ["sessionId", "period"]);
    const coverage = await this.coverage(args);
    const link = this.links.get(coverage.companyRef);
    let accountSet = { linked: false };
    if (link) {
      try {
        this.accounting.getAccountSet(link.id);
        accountSet = { linked: true, accountSetRef: link.accountSetRef, identityMatched: false,
          periodAvailable: this.accounting.listPeriods(link.id).some((row) => row.period === args.period),
          accountCount: this.accounting.listAccounts(link.id).length,
          voucherCount: this.accounting.listVouchers(link.id, { period: args.period }).length };
      } catch { throw new TaxError("account_set_not_found", "关联账套不可读取"); }
    }
    return this.buildPreparation({ companyRef: coverage.companyRef, period: args.period,
      coverage: coverage.resources, accountSet, fields: [] });
  }
}

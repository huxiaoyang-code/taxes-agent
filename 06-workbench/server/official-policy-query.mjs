// 输入只用于政府站点公开检索。遇到明显属于本机原件或账户的值，在发出请求前拒绝。
export function publicPolicyQuery(query) {
  if (typeof query !== 'string') return null;
  const term = query.trim();
  if (term.length < 2 || term.length > 160 || /[\u0000-\u001f\u007f]/u.test(term)) return null;
  const hasLocation = /https?:\/\/|[a-z]:[\\/]|(?:^|\s)(?:\/[\p{L}\d._-]+\/|~\/|\\\\)/iu;
  const hasPrivateField = /\bBearer\s|(?:authorization|cookie|token|password|api[_-]?key|secret|密码|口令|客户名称|纳税人识别号|税号|银行账号|合同编号)\s*[=:：]|\S+@\S+\.\S+/iu;
  const hasIdentifier = /(?:^|[^0-9A-Z])(?:[0-9A-Z]{18}|\d{15,20}|1[3-9]\d{9})(?![0-9A-Z])/u;
  return hasLocation.test(term) || hasPrivateField.test(term) || hasIdentifier.test(term) ? null : term;
}

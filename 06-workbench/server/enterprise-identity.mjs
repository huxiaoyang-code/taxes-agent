// Pure identity rules shared by every creation entry. Display names are never keys.
const CONTROL = /[\u0000-\u001F\u007F]/;
const text = (raw) => raw == null ? "" : typeof raw === "string" ? raw.trim()
  : typeof raw === "number" && Number.isFinite(raw) ? String(raw) : null;
export const identityError = (code) => Object.assign(new Error(code), { code });
export function canonicalEnterpriseKey(raw) {
  const value = text(raw);
  return value === null ? null : value.normalize("NFKC").trim();
}
export function normalizeEnterpriseIdentity(raw) {
  if (raw == null) throw identityError("enterprise_identity_required");
  if (typeof raw !== "object" || Array.isArray(raw)) throw identityError("enterprise_identity_invalid");
  const enterpriseKey = canonicalEnterpriseKey(raw.enterpriseKey ?? raw.enterprise_key);
  if (enterpriseKey === "") throw identityError("enterprise_identity_required");
  if (enterpriseKey === null || enterpriseKey.length > 128 || CONTROL.test(enterpriseKey)) {
    throw identityError("enterprise_identity_invalid");
  }
  const enterpriseName = text(raw.enterpriseName ?? raw.enterprise_name);
  if (enterpriseName === null || enterpriseName.length > 200 || CONTROL.test(enterpriseName)) {
    throw identityError("enterprise_identity_invalid");
  }
  return { enterpriseKey, enterpriseName };
}
export function requireSameEnterpriseIdentity(identity, other) {
  if (other === undefined) return identity;
  const normalized = normalizeEnterpriseIdentity(other);
  if (identity.enterpriseKey !== normalized.enterpriseKey) throw identityError("enterprise_identity_mismatch");
  return identity;
}

// 复用 PR #19 的回环地址/Origin 边界，不复用其浏览器或 DOM 采集器。
export function isLoopbackHost(host) {
  if (typeof host !== "string") return false;
  const match = /^(\[::1\]|127\.0\.0\.1|localhost)(?::(\d{1,5}))?$/.exec(host.trim().toLowerCase());
  return !!match && (match[2] === undefined || (Number(match[2]) >= 1 && Number(match[2]) <= 65535));
}

export function isLoopbackAddress(addr) {
  if (typeof addr !== "string") return false;
  let value = addr.trim().toLowerCase();
  if (value.startsWith("::ffff:")) value = value.slice(7);
  if (value === "::1") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  return !!match && match.slice(1).every((part) => Number(part) <= 255) && Number(match[1]) === 127;
}

export function checkLocalOrigin(req) {
  if (!isLoopbackHost(req.headers.host)) return { ok: false };
  const origin = req.headers.origin;
  return { ok: origin === undefined || origin === `http://${req.headers.host}` };
}

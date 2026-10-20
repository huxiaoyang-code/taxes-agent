// Fixed local administrative inspection; no navigation, fetch, cookies or leases.
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openRegisteredBrowserDiagnostic } from '../server/tax-browser-diagnostic.mjs';

const ETAX = 'https://etax.fujian.chinatax.gov.cn:8443';
const TPASS = 'https://tpass.fujian.chinatax.gov.cn:8443';
export const OBSERVED_ROUTES = Object.freeze({
  '/loginb/': 'portal_home', '/loginb': 'portal_home',
  '/mhzx/api/mh/mhsy/index': 'portal_index',
  '/mhzx/api/mh/tpass/ssoLogin': 'sso_login',
  '/hdjl/spHandler': 'interaction_handler',
  '/portal/dljg': 'agency_portal',
  '/portal/fjm': 'nonresident_portal',
  '/mhzx/api/mh/mhsy/getUserInfo': 'identity',
  '/mhzx/api/mh/bqxx/getMhsydbBqxx': 'portal_footer',
  '/xxzx/api/nsrxxzx/txzx/wntj/v1/listWntj': 'reminder_statistics',
});
export function classifyObservedUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    if (url.origin === TPASS) return { pageClass: 'tpass_login', routeCode: url.pathname === '/api/v1.0/auth/oauth2/login' ? 'oauth_login' : 'unknown' };
    if (url.origin !== ETAX) return null;
    const routeCode = Object.hasOwn(OBSERVED_ROUTES, url.pathname) ? OBSERVED_ROUTES[url.pathname] : url.pathname === '/' ? 'official_root' : 'unknown';
    return { pageClass: routeCode === 'portal_home' ? 'etax_home' : 'etax_other', routeCode };
  } catch { return null; }
}
export function pageReference(registrationRef, targetId) {
  return 'taxpage_' + createHash('sha256').update(registrationRef + '\0' + targetId).digest('hex').slice(0, 48);
}
export async function inventoryRegisteredBrowser({ registrationRef, registrationRoot } = {}, overrides = {}) {
  let transport;
  try {
    if (!/^taxr_[a-f0-9]{48}$/.test(registrationRef || '')) throw new Error('input');
    // Explicit local administrative registry location. The primitive still verifies
    // canonical directory, ACL, record/claim, owner identity, private profile and port.
    const options = registrationRoot ? { registrationBase: dirname(resolve(registrationRoot)) } : {};
    transport = await (overrides.openDiagnostic || openRegisteredBrowserDiagnostic)({ registrationRef, registrationRoot }, options);
    const response = await transport.cdp.send('Target.getTargets', {}, { timeoutMs: 5000 });
    if (!Array.isArray(response?.targetInfos) || response.targetInfos.length > 10000) throw new Error('targets');
    const pages = [];
    for (const target of response.targetInfos) {
      if (target.type !== 'page') continue;
      const classification = classifyObservedUrl(target.url);
      if (classification && typeof target.targetId === 'string' && target.targetId.length <= 256) {
        pages.push({ pageRef: pageReference(registrationRef, target.targetId), ...classification });
      }
    }
    return { status: 'observed', pages, leaseChanged: false };
  } catch { return { status: 'inventory_failed', pages: [], leaseChanged: false }; }
  finally { try { transport?.close(); } catch {} }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (![2, 4].includes(args.length) || args[0] !== '--registration-ref'
      || args.length === 4 && args[2] !== '--registration-root') {
    console.error('usage: node scripts/inventory-tax-browser.mjs --registration-ref <local-ref> [--registration-root <local-directory>]');
    process.exitCode = 1;
  } else {
    const result = await inventoryRegisteredBrowser({ registrationRef: args[1], registrationRoot: args[3] });
    console.log(JSON.stringify(result));
    if (result.status !== 'observed') process.exitCode = 1;
  }
}

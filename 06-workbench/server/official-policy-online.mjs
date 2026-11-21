import {searchOfficialPolicies} from './official-policy-search.mjs';
import {readOfficialPolicy} from './official-policy-reader.mjs';

export async function runOfficialPolicyOnline(args) {
  if (args.action === 'search') return searchOfficialPolicies(args);
  if (args.action === 'open') return readOfficialPolicy(args);
  throw Object.assign(new Error('未知的在线查法操作。'), {code:'invalid_arguments'});
}

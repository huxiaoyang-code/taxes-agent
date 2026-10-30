// expected/initial/current 守卫之前，只求值原生引导代码。
import { assertAccountantReviewQ2CodeCurrent } from './accountant-review-q2-code.mjs';
let pair, publication, reviewApi, reviewBundle;
const close = () => { try { pair?.close(); } finally { pair=undefined; } };
const shutdown = () => { try { close(); } finally { process.exit(1); } };
process.on('disconnect',shutdown); process.on('SIGTERM',shutdown); process.on('SIGINT',shutdown);
let reply;
try {
  const expected=JSON.parse(Buffer.from(process.argv[2],'base64url').toString('utf8'));
  assertAccountantReviewQ2CodeCurrent(expected);
  const [loader,review]=await Promise.all([import('./offline-vat-input.mjs'),import('./accountant-review-q2-bundle.mjs')]);
  assertAccountantReviewQ2CodeCurrent(expected);
  reviewApi=review;
  pair=await loader.openVatInputPairFiles(JSON.parse(Buffer.from(process.argv[3],'base64url').toString('utf8')));
  const bundle=reviewBundle=await review.createAccountantReviewQ2(pair);
  const manifest=publication=await review.exportAccountantReviewQ2(bundle,process.argv[4],pair,process.argv[5]);
  const outputFiles=await review.assertAccountantReviewQ2PublicationCurrent(manifest,bundle,pair);
  const manifestSha256=outputFiles.find(f=>f.name==='manifest.json').sha256;
  reply={type:'result',result:{calculationReady:bundle.computation.calculationReady,bundleDigest:bundle.contentDigest,computationStatus:bundle.computation.status,manifest,manifestSha256,outputFiles,codeBinding:assertAccountantReviewQ2CodeCurrent(expected)}};
} catch(e) {
  if(publication && reviewApi) try { await reviewApi.invalidateAccountantReviewQ2Publication(publication,reviewBundle,pair); } catch {}
  const allowed=['pair_scope_mismatch','pair_instance_mismatch','pair_profile_mismatch','pair_quarter_mismatch','pair_account_set_invalid','pair_previous_computation_forbidden','ledger_target_file_mismatch','q2_code_restart_required','review_q2_context_stale','review_q2_publication_failed'];
  reply={type:'failure',code:allowed.includes(e?.code)?e.code:e?.code==='EEXIST'?'review_q2_output_conflict':/^input_|^pair_input_|^ledger_changed|^material_store_/.test(e?.code)?'review_q2_context_stale':'review_q2_input_or_publication_rejected'};
} finally { close(); }
if(process.connected) try { await new Promise((ok,no)=>process.send({version:'offline-accountant-review-q2-ipc/1',...reply},e=>e?no(e):ok())); } catch { process.exit(1); }
process.removeListener('disconnect',shutdown);
if(process.connected) process.disconnect();
process.exit(0);

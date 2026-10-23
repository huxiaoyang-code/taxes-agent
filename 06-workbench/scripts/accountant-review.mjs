#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openVatInputFiles } from '../server/offline-vat-input.mjs';
import { createAccountantReview } from '../server/accountant-review.mjs';
import { exportAccountantReview } from '../server/accountant-review-export.mjs';
export async function runCli(args) {
  if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output' || !args[1] || !args[3]) return { exitCode: 2, message: 'ACCOUNTANT_REVIEW_USAGE_ERROR' };
  let session;
  try {
    session = await openVatInputFiles(args[1]);
    const bundle = createAccountantReview(session.rawInput, session.source, session.snapshot);
    await exportAccountantReview(bundle, args[3], { inputSession: session });
    return { exitCode: bundle.computation.calculationReady ? 0 : 3, message: `ACCOUNTANT_REVIEW_WRITTEN draft=1 ready=${bundle.computation.calculationReady ? 1 : 0} issues=${bundle.exceptions.length}` };
  } catch { return { exitCode: 4, message: 'ACCOUNTANT_REVIEW_REJECTED' }; }
  finally { session?.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await runCli(process.argv.slice(2)); process.stdout.write(r.message + '\n'); process.exitCode = r.exitCode;
}

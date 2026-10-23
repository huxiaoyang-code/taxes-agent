import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=f=>fs.readFileSync(new URL(f,import.meta.url),'utf8');
const html=read('../public/index.html'),app=read('../public/app.js'),css=read('../public/styles.css');
for(const id of ['bankFile','bankCsv','bankMapping','bankPreview','bankImport','bankAccount','bankPeriod','bankAmbiguities','bankCandidates','bankMatches','bankStatementOpen','bankStatementClose','bankReconcileOut','bankTolerance'])assert.ok(html.includes('id="'+id+'"'),id);
assert.match(html,/<input id="bankFile" type="file"/);assert.match(html,/<button id="bankImport" disabled>/);assert.match(html,/data-tab="bank"/);
const bank=app.slice(app.indexOf('// LOCAL04B:'),app.indexOf('// ------------------------------------------------------------------ 事件'));
assert.equal(bank.includes('innerHTML'),false);assert.equal(bank.includes('insertAdjacentHTML'),false);assert.match(bank,/textContent/);assert.match(bank,/f\.text\(\)/);assert.match(bank,/\$\('#bankCsv'\)\.value=text/);assert.match(bank,/csvText:\$\('#bankCsv'\)\.value/);
assert.match(bank,/JSON\.parse\(\$\('#bankMapping'\)\.value\)/);assert.match(bank,/bank_import_preview/);assert.match(bank,/approve-import/);assert.match(bank,/previewRef:v.ref/);assert.match(bank,/bankCurrent\(c\)/);assert.match(bank,/BANK_GEN\+\+/);assert.match(bank,/SETS.find\(item=>item.id===c.set\)/);assert.match(app,/async function selectSet\(\) \{\n  bankClear\(\)/);
for(const tool of ['bank_account_register','bank_ambiguity_resolve','bank_confirm','bank_cancel','bank_reconcile'])assert.ok(bank.includes(tool));assert.match(bank,/window\.confirm/);assert.match(bank,/2\*1024\*1024/);assert.match(css,/#tab-bank textarea/);
// Static scope contract executes the actual source guards with independent scope/epoch values.
const currentSource=bank.match(/const bankCurrent=c=>([^;]+);/)[1];const current=Function('c','SET_ID','BANK_GEN','return '+currentSource);assert.equal(current({set:1,gen:2},1,2),true);assert.equal(current({set:1,gen:2},2,2),false);assert.equal(current({set:1,gen:2},1,3),false);
console.log('bank-ui-contract PASS file+paste common text/mapping/preview/approve chain, safe DOM, scope+generation guards; actual page paste/filechooser NOT RUN');

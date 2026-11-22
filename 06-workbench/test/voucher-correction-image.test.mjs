import assert from 'node:assert/strict';
import test from 'node:test';
import {join} from 'node:path';
import {captureCorrectionSources,verifyCorrectionProof} from '../server/voucher-correction-proof.mjs';

// 两张程序绘制的图片，交易行是 ALPHA、345、余额 1845，上一行余额 1500。
test('Windows 本机从原图核对日期、往来、收付和余额，排除重叠字段和第二个候选行',
  {skip:process.platform!=='win32'?'需要 Windows 本机 OCR':false},()=>{
    const sourceRoot=join(import.meta.dirname,'fixtures','voucher-correction');
    const originals=captureCorrectionSources(sourceRoot);
    const cells={date:[0,68,245,58],party:[300,68,230,58],amount:[610,68,220,58],
      priorBalance:[895,0,240,58],balance:[895,68,245,58]};
    const book=value=>({voucher_date:'2026-11-23',entries:[{code:'100201',debit:value},{code:'112201',credit:value}]});
    function verify(file,rects=cells){
      const source=originals.find(r=>r.path===join(sourceRoot,file));
      const proof={kind:'bank_statement',...source,lines:[{row:2,bankCode:'100201',counterCode:'112201',cells:rects}]};
      return verifyCorrectionProof({proof,originals,sourceRoot,before:book(340),after:book(345),accountName:()=> 'ALPHA'});
    }
    assert.equal(verify('single-synthetic-payment.png').verified,true);
    assert.throws(()=>verify('single-synthetic-payment.png',{...cells,amount:cells.balance}),/image_row_invalid/);
    assert.throws(()=>verify('single-synthetic-payment.png',{...cells,priorBalance:[0,0,200,58]}),/image_row_invalid/);
    assert.throws(()=>verify('same-day-candidates.png'),/ambiguous_event/);
  });

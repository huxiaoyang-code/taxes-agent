// 仅在本机读取指定的原图字段。子进程不接收路径，不返回整图或整页文本。
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const fail=code=>{throw Object.assign(new Error(code),{code});};
export function readBankImageRows(bytes,lines){
  if(process.platform!=='win32') fail('correction_original_ocr_unavailable');
  const fields=['date','party','amount','balance'];
  const amounts=[];
  const overlaps=(a,b)=>Math.min(a[1]+a[3],b[1]+b[3])>Math.max(a[1],b[1]);
  for(const {cells} of lines){
    if(!cells || Object.values(cells).some(r=>!r[2]||!r[3])) fail('correction_bank_image_cells_required');
    const horizontal=(a,b)=>Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0]);
    const intersecting=fields.some((name,i)=>fields.slice(i+1).some(other=>horizontal(cells[name],cells[other])>0));
    if(intersecting || fields.some(k=>!overlaps(cells.amount,cells[k])) ||
        horizontal(cells.priorBalance,cells.balance)<Math.min(cells.priorBalance[2],cells.balance[2])*0.8 ||
        cells.priorBalance[1]+cells.priorBalance[3]>cells.balance[1])
      fail('correction_bank_image_row_invalid');
    if(amounts.some(other=>overlaps(cells.amount,other))) fail('correction_bank_image_row_duplicate');
    amounts.push(cells.amount);
  }
  const windowsPowerShell=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script=fileURLToPath(new URL('./voucher-correction-ocr.ps1',import.meta.url));
  const result=spawnSync(windowsPowerShell,['-NoProfile','-NonInteractive','-File',script],{
    windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:1024*1024,
    input:JSON.stringify({image:bytes.toString('base64'),lines:lines.map(l=>l.cells)}),
  });
  if(result.error || result.status!==0) fail('correction_original_ocr_unavailable');
  let rows;
  try{rows=JSON.parse(result.stdout.replace(/^\uFEFF/,''));}catch{fail('correction_original_ocr_unavailable');}
  if(!Array.isArray(rows)||rows.length!==lines.length) fail('correction_original_ocr_unavailable');
  for(const [i,row] of rows.entries()){
    for(const key of ['amount','priorBalance','balance','date']){
      if(typeof row[key]!=='string') fail('correction_original_ocr_unavailable');
      row[key]=row[key].normalize('NFKC').trim().replace(/\s*([./-])\s*/g,'$1');
    }
    // 从整列反查其他交易，不能仅用调用方裁出的那几格证明原件内唯一。
    const chosen=lines[i].cells.date, selectedY=y=>y>=chosen[1] && y<chosen[1]+chosen[3];
    const dates=row.dateColumn.filter(d=>/\d/.test(d.text.normalize('NFKC')));
    if(dates.filter(d=>selectedY(d.y)).length!==1) fail('correction_bank_image_row_invalid');
    const at=(column,y)=>{
      const hits=column.filter(c=>Math.abs(c.y-y)<chosen[3]/2);
      if(hits.length!==1) fail('correction_bank_image_row_invalid');
      return hits[0].text.normalize('NFKC').trim();
    };
    row.otherRows=dates.filter(d=>!lines.some(l=>d.y>=l.cells.date[1] && d.y<l.cells.date[1]+l.cells.date[3]))
      .map(d=>({date:d.text.normalize('NFKC').replace(/\s*([./-])\s*/g,'$1').trim(),
        party:at(row.partyColumn,d.y),amount:at(row.amountColumn,d.y)}));
  }
  return rows;
}

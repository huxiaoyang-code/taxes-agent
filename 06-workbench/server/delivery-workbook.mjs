import {readDeliveryWorkbook as parseWorkbook} from './offline-invoice-xlsx.mjs';

// 账表、库存及税费核验共用同一组封存字节，避免按领域重复解压整本工作簿。
const parsed=new WeakMap();
export function readDeliveryWorkbook(bytes){
  if(!parsed.has(bytes))parsed.set(bytes,parseWorkbook(bytes));
  return parsed.get(bytes);
}

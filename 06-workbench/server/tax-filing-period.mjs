// Filing-row tax-period dates stay local. Public summaries expose counts and
// equality only; they do not prove current pending obligations or completeness.
export const FILING_PERIOD_FIELDS=Object.freeze(['skssqq','skssqz','skssqzqz']);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const has=(row,key)=>object(row)&&Object.hasOwn(row,key)&&row[key]!==undefined;
function date(value){
  if(value===undefined||value===null||value==='')return {status:'missing'};
  if(typeof value!=='string')return {status:'invalid_type'};
  let match,format;
  if(value.length===10&&(match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value)))format='dashed';
  else if(value.length===8&&(match=/^(\d{4})(\d{2})(\d{2})$/.exec(value)))format='compact';
  else if(value.length===19&&(match=/^(\d{4})-(\d{2})-(\d{2}) 00:00:00$/.exec(value)))format='midnight';
  else return {status:'unsupported_format'};
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
  const leap=year%400===0||year%4===0&&year%100!==0;
  const lengths=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if(year<1||month<1||month>12||day<1||day>lengths[month-1])return {status:'invalid_calendar',format};
  return {status:'valid',format,key:match[1]+match[2]+match[3]};
}
function pair(row){
  const start=date(has(row,'skssqq')?row.skssqq:undefined),end=date(has(row,'skssqz')?row.skssqz:undefined);
  const status=['missing','invalid_type','unsupported_format','invalid_calendar'].find(code=>start.status===code||end.status===code)
    ||(start.key>end.key?'reversed':'valid');
  return {start,end,status,...(status==='valid'?{key:start.key+'|'+end.key}:{})};
}
function inspect(rows){
  const values=Array.isArray(rows)?rows:[],pairs=values.map(pair),distinct=new Set();
  const coverage={rowCount:values.length,startPresentCount:0,endPresentCount:0,startEmptyCount:0,endEmptyCount:0,
    startDashedCount:0,startCompactCount:0,startMidnightCount:0,startOtherStringCount:0,
    endDashedCount:0,endCompactCount:0,endMidnightCount:0,endOtherStringCount:0,
    displayFieldPresentCount:0,validPairCount:0,missingPairCount:0,invalidTypePairCount:0,unsupportedFormatPairCount:0,
    invalidCalendarPairCount:0,reversedPairCount:0,distinctPeriodCount:0,alreadyFiledCount:0,alreadyFiledWithValidPeriodCount:0};
  const category={valid:'validPairCount',missing:'missingPairCount',invalid_type:'invalidTypePairCount',
    unsupported_format:'unsupportedFormatPairCount',invalid_calendar:'invalidCalendarPairCount',reversed:'reversedPairCount'};
  values.forEach((row,index)=>{
    const current=pairs[index];coverage[category[current.status]]++;
    for(const [side,key] of [['start','skssqq'],['end','skssqz']]){
      if(!has(row,key))continue;coverage[side+'PresentCount']++;
      const value=row[key];
      if(value===null||value==='')coverage[side+'EmptyCount']++;
      if(current[side].format==='dashed')coverage[side+'DashedCount']++;
      else if(current[side].format==='compact')coverage[side+'CompactCount']++;
      else if(current[side].format==='midnight')coverage[side+'MidnightCount']++;
      else if(typeof value==='string'&&value!=='')coverage[side+'OtherStringCount']++;
    }
    if(has(row,'skssqzqz'))coverage.displayFieldPresentCount++;
    if(current.status==='valid')distinct.add(current.key);
    if(row?.zt==='已申报'){coverage.alreadyFiledCount++;if(current.status==='valid')coverage.alreadyFiledWithValidPeriodCount++;}
  });
  coverage.distinctPeriodCount=distinct.size;
  return {coverage,pairs,verified:values.length>0&&coverage.validPairCount===values.length};
}
export function summarizeFilingPeriods(rows){
  const result=inspect(rows);
  return {filingPeriodsVerified:result.verified,filingPeriodCoverage:result.coverage};
}
export function compareFilingPeriods(leftRows,rightRows){
  const left=inspect(leftRows),right=inspect(rightRows),comparable=left.verified&&right.verified;
  const leftKeys=left.pairs.map(value=>value.key),rightKeys=right.pairs.map(value=>value.key);
  return {filingPeriodsComparable:comparable,leftFilingPeriodsVerified:left.verified,rightFilingPeriodsVerified:right.verified,
    leftFilingPeriodCoverage:left.coverage,rightFilingPeriodCoverage:right.coverage,
    filingPeriodPairsEqual:comparable&&leftKeys.length===rightKeys.length&&leftKeys.every((key,index)=>key===rightKeys[index]),
    filingPeriodMultisetEqual:comparable&&JSON.stringify([...leftKeys].sort())===JSON.stringify([...rightKeys].sort())};
}

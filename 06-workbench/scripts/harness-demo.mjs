#!/usr/bin/env node
// Preparation/assessment only. This script never invokes a model and never
// manufactures an Agent trace. Run Pi separately after explicit user permission.
import { mkdirSync, writeFileSync, readdirSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostingFixture } from '../test/helpers/offline-posting-fixture.mjs';
import { DatabaseSync } from 'node:sqlite';
const [command,path]=process.argv.slice(2),root=path&&resolve(path);
if(command==='prepare'&&root) {
  if(existsSync(root))throw new Error('demo_directory_must_be_new');mkdirSync(root,{recursive:true});
  const fixture=createPostingFixture(join(root,'fixture-engine')),originals=join(root,'customer-originals');mkdirSync(originals);
  // Remove every pre-normalized business input. The independent Agent sees only
  // newly authored originals plus the explicit local database identity.
  for(const name of readdirSync(fixture.dir))if(/\.(json|csv|xlsx)$/.test(name))unlinkSync(join(fixture.dir,name));
  writeFileSync(join(originals,'客户原始资料.unfamiliar'),`【合成客户寄来的业务说明，不是模板】\n企业：${fixture.key}；2026年1月新设，2026-Q1；小企业会计准则；小规模季度申报。\n3月24日已完成普通主营咨询服务，合同 SYN-CONSULT-24，当日验收并取得索款权；截至季末未收款。\n普通发票号 310024；销方为本企业；购方 SYN-BUYER。\n票面排版如下（单位人民币元）：\n    总价  1,246.17\n    其中税额  12.34\n    不含税价  1,233.83\n此项为境内普通主营服务，只有一次履约，不含资产、工程或工资。\n另一张采购收据暂缺实际用途及受益期，票面总价279.68，税8.15，未付款。不得猜用途。\n负责人声明本季度无其他业务、工资、资产或银行账户；会计税务属性确认仍待核验。\n`);
  const target={dbPath:fixture.dbPath,databaseInstanceId:fixture.instanceId,enterpriseKey:fixture.key,accountSetId:fixture.id};
  const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
  writeFileSync(join(root,'goal.txt'),`全部为合成演示资料。目标：处理 ${originals} 目录原始资料；先发现真实能力与按需读取Harness Skill，委派解析子Agent编写并运行解析和验证，保存未识别内容；登记证据与事实，维护计划，在任务授权内通过实际业务入口完成可执行核算分支，缺件分支提出具体本机补件。源文件无预制分录或已算申报税额；自行调查事实/规则并保存理由与验证，不冒充会计确认，不声称全税完成。\n本机目标：${JSON.stringify(target)}\n范围：2026-Q1，CNY。元数据新目录：${join(root,'harness-store')}。产物保存本演示目录。测试基础设施预建空账套，仅验证已有目标接入；fixture-engine不是客户资料，不读取其内部备份或测试脚本。\n入口Skill：${join(repo,'05-reconstruction/codex/skills/harness/SKILL.md')}\n`);
  writeFileSync(join(root,'demo-manifest.json'),JSON.stringify({version:'harness-agent-demo/1',target,scope:{enterpriseKey:target.enterpriseKey,accountSetId:target.accountSetId,databaseInstanceId:target.databaseInstanceId,period:'2026-Q1',currency:'CNY'},agentExecuted:false},null,2));
  console.log(JSON.stringify({status:'prepared_only',root,goal:join(root,'goal.txt'),extension:join(repo,'05-reconstruction/codex/pi/finance-harness.ts'),requiresUserPermissionBeforeModelTest:true}));
} else if(command==='supplement'&&root) {
 const manifest=JSON.parse(readFileSync(join(root,'demo-manifest.json'),'utf8')),originals=join(root,'customer-originals'),supplement=join(originals,'采购补件.客户回函');
 writeFileSync(supplement,`【合成客户补充回函，非会计确认】\n企业：${manifest.target.enterpriseKey}，2026-Q1。\n前次279.68元采购收据对应2026年3月8日收到的日常组织行政服务，供应商SYN-ADMIN-SUPPLIER，收据号PUR-0308，合同ADMIN-MAR。3月19日已完成验收，仅受益于3月1日至3月31日，不形成资产，不属于项目成本。净价271.53元、税8.15元，总价279.68元，季末未付款。\n这是经营负责人对实际用途、日期和受益范围的说明；具体会计判断、税务属性与复核意见仍由会计决定。原销售资料没有更改。\n`,{flag:'wx'});
 const goal=join(root,'goal-supplement.txt');writeFileSync(goal,`全部为合成演示资料。接续第一次业务任务：先读取已存在的 Harness Store ${join(root,'harness-store')} 的真实status与历史回执，保留未完事项和原授权，不重建Store或重新入账已执行销售。新增原始补件为 ${supplement}；委派新解析子Agent仅调查该补件并保存代码、核对、来源位置和未识别内容。根据补件更新受影响来源/事实/DAG并执行现有业务能力允许的采购分支；说明哪些旧版本失效、哪些销售结果保持有效，以真实回执证明没有重复入账。不要制造会计确认，不把脚本/Agent演示说成全税完成。\n目标：${JSON.stringify(manifest.target)}；期间2026-Q1，CNY。原始销售文件保持原字节。\n`,{flag:'wx'});
 console.log(JSON.stringify({status:'supplement_prepared_only',supplement,goal,modelInvoked:false,internalEntriesProvided:false}));
} else if(command==='assess'&&root) {
 const manifest=JSON.parse(readFileSync(join(root,'demo-manifest.json'),'utf8')),db=new DatabaseSync(manifest.target.dbPath,{readOnly:true});
 try{console.log(JSON.stringify({version:'harness-demo-assessment/1',scriptIsNotAgentDemonstration:true,vouchers:db.prepare('SELECT id,period,status FROM vouchers').all(),postedEntries:db.prepare("SELECT e.code,e.debit,e.credit FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE v.status='posted'").all(),requiredAgentEvidence:['actual_pi_version','actual_extension_load','MCP_call_trace','parser_child_tool_trace','saved_parser_and_validation','actual_business_receipt','remaining_blockers']}));}finally{db.close();}
} else {console.log('node scripts/harness-demo.mjs prepare <new-directory> | supplement <demo-directory> | assess <demo-directory>');process.exitCode=2;}

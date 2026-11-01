#!/usr/bin/env node
// 仅供本机操作者交互复核；不提供 --yes、stdin 批准或模型工具接口。
import { createInterface } from 'node:readline/promises';
import { db } from '../server/db.mjs';
import { readPostingReview, postingReviewPlan, savePostingReview } from '../server/posting-evidence-guard.mjs';
if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('posting_review_interactive_required');
const [setText,attemptId,...extra]=process.argv.slice(2),setId=Number(setText);
if(!Number.isSafeInteger(setId)||setId<=0||extra.length)throw Error('用法：node scripts/review-posting.mjs 账套ID 尝试ID');
const review=readPostingReview(db,setId,attemptId),plan=postingReviewPlan(db,setId,attemptId);
console.log(JSON.stringify({账套:setId,实际企业:review.begin.enterpriseKey,完整执行意图:plan.executionIntent,本次确认的候选范围:plan.members.map(m=>({尝试:m.attemptId,凭证:m.content,异常:m.issues,此前审核理由:m.priorReason??null,此前审核时间:m.priorReviewedAt??null,此前审核人:m.priorOperator??null})),凭证草稿:review.validation.content,异常:review.validation.issues,原件映射:review.validation.evidence,本次尝试:attemptId,说明:'仅确认具体版本的事实/证据异常；不修改日期或金额，不自动入账。'},null,2));
const rl=createInterface({input:process.stdin,output:process.stdout});
try{const operator=await rl.question('操作者姓名（声明）：'),reason=await rl.question('核对依据与接受理由：'),confirmation=await rl.question(`确认后请输入「确认 ${attemptId}」，否则回车退出：`);
 const result=savePostingReview(db,setId,attemptId,{operator,reason},confirmation,{expectedPlanDigest:plan.planDigest});console.log(JSON.stringify({审核记录:result.reviewId,下次提交必须使用的operationId:result.approvedOperationId,结果:'已记录。重新提交仍须通过全部正式入账守卫。'},null,2));
}finally{rl.close();db.close();}

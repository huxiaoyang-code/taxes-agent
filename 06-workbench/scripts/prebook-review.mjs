#!/usr/bin/env node
// 本机账前核对CLI；来源根与审计目录通过环境变量显式设置。
import {runPrebookReview} from '../server/finance-prebook.mjs';
const args=process.argv.slice(2),allowed=new Set(['--input','--replies']);
try{
 const options={};for(let i=0;i<args.length;i+=2){if(!allowed.has(args[i])||!args[i+1]||options[args[i]])throw Error('invalid_arguments');options[args[i]]=args[i+1];}
 if(!options['--input'])throw Error('usage: node prebook-review.mjs --input ABSOLUTE_INPUT_JSON [--replies ABSOLUTE_REPLIES_JSON]');
 const result=await runPrebookReview({inputPath:options['--input'],...(options['--replies']?{repliesPath:options['--replies']}:{})});process.stdout.write(JSON.stringify(result,null,2)+'\n');
}catch(error){process.stderr.write((/^finance_[a-z0-9_]+$/.test(error.code)?error.code:'prebook_review_failed')+'\n');process.exitCode=1;}

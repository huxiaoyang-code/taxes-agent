import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import test from 'node:test';

test('九个原生主技能各有一项实际请求和相邻业务反例，评分器区分两种宿主命名',()=>{
 const plugin=fileURLToPath(new URL('../',import.meta.url));
 const names=readdirSync(join(plugin,'skills')).filter(name=>readdirSync(join(plugin,'skills',name)).includes('SKILL.md')).sort();
 const cases=readdirSync(join(plugin,'evals'),{withFileTypes:true}).filter(entry=>entry.isDirectory()&&entry.name!=='results').map(entry=>entry.name);
 assert.equal(names.length,9);
 assert.deepEqual(cases.sort(),names.flatMap(name=>[name+'-neighbor',name+'-positive']).sort());
 for(const name of names)for(const kind of ['positive','neighbor']){
  const source=readFileSync(join(plugin,'evals',name+'-'+kind,'case.yaml'),'utf8');
  assert.match(source,/^schema_version: "1.1"$/m);assert.match(source,/allowed_tools: \[Read, Skill\]/);
  const prompt=source.match(/prompt: "([^"]+)"/)[1];assert.ok(!names.some(skill=>prompt.includes(skill)));
  const patterns=[...source.matchAll(/tool: Skill\s+input_match: '([^']+)'/g)].map(match=>new RegExp(match[1]));
  const reference={ 'journal-entry':'journal-entry-prep', 'tax-period':'close-management', 'internal-control-review':'audit-support' }[name];
  if(kind==='positive'&&reference)assert.ok(source.includes('tool: Read')&&source.includes(reference+'\\.md'));
  assert.equal(patterns.length,2);assert.match(source,/min: 0\n    max: 0/);
  for(const prefix of ['','finance:']){
   const selected=names.filter(s=>patterns[0].test(JSON.stringify({skill:prefix+s})));
   const avoided=names.filter(s=>patterns[1].test(JSON.stringify({skill:prefix+s})));
   assert.equal(selected.length,1);assert.equal(avoided.length,1);assert.notDeepEqual(selected,avoided);
   assert.equal(kind==='positive'?selected[0]:avoided[0],name);
  }
  assert.match(source,/type: regex\n    target: last_message/);
 }
});

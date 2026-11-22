import {realpathSync, readFileSync} from 'node:fs';
import {PLUGIN_SKILL_FILES} from '../../../../06-workbench/server/finance-skill-assets.mjs';
import {dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';

// 从本版本插件生成项目级原生技能。只带业务资料及其已有演示，不注册另一套 MCP。
export function projectSkillFiles(skillsDir) {
  const plugin = dirname(skillsDir);
  const version = JSON.parse(readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const files = [];
  const skills = [];
  for (const resource of PLUGIN_SKILL_FILES) {
    const path = join(skillsDir,resource);
    if (realpathSync(path) !== path) throw Error('host_skill_source_invalid');
    let content;
    if (resource === 'prebook-review/scripts/demo.mjs') {
      const source = JSON.stringify(pathToFileURL(path).href);
      content = 'import {runPrebookDemo} from ' + source + ';\nconst {summary}=await runPrebookDemo(process.argv[2]);\nconsole.log(JSON.stringify(summary,null,2));\n';
    } else if (resource.endsWith('.md')) {
      content = readFileSync(path,'utf8');
    } else {
      throw Error('host_skill_asset_unsupported');
    }
    if (/^[^/]+\/SKILL\.md$/.test(resource)) skills.push(resource.split('/')[0]);
    files.push({path:'.claude/skills/' + resource, content});
  }
  for (const name of ['SOURCES.md','CONNECTORS.md','LICENSE','LICENSE.knowledge-work-plugins']) {
    files.push({path:'.claude/' + name, content:readFileSync(join(plugin,name),'utf8')});
  }
  files.push({path:'.finance/skill-source.json',content:JSON.stringify({source:'project',plugin:'finance@taxes-agent',version,skills},null,2)+'\n'});
  return files;
}

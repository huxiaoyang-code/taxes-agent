// 只解析目录所需的 YAML 标量子集；不执行标签、锚点或隐式类型转换。
// 不支持的 frontmatter 明确标为 invalid，正文仍经原 skills_read 按需读取。
export function skillMetadata(resource, markdown, {includeRole = false} = {}) {
  const invalid = {resource, name:null, description:null, metadataState:'invalid'};
  if (typeof markdown !== 'string' || !markdown.replace(/^\uFEFF/, '').startsWith('---\n') && !markdown.replace(/^\uFEFF/, '').startsWith('---\r\n'))
    return {...invalid, metadataState:'missing'};
  const match = markdown.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match || match[1].length > 16384) return invalid;
  const values = new Map(), lines = match[1].split(/\r?\n/);
  for (let i=0;i<lines.length;i++) {
    const line=lines[i]; if (!line.trim() || /^\s*#/.test(line)) continue;
    const field=line.match(/^([a-z][a-z0-9-]*):[ \t]*(.*)$/); if (!field || values.has(field[1])) return invalid;
    let value=field[2];
    if (/^[|>][-+]?$/.test(value)) {
      const folded=value.startsWith('>'), parts=[];
      while (i+1<lines.length && /^(?:[ \t]+|$)/.test(lines[i+1])) parts.push(lines[++i].replace(/^ {2}/,''));
      if (!parts.length) return invalid; value=parts.join(folded?' ':'\n').trim();
    } else if (value.startsWith('"')) { try {value=JSON.parse(value);} catch {return invalid;} }
    else if (value.startsWith("'")) { if (!/^'(?:[^']|'')*'$/.test(value)) return invalid; value=value.slice(1,-1).replaceAll("''", "'"); }
    else { if (/^[!&*[{]|:\s|\s+#/.test(value)) return invalid; }
    if (typeof value!=='string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return invalid;
    values.set(field[1],value);
  }
  const name=values.get('name'),description=values.get('description');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name??'') || name.length>80 || !description?.trim() || description.length>2048) return invalid;
  const entry = {resource, name, description, metadataState:'valid'};
  if (includeRole) {
    // 本插件用 user-invocable: false 标识辅助参考。role 说明阅读顺序，执行权限仍由业务工具决定。
    const invocable = values.get('user-invocable');
    if (invocable !== undefined && invocable !== 'true' && invocable !== 'false') return invalid;
    entry.role = invocable === 'false' ? 'reference' : 'primary';
  }
  return entry;
}

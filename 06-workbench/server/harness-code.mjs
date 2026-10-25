import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { relative, dirname } from 'node:path';
export function captureHarnessCode(roots) {
  const found = new Map(), base = dirname(fileURLToPath(import.meta.url));
  const visit = url => { const path = fileURLToPath(url); if (found.has(path)) return; const bytes = readFileSync(path); found.set(path, createHash('sha256').update(bytes).digest('hex')); for (const m of bytes.toString().matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"\n]+\.mjs)['"]/g)) visit(new URL(m[1], url)); };
  roots.forEach(name => visit(new URL(name, import.meta.url)));
  const files = [...found].map(([path,digest]) => ({path:relative(base,path).replaceAll('\\','/'),digest})).sort((a,b)=>a.path.localeCompare(b.path));
  return { files, digest:createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}

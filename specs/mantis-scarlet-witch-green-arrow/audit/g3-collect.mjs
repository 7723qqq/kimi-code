import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(import.meta.dirname, '../../..');
const OUT = path.join(import.meta.dirname, 'g3');
const SHAS = ['1ec24a5f51','410814349d','482936afce','1c1544abaf','0ea324cafb','90d3a66c64','a09bf8573c','7e2c565e31'];
function git(args){const r=spawnSync('git',args,{cwd:ROOT,encoding:'utf8',maxBuffer:256*1024*1024}); if(r.status!==0) throw new Error(r.stderr); return r.stdout;}
for(const prefix of SHAS){const sha=git(['rev-parse',prefix]).trim(); const diff=git(['show','--no-renames','--format=fuller',sha]); const names=git(['diff-tree','-r','--no-commit-id','--name-status','--no-renames',sha]); fs.writeFileSync(path.join(OUT,`${prefix}.diff`),diff); fs.writeFileSync(path.join(OUT,`${prefix}.paths`),names); console.log(`${prefix}\tfiles=${names.trim().split(/\r?\n/).filter(Boolean).length}\tlines=${diff.split(/\r?\n/).length}`);}

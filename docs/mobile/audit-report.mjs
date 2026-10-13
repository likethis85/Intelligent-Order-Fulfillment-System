import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const outDir=path.dirname(fileURLToPath(import.meta.url));
const appDir=fileURLToPath(new URL('../../app/',import.meta.url));
const auditDir=path.join(process.env.TEMP,'marius-mobile-audit');
const json=async p=>JSON.parse((await fs.readFile(p,'utf8')).replace(/^\uFEFF/,''));
const before=await json(path.join(auditDir,'before.json'));
const allowed=new Set(['src/App.tsx','src/index.css','src/data/products.ts','src/lib/traySync.ts',...['BoardPage','ConfigPage','ProfilePage','SequencePage','TraysPage','WeatherPage'].map(n=>`src/sections/${n}.tsx`)]);
const files=[];
for(const entry of before){
  const currentHash=createHash('sha256').update(await fs.readFile(path.join(appDir,entry.path))).digest('hex').toUpperCase();
  const rel=entry.path.replaceAll('\\','/');
  files.push({path:rel,beforeHash:entry.hash,currentHash,unchanged:entry.hash===currentHash,allowed:allowed.has(rel)});
}
const unexpected=files.filter(f=>!f.unchanged&&!f.allowed);
const protectedFiles=files.filter(f=>!allowed.has(f.path));
const lintBefore=await json(path.join(auditDir,'lint-before.json'));
const lintAfter=await json(path.join(auditDir,'lint-after.json'));
const summary=items=>({errors:items.reduce((n,f)=>n+f.errorCount,0),warnings:items.reduce((n,f)=>n+f.warningCount,0)});
function lintSignatures(items,marker){
  const signatures=new Map();
  for(const file of items){
    const rel=file.filePath.replaceAll('\\','/').split(marker).at(-1);
    for(const message of file.messages){
      const signature=[rel,message.ruleId,message.severity,message.message.split('\n')[0]].join('|');
      signatures.set(signature,(signatures.get(signature)||0)+1);
    }
  }
  return signatures;
}
const originalSignatures=lintSignatures(lintBefore,'/src-original/');
const currentSignatures=lintSignatures(lintAfter,'/src/');
const newLintMessages=[...currentSignatures].filter(([key,count])=>count>(originalSignatures.get(key)||0));
const results={
  originalFileCount:files.length,
  changedSourceFiles:files.filter(f=>!f.unchanged).map(f=>f.path),
  protectedFileCount:protectedFiles.length,
  protectedFilesUnchanged:protectedFiles.every(f=>f.unchanged),
  unexpectedChanges:unexpected.map(f=>f.path),
  lint:{before:summary(lintBefore),after:summary(lintAfter),newMessageCount:newLintMessages.length,newMessages:newLintMessages},
  sourceAudit:files,
};
await fs.writeFile(path.join(outDir,'audit-results.json'),JSON.stringify(results,null,2));
await fs.writeFile(path.join(outDir,'build-before.txt'),await fs.readFile(path.join(auditDir,'build-before.txt')));
await fs.writeFile(path.join(outDir,'build-after.txt'),await fs.readFile(path.join(auditDir,'build-after.txt')));
await fs.writeFile(path.join(outDir,'execution-log.json'),JSON.stringify({
  requestedExecutor:'OpenCode',
  version:'1.19.0',
  executionDirectory:'系统临时目录中的无凭证前端副本',
  attempts:await Promise.all(['opencode-run.jsonl','opencode-retry.jsonl'].map(async filename=>{
    const events=(await fs.readFile(path.join(auditDir,filename),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    const error=events.find(e=>e.type==='error');
    return {model:filename.includes('retry')?'opencode/big-pickle':'opencode/mimo-v2.6-flash-free',result:'failed',httpStatus:error?.error?.data?.statusCode,message:error?.error?.data?.message};
  })),
  userDecision:'用户选择：由 Codex 继续完成适配（推荐）',
  actualExecutor:'Codex',
  completedTasks:['T01','T02','T03','T04','T05','T06','T07','T08','T09'],
},null,2));
console.log(JSON.stringify({changed:results.changedSourceFiles,protectedFileCount:results.protectedFileCount,protectedFilesUnchanged:results.protectedFilesUnchanged,unexpectedChanges:results.unexpectedChanges,lint:results.lint}));
if(unexpected.length||newLintMessages.length)process.exitCode=1;

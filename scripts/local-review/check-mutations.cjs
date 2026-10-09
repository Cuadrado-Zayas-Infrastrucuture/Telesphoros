// Mutations are temporary, serial and restored in finally. Synthetic source only.
const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
const cases=[
["apps/frontend/src/pages/LocalReviewPage.tsx","preview-pdf-hash","capture.pdfSha256==='6b6d2a4578ac5ca2ac49db080d440320f3341b81ea0b81a7e29113a166c893f0'","true"],
["apps/frontend/src/pages/LocalReviewPage.tsx","comparison-required","busy || !compared || !roles.includes","busy || false || !roles.includes"],
["apps/frontend/src/pages/LocalReviewPage.tsx","capture-reviewer-role","!roles.includes('reviewer')","false"],
["apps/frontend/src/pages/LocalReviewPage.tsx","accepted-decision","busy || capture.latestDecision?.decision!=='accepted'","busy"],
["apps/frontend/src/pages/LocalReviewPage.tsx","local-file-origin","new URL(value.url).origin!==localStorageOrigin()","false"],
["apps/frontend/src/lib/localReportApi.ts","configured-emulator-origin","parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.origin !== value","false"],
['scripts/local-review/local-poppler-runner.cjs','extractor-version','if(!/^pdftotext version 26\\.03\\.0\\r?\\n/.test(result.stderr.toString(\'utf8\')))','if(false)',true],
['scripts/local-review/local-poppler-runner.cjs','binary-drift','if(hash(await readFile(this.binary))!==this.binaryHash)','if(false)',true],
['scripts/local-review/local-poppler-runner.cjs','source-allowlist','if(hash(pdf)!==PDF_HASH)','if(false)',true],
['scripts/local-review/local-poppler-runner.cjs','text-oracle',"return {text,popplerVersion:'26.03.0'}","return {text:'wrong',popplerVersion:'26.03.0'}",true],
['apps/frontend/src/pages/LocalOperationsPage.tsx','explicit-confirmation','busy || !reviewer || !confirmed','busy || !reviewer'],
['apps/frontend/src/pages/LocalOperationsPage.tsx','reviewer-role','busy || !reviewer || !confirmed','busy || !confirmed'],
['apps/frontend/src/pages/LocalOperationsPage.tsx','changed-cell-confirmation','setRow(e.target.value);setConfirmed(false);','setRow(e.target.value);'],
['apps/frontend/src/pages/LocalOperationsPage.tsx','admin-ledger-control',"roles.includes('admin') &&",'true &&'],
];
for(const [file,name,old,replacement,poppler] of cases){const target=path.join(root,file);const original=fs.readFileSync(target,'utf8');if(!original.includes(old))throw new Error('Mutation anchor missing: '+name);try{fs.writeFileSync(target,original.replaceAll(old,replacement));const result=spawnSync(poppler?process.execPath:'pnpm',poppler?['--test','scripts/local-review/local-poppler-runner.test.cjs']:['--filter','@telesphoros/frontend','exec','vitest','run',file.includes('LocalReviewPage')?'src/pages/LocalReviewPage.test.tsx':file.includes('localReportApi')?'src/lib/localReportApi.test.ts':'src/pages/LocalOperationsPage.test.tsx','--maxWorkers=1'],{cwd:root,encoding:'utf8',timeout:60000});if(!result.status||!/not ok|failed/.test(result.stdout))throw new Error('Mutation survived or lacked assertion evidence: '+name);console.log('CAUGHT '+name);}finally{fs.writeFileSync(target,original);}}

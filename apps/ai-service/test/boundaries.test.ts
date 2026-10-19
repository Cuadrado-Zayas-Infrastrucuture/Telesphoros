import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';
import ts from 'typescript';
import { expect, test } from 'vitest';
import { liveReadiness, syntheticProfile, validProfile } from '../src/policy';
import { runSynthetic } from '../src/kernel';
import { outcomeSchema } from '../src/contracts';
import { scenario } from './helpers/memory-adapters';

const root=fileURLToPath(new URL('..',import.meta.url));
function sourceAllowed(source: string): boolean {
  const f=ts.createSourceFile('boundary.ts',source,ts.ScriptTarget.Latest,true);let allowed=true;
  function visit(n: ts.Node) {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const name=n.moduleSpecifier.text;
      if (!(name==='zod' || name==='node:crypto' || /^\.\/[a-z-]+$/.test(name))) allowed=false;
    }
    if (ts.isIdentifier(n) && ['process','fetch','WebSocket','XMLHttpRequest','eval','Function','require'].includes(n.text)) allowed=false;
    if (n.kind===ts.SyntaxKind.ImportKeyword) allowed=false;
    ts.forEachChild(n,visit);
  }
  visit(f);return allowed;
}
test('P1-26 refuses live models and harness disabled', () => {
  expect(validProfile({ ...syntheticProfile(),enableModel:true,endpoint:'https://fixture.invalid' })).toBe(false);
  for(const source of ["import x from 'harness2';",'fetch("fixture");','process.env.ENABLE_MODEL','import("provider")']) expect(sourceAllowed(source)).toBe(false);
  expect(liveReadiness()).toEqual({ ready:false,reasonCode:'MODEL_EXECUTION_DISABLED' });
});
test('P1-26 permits live models and harness disabled control', async () => {
  const pkg=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8'));
  expect(Object.keys(pkg.dependencies).sort()).toEqual(['@telesphoros/jobs','zod']);
  expect(Object.keys(pkg.scripts).sort()).toEqual(['build','lint','prebuild','pretest','pretypecheck','test','test:durable:pg','typecheck']);
  for(const file of readdirSync(resolve(root,'src')).filter(p=>p.endsWith('.ts'))) expect(sourceAllowed(readFileSync(resolve(root,'src',file),'utf8')),file).toBe(true);
  const s=scenario();const r=await runSynthetic(s.request,s.context,s.ports);expect(r.counters.actualModelCalls).toBe(0);expect(r.counters.actualInferenceCharges).toBe(0);expect(liveReadiness().ready).toBe(false);
});
test('P1-27 refuses fixture and production boundary', () => {
  expect(sourceAllowed('export * from "../test/fixtures/synthetic-sop";')).toBe(false);
  const exports=readFileSync(resolve(root,'src/index.ts'),'utf8');expect(exports).not.toMatch(/memory-adapters|synthetic-sop|ReleaseReceipt|InvocationReceipt/);
});
test('P1-27 permits fixture and production boundary control', async () => {
  await build({ entry:[resolve(root,'src/index.ts')],outDir:resolve(root,'dist'),format:['esm','cjs'],dts:false,clean:true,silent:true });
  for(const f of ['index.js','index.cjs']) {
    const body=readFileSync(resolve(root,'dist',f),'utf8');expect(body).not.toContain('Record the ticket reference');expect(body).not.toContain('MemoryStore');expect(body).not.toContain('SYNTHETIC_CANARY');
  }
  const s=scenario();const r=await runSynthetic(s.request,s.context,s.ports);
  expect(outcomeSchema.safeParse(r).success).toBe(true);expect(outcomeSchema.safeParse({ ...r,ledgerEventRef:'forged' }).success).toBe(false);
  expect(r.schemaVersion).toBe('synthetic.business-outcome.v1');expect(r.simulationReceiptRef).toMatch(/^simulation:/);expect('ledgerEventRef' in r).toBe(false);expect('releaseReceiptRef' in r).toBe(false);
});

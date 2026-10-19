import { afterEach, describe, expect, test, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { JobQueue } from '@telesphoros/jobs';
import { SyntheticJobQueue } from '../durable/queue';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Every static or dynamic module specifier and every forbidden ambient identifier in one source file. */
function scan(source: string) {
  const file = ts.createSourceFile('scan.ts', source, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const ambient = new Set<string>();
  const forbidden = ['process', 'fetch', 'WebSocket', 'XMLHttpRequest', 'eval', 'Function', 'require', 'setTimeout', 'setInterval',
    'setImmediate', 'queueMicrotask', 'globalThis'];
  const visit = (n: ts.Node) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier))
      specifiers.push(n.moduleSpecifier.text);
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) specifiers.push('<dynamic import>');
    if (ts.isIdentifier(n) && forbidden.includes(n.text) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) ambient.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(file);
  return { specifiers, ambient: [...ambient] };
}

/** Resolve the transitive relative-import graph from one entry, returning every file and every bare package it reaches. */
function graph(entry: string) {
  const files = new Set<string>();
  const packages = new Set<string>();
  const walk = (path: string) => {
    if (files.has(path)) return;
    files.add(path);
    for (const spec of scan(readFileSync(path, 'utf8')).specifiers) {
      if (!spec.startsWith('.')) { packages.add(spec); continue; }
      const base = resolve(dirname(path), spec);
      const target = [`${base}.ts`, resolve(base, 'index.ts')].find(existsSync);
      if (!target) throw new Error(`UNRESOLVED ${spec} from ${path}`);
      walk(target);
    }
  };
  walk(entry);
  return { files: [...files].map(f => f.slice(root.length)), packages: [...packages].sort() };
}

describe('durable surface: reachability, imports and inherited queue methods', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  test('P2-01 the root entry reaches only P1 source and zod: never durable, jobs, pg or test fixtures', () => {
    const reach = graph(resolve(root, 'src/index.ts'));
    expect(reach.packages).toEqual(['node:crypto', 'zod']);
    expect(reach.files.every(f => f.startsWith('src/'))).toBe(true);
    // Positive control: the walker does find a durable edge when one exists.
    expect(graph(resolve(root, 'durable/job.ts')).files).toContain('durable/kernel.ts');
  });

  test('P2-02 durable modules import only an allowlist and touch no process, network, timer or dynamic import', () => {
    const allowed = ['zod', 'node:crypto', '@telesphoros/jobs', '../src/contracts', '../src/evidence',
      './contracts', './kernel', './queue'];
    const files = readdirSync(resolve(root, 'durable')).filter(f => f.endsWith('.ts')).sort();
    expect(files).toEqual(['contracts.ts', 'job.ts', 'kernel.ts', 'postgres.ts', 'queue.ts']);
    for (const f of files) {
      const { specifiers, ambient } = scan(readFileSync(resolve(root, 'durable', f), 'utf8'));
      expect.soft({ f, extra: specifiers.filter(s => !allowed.includes(s)), ambient }).toEqual({ f, extra: [], ambient: [] });
    }
    // Positive controls: the scanner sees each forbidden form.
    expect(scan("import pg from 'pg'; setTimeout(() => 0); await import('x'); process.env.X").ambient.sort())
      .toEqual(['process', 'setTimeout']);
    expect(scan("await import('x')").specifiers).toEqual(['<dynamic import>']);
  });

  test('P2-02 importing every durable module and building the job starts no timer, request or environment read', async () => {
    const timers = [vi.spyOn(globalThis, 'setTimeout'), vi.spyOn(globalThis, 'setInterval'), vi.spyOn(globalThis, 'setImmediate')];
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const envReads: string[] = [];
    const env = process.env;
    vi.stubGlobal('process', { ...process, env: new Proxy(env, { get(t, k) { envReads.push(String(k)); return Reflect.get(t, k); } }) });
    vi.resetModules();
    const [{ syntheticTestJob }, { PostgresSyntheticStore }, queueModule] = await Promise.all([
      import('../durable/job'), import('../durable/postgres'), import('../durable/queue'), import('../durable/kernel'), import('../durable/contracts')]);
    const db = { async query(): Promise<never> { throw new Error('unexpected database access'); } };
    const store = new PostgresSyntheticStore(db, { async withTenant() { throw new Error('unexpected app access'); } });
    syntheticTestJob(new queueModule.SyntheticJobQueue(db), store, { draft: async () => { throw new Error('actor'); },
      director: async () => { throw new Error('actor'); } });
    expect({ timers: timers.map(t => t.mock.calls.length), fetch: fetch.mock.calls.length, envReads })
      .toEqual({ timers: [0, 0, 0], fetch: 0, envReads: [] });
  });

  test('P2-03 every JobQueue method is either fenced by the synthetic queue or an explicit read-only exception', () => {
    const methods = (proto: object) => Object.getOwnPropertyNames(proto).filter(m => m !== 'constructor').sort();
    const inherited = methods(JobQueue.prototype);
    const overridden = methods(SyntheticJobQueue.prototype);
    // Read-only bookkeeping the Runner may call; neither claims, settles nor schedules work.
    const readOnly = ['stats', 'workerSeen'];
    expect(inherited.filter(m => !overridden.includes(m))).toEqual(readOnly);
    // A new shared queue method fails this test until it is fenced or reviewed into the exception list.
    expect(overridden).toEqual(expect.arrayContaining(['claim', 'fail', 'heartbeat', 'release', 'relayOutbox', 'scheduleTick', 'succeed']));
  });
});

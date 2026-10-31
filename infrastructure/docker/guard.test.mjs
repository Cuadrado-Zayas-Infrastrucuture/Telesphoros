import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
const text=readFileSync(new URL('api.Dockerfile',import.meta.url),'utf8');
export function problems(source){
  const lines=source.split('\n').filter(l=>!l.trim().startsWith('#')).join('\n');
  const rules=[
    ['base',()=>{const from=[...lines.matchAll(/^FROM (\S+) AS (\w+)$/gm)];return from.length===2 && from.every(m=>/^node:22\.22\.0-bookworm-slim@sha256:[0-9a-f]{64}$/.test(m[1]));}],
    ['OS fixes',()=>['libcap2=1:2.66-4+deb12u3+b1','libgnutls30=3.7.9-2+deb12u7','libpcre2-8-0=10.42-1+deb12u2','perl-base=5.36.0-7+deb12u4','libc6=2.36-9+deb12u14','libc-bin=2.36-9+deb12u14','dpkg=1.21.23'].every(pin=>lines.includes(pin))],
    ['installer removal',()=>lines.includes('/usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx')],
    ['pnpm',()=>lines.includes('pnpm@10.28.0')],
    ['frozen',()=>lines.includes('pnpm fetch --frozen-lockfile')&&lines.includes('pnpm install --frozen-lockfile --offline')],
    ['prod',()=>/pnpm --filter @telesphoros\/backend deploy --legacy --prod \/output/.test(lines)],
    ['worker bundle',()=>lines.includes('pnpm --filter @telesphoros/worker build')&&lines.includes('cp apps/worker/dist/main.js /output/worker/main.js')&&!/COPY .*worker.*\.map/.test(lines)],
    ['dependency graph',()=>lines.includes('dependency-graph.cjs record') && lines.includes('dependency-graph.cjs compare')],
    ['CA build check',()=>lines.includes('sha256sum --check global-bundle.sha256')],
    ['production',()=>/ENV NODE_ENV=production NODE_EXTRA_CA_CERTS=\/opt\/telesphoros\/ca\/global-bundle.pem/.test(lines)],
    ['nonroot',()=>/^USER 10001:10001$/m.test(lines)],
    ['exec entrypoint',()=>/^ENTRYPOINT \["node"\]$/m.test(lines)&&/^CMD \["dist\/main.js"\]$/m.test(lines)],
    ['no credential ARG',()=>!/^ARG\s+/m.test(lines)],
    ['no healthcheck',()=>!/^HEALTHCHECK\b/m.test(lines)],
    ['no runtime installers',()=>!/^RUN.*(?:npm|pnpm|pip).*install/m.test(lines.split('AS runtime')[1] || '')],
  ];
  return rules.filter(([,check])=>!check()).map(([name])=>name);
}
test('Dockerfile contract (control)',()=>assert.deepEqual(problems(text),[]));
const mutations=[
 ['OS fixes',s=>s.replace('libcap2=1:2.66-4+deb12u3+b1','libcap2')],
 ['OS fixes',s=>s.replace('libc6=2.36-9+deb12u14 ','')],
 ['OS fixes',s=>s.replace('dpkg=1.21.23','dpkg')],
 ['installer removal',s=>s.replace('/usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx','/unused')],
 ['base',s=>s.replace(/@sha256:[0-9a-f]{64}/g,'')],
 ['pnpm',s=>s.replace('pnpm@10.28.0','pnpm@latest')],
 ['frozen',s=>s.replace('--frozen-lockfile','')],
 ['frozen',s=>s.replace('pnpm install --frozen-lockfile','pnpm install')],
 ['frozen',s=>s.replace(' --offline','')],
 ['prod',s=>s.replace('deploy --legacy --prod','deploy --legacy')],
 ['worker bundle',s=>s.replace('pnpm --filter @telesphoros/worker build','true')],
 ['worker bundle',s=>s.replace('cp apps/worker/dist/main.js /output/worker/main.js','true')],
 ['dependency graph',s=>s.replace('dependency-graph.cjs compare','dependency-graph.cjs ignored')],
 ['CA build check',s=>s.replace('sha256sum --check','true #')],
 ['production',s=>s.replace('NODE_ENV=production','NODE_ENV=development')],
 ['nonroot',s=>s.replace('USER 10001:10001','USER 0:0')],
 ['exec entrypoint',s=>s.replace('ENTRYPOINT ["node"]','ENTRYPOINT node')],
 ['no credential ARG',s=>s+'\nARG TOKEN\n'],
 ['no healthcheck',s=>s+'\nHEALTHCHECK CMD true\n'],
 ['no runtime installers',s=>s+'\nRUN npm install jest\n'],
];
for(const [rule,mutate] of mutations)test(`detects ${rule} defect`,()=>assert.ok(problems(mutate(text)).includes(rule)));
test('public CA bytes match owner-confirmed pin',()=>{
 const bytes=readFileSync(new URL('global-bundle.pem',import.meta.url));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),'fe45bbebf92ad3e27a583bbb2ddd1553c521ed4d49af5514dc0a40372ea5395c');
 assert.equal(bytes.length,169984);assert.equal((bytes.toString().match(/BEGIN CERTIFICATE/g)||[]).length,111);
});

// Local pilot credentials must stay out of the root API build context too.
const rootIgnore = readFileSync(new URL('../../.dockerignore', import.meta.url), 'utf8');
export function pilotContextProblems(source) {
  const lines = source.split('\n').map(line => line.trim());
  return ['packages/smart-pilot/openemr/.runtime', 'packages/smart-pilot/dist-ui']
    .filter(pattern => !lines.includes(pattern));
}
test('root build context excludes synthetic pilot runtime and viewer output', () => {
  assert.deepEqual(pilotContextProblems(rootIgnore), []);
});
for (const pattern of ['packages/smart-pilot/openemr/.runtime', 'packages/smart-pilot/dist-ui']) {
  test(`detects missing pilot context exclusion: ${pattern}`, () => {
    const valid = `${rootIgnore}\npackages/smart-pilot/openemr/.runtime\npackages/smart-pilot/dist-ui\n`;
    assert.ok(pilotContextProblems(valid.split('\n').filter(line => line !== pattern).join('\n')).includes(pattern));
  });
}

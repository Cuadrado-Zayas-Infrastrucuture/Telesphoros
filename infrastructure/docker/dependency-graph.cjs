// Build-only: inspect actual installed production dependencies, not resolver output.
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
function graph(root) {
  const rows=new Set(),visited=new Set();
  function visit(file) {
    file=fs.realpathSync(file); if(visited.has(file))return; visited.add(file);
    const pkg=JSON.parse(fs.readFileSync(file)); const req=createRequire(file);
    for(const name of Object.keys({...pkg.dependencies,...pkg.optionalDependencies})) {
      const found=req.resolve.paths(name).map(p=>path.join(p,name,'package.json')).find(p=>fs.existsSync(p));
      if(!found) {if(pkg.optionalDependencies?.[name])continue;throw new Error(`missing production dependency ${name}`);}
      const dep=JSON.parse(fs.readFileSync(found));
      rows.add(`${pkg.name}@${pkg.version} -> ${name}@${dep.version}`);
      visit(found);
    }
  }
  visit(path.join(root,'package.json'));
  assert.ok(rows.size>100,'empty/incomplete production graph');return [...rows].sort();
}
if(process.argv[2]==='record')fs.writeFileSync('/tmp/locked-production.json',JSON.stringify(graph('/workspace/apps/backend')));
else assert.deepEqual(graph('/output'),JSON.parse(fs.readFileSync('/tmp/locked-production.json')),'deployed production dependency graph differs from frozen workspace');

// Keep the first-step bootstrap byte-identical to the canonical module; CI guards reject drift.
import { readFileSync, writeFileSync } from 'node:fs';
const module = readFileSync(new URL('./service-deadline.mjs', import.meta.url), 'utf8');
const file = new URL('../workflows/ci.yml', import.meta.url);
const workflow = readFileSync(file, 'utf8');
const start = workflow.indexOf("          (set -o noclobber; cat > \"$RUNNER_TEMP/service-deadline.mjs\") <<'SERVICE_DEADLINE'\n");
const body = start < 0 ? -1 : workflow.indexOf('\n', start) + 1;
const end = workflow.indexOf('          SERVICE_DEADLINE\n', body);
if (body < 0 || end < body) throw new Error('Service deadline bootstrap boundary missing.');
writeFileSync(file, workflow.slice(0, body) + module.split('\n').slice(0, -1).map(l => l ? '          ' + l + '\n' : '\n').join('') + workflow.slice(end));

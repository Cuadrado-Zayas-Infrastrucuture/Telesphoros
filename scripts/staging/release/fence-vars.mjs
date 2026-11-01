// Preserve every unrelated byte of the canonical tfvars file; never evaluate HCL or print its values.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function fenceVars(source, mode) {
  if (!['FENCE-CLOSE', 'FENCE-OPEN'].includes(mode) || typeof source !== 'string' || source.length > 1024 * 1024 || /\r|\0|\/\*|\*\/|<</.test(source))
    throw new Error('unsupported fence var file or mode');
  const lines = source.split('\n');
  const assignments = lines.map((line, index) => /^\s*medication_writes_enabled\s*=/.test(line) ? index : -1).filter((index) => index >= 0);
  if (assignments.length > 1) throw new Error('duplicate medication-write assignment');
  const replacement = `medication_writes_enabled = ${mode === 'FENCE-OPEN' ? 'true' : 'false'}`;
  if (assignments.length) {
    const index = assignments[0];
    if (!/^\s*medication_writes_enabled\s*=\s*(true|false)\s*(?:(?:#|\/\/).*)?$/.test(lines[index])) throw new Error('medication-write assignment must be a literal boolean');
    lines[index] = replacement;
    return lines.join('\n');
  }
  return `${source}${source.endsWith('\n') || !source ? '' : '\n'}${replacement}\n`;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const [command, source, destination, mode] = process.argv.slice(2);
    if (!['create', 'check'].includes(command) || !source || !destination || process.argv.length !== 6) throw new Error();
    const target = fenceVars(readFileSync(source, 'utf8'), mode);
    if (command === 'create') writeFileSync(destination, target, { flag: 'wx', mode: 0o600 });
    else if (readFileSync(destination, 'utf8') !== target) throw new Error();
  } catch {
    console.error('REFUSED: fence var file is invalid, already exists or differs beyond the reviewed flag');
    process.exitCode = 1;
  }
}

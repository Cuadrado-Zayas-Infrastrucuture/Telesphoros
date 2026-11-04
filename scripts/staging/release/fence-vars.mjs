// Preserve every unrelated byte of the canonical tfvars file; never evaluate HCL or print its values.
// The reviewed one-flag transitions: each mode sets exactly one boolean variable, and nothing else in the file may change.
//   FENCE-CLOSE / FENCE-OPEN         medication_writes_enabled = false / true
//   ASSESSMENT-OFF / ASSESSMENT-ON   synthetic_assessment_enabled = false / true   (spec 032 S3, PR 3c-3a)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FLAGS = {
  'FENCE-CLOSE': ['medication_writes_enabled', false],
  'FENCE-OPEN': ['medication_writes_enabled', true],
  'ASSESSMENT-OFF': ['synthetic_assessment_enabled', false],
  'ASSESSMENT-ON': ['synthetic_assessment_enabled', true],
};
export const FLAG_MODES = Object.keys(FLAGS);

export function fenceVars(source, mode) {
  if (!FLAG_MODES.includes(mode) || typeof source !== 'string' || source.length > 1024 * 1024 || /\r|\0|\/\*|\*\/|<</.test(source))
    throw new Error('unsupported fence var file or mode');
  const [name, value] = FLAGS[mode];
  const lines = source.split('\n');
  const assignments = lines.map((line, index) => new RegExp(`^\\s*${name}\\s*=`).test(line) ? index : -1).filter((index) => index >= 0);
  if (assignments.length > 1) throw new Error('duplicate flag assignment');
  const replacement = `${name} = ${value}`;
  if (assignments.length) {
    const index = assignments[0];
    if (!new RegExp(`^\\s*${name}\\s*=\\s*(true|false)\\s*(?:(?:#|\\/\\/).*)?$`).test(lines[index])) throw new Error('flag assignment must be a literal boolean');
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

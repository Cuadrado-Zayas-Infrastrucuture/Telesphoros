// Test-process bridge: credentials arrive only on stdin, never argv, logs or result JSON.
import { createStoredPgxReader } from '../dist/stored-pgx.js';
import { validate } from './fhir-r4/validate.js';
let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const { config, selection, clinician, binding } = JSON.parse(input);
  const result = await createStoredPgxReader(config)(selection, clinician, binding);
  process.stdout.write(JSON.stringify({ ...result, schemaValid: result.bundle ? validate(result.bundle) : false, ...(result.bundle ? {} : { withheld: true }) }));
} catch {
  process.stdout.write(JSON.stringify({ withheld: true }));
}

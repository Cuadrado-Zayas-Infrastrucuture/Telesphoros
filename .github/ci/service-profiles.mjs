// Which backend profiles a run must prove. One function, read by the joining gate's dependency check, its evidence collector and both recovery validators,
// so they cannot disagree about the set.
//   all three   a nightly or manual run, any run the scope could not narrow, and any run whose `changes` job did not succeed
//   two         a pull request or push: memory and PostgreSQL + S3 (the standalone PostgreSQL profile runs in the nightly)
// Only an explicit success of `changes` with output postgres == 'false' narrows the set. A missing, failed, skipped or unrecognised value cannot.
export const allProfiles = Object.freeze(['memory', 'postgres', 'postgres-s3']);
export const reducedProfiles = Object.freeze(['memory', 'postgres-s3']);

export function expectedProfiles(needs) {
  if (!needs || typeof needs !== 'object' || Array.isArray(needs)) throw new Error('Service evidence validation failed.');
  const changes = needs.changes;
  return changes?.result === 'success' && changes.outputs?.postgres === 'false' ? reducedProfiles : allProfiles;
}

/** The expected set for a CLI validator: from the gate's SERVICE_NEEDS when present, otherwise all three. */
export function profilesFromEnv(env = process.env) {
  return env.SERVICE_NEEDS === undefined ? allProfiles : expectedProfiles(JSON.parse(env.SERVICE_NEEDS));
}

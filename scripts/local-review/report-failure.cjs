// What a verify script prints when a check fails: the error code, the script and line that failed and, for a failed assertion, the two values it
// compared when they are short plain numbers or words. Never an object, a header or a token: those can hold credentials, and these assertions
// compare status codes and outcome words.
const SAFE_VALUE = /^[\w .:/-]{0,40}$/;

function describe(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string' && SAFE_VALUE.test(value)) return JSON.stringify(value);
  return undefined;
}

function reportFailure(e) {
  console.error(e?.code ?? e?.name);
  const at = String(e?.stack ?? '').match(/(verify-[\w-]+\.cjs):(\d+)/);
  if (at) console.error(`  failed at ${at[1]} line ${at[2]}`);
  if (e?.name === 'AssertionError') {
    const got = describe(e.actual);
    const want = describe(e.expected);
    if (got !== undefined && want !== undefined) console.error(`  got ${got}, expected ${want}`);
  }
  console.error('FAIL local upload checks (no token/configuration output)');
  process.exitCode = 1;
}

module.exports = { reportFailure };

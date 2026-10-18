// Synthetic diagnostic records only. Callers pass named phases/counters, never SQL, values or errors.
const fs = require('node:fs');
const { isAbsolute, join } = require('node:path');
const { performance } = require('node:perf_hooks');
const limits = { 'setup.jsonl': 4 * 1024 * 1024, 'pg-watch.jsonl': 4 * 1024 * 1024, 'preload.jsonl': 128 * 1024 };

function emitter(name, directory = process.env.FIXTURE_CAPTURE_DIR, stream = false) {
  if (!Object.hasOwn(limits, name) || !directory || !isAbsolute(directory)) throw new Error('Invalid capture destination.');
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid capture directory.');
  const file = join(directory, name);
  const fd = fs.openSync(file, 'a', 0o600); fs.closeSync(fd);
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('Invalid capture file.');
  let failed = false;
  return record => {
    if (failed) return;
    const line = JSON.stringify({ ...record, pid: process.pid, wallMs: Date.now(), monoMs: performance.now() }) + '\n';
    try {
      if (fs.statSync(file).size + Buffer.byteLength(line) > limits[name]) throw new Error('Capture size limit.');
      fs.appendFileSync(file, line);
      if (stream) process.stdout.write('[fixture-capture] ' + line);
    } catch {
      failed = true;
      // A diagnostic I/O failure must not replace the application's thrown/rejected object.
      // The final verifier rejects any error record or absent required records.
      const error = JSON.stringify({ event: 'capture-error', source: name, pid: process.pid }) + '\n';
      try {
        const target = join(directory, 'capture-errors.jsonl');
        if (!fs.existsSync(target) || fs.statSync(target).size < 16 * 1024) fs.appendFileSync(target, error, { mode: 0o600 });
      } catch { /* Missing required records also make final verification fail. */ }
      process.stderr.write('Fixture capture recording failed.\n');
    }
  };
}

function safeCode(error) { return /^[A-Z0-9_]{1,24}$/.test(error?.code ?? '') ? error.code : null; }
module.exports = { emitter, safeCode, limits };

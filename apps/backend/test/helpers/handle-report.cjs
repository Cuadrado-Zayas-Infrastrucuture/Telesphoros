/* global module, process */
// Opt-in diagnostic (JEST_HANDLE_REPORT=1): what still holds the Jest process open once every test file is done.
// --detectOpenHandles cannot do this: Jest skips TCP and TLS client sockets (@jest/core build/index.js, collectHandles), which is every
// pg and S3 connection. Valid because the tier runs in band: test code runs in this process.
module.exports = async () => {
  const lines = [];
  for (const handle of process._getActiveHandles()) {
    if (handle === process.stdout || handle === process.stderr || handle === process.stdin) continue;
    const kind = handle.constructor && handle.constructor.name;
    if (kind === 'Socket') lines.push(`Socket to ${handle.remoteAddress}:${handle.remotePort} (local port ${handle.localPort}, destroyed ${handle.destroyed})`);
    else if (kind === 'Server') lines.push(`Server listening ${JSON.stringify(handle.address && handle.address())}`);
    else if (kind === 'ChildProcess') lines.push(`ChildProcess pid ${handle.pid}`);
    else lines.push(String(kind));
  }
  process.stderr.write(`[handles] ${lines.length} handle(s) held after all test files\n${lines.map((line) => `[handles]   ${line}\n`).join('')}`);
};

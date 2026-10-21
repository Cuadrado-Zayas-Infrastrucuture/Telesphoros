/* eslint-disable @typescript-eslint/no-require-imports -- Jest loads a test environment as plain CommonJS; it is not transformed. */
/* global require, module, process, setTimeout, clearTimeout */
// The Node test environment, plus one job at the end of each test file: reclaim fixtures whose owner is gone (see fixture-registry.ts).
//
// Why an environment and not an afterAll in a setup file: a setup file's afterAll runs BEFORE the spec's own afterAll (measured on
// jest-circus 30.5.2), so it could close an application the spec still uses. `run_finish` comes after every hook of the file, while the
// module registry is still alive. Jest tears the registry down first and the environment second, and a database drop needs a lazy
// `require` inside pg, so the environment's own teardown() is too late.
const path = require('node:path');
const { createRequire } = require('node:module');

// jest-environment-node is not a dependency of this package (pnpm does not expose it); take the copy jest itself uses.
const fromJest = createRequire(require.resolve('jest/package.json'));
const { TestEnvironment: NodeEnvironment } = createRequire(fromJest.resolve('jest-config/package.json'))('jest-environment-node');

const REGISTRY = Symbol.for('telesphoros.test.fixture-registry');
// A build that never settles must not hold the file forever; the hosted step has its own, larger, deadline.
const SETTLE_MS = 20_000;

class FixtureEnvironment extends NodeEnvironment {
  constructor(config, context) {
    super(config, context);
    this.label = path.relative(config.globalConfig.rootDir, context.testPath);
  }

  async handleTestEvent(event) {
    if (event.name === 'run_finish') await this.reclaim();
  }

  async reclaim() {
    const registry = this.global[REGISTRY];
    if (!registry || (registry.building.size === 0 && registry.live.size === 0)) return;
    const building = [...registry.building];
    for (const build of building) build.abort(new Error('The test file ended while a fixture was still being built'));
    let timer;
    const bound = new Promise((resolve) => { timer = setTimeout(resolve, SETTLE_MS, 'unsettled'); });
    const outcome = await Promise.race([Promise.all(building.map((build) => build.settled)).then(() => 'settled'), bound]);
    clearTimeout(timer);
    // Newest first: an application is registered after the database it was built on.
    const live = [...registry.live].reverse();
    const closed = await Promise.allSettled(live.map((fixture) => fixture.close()));
    registry.building.clear();
    registry.live.clear();
    const failures = closed.filter((result) => result.status === 'rejected').length;
    process.stderr.write(`[fixture-drain] ${this.label}: ended with ${building.length} fixture build(s) unfinished (${outcome}) and ${live.length} fixture(s) unclosed; `
      + `reclaimed${failures ? `, ${failures} failed to close` : ''}\n`);
  }
}

module.exports = FixtureEnvironment;

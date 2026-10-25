import { Logger } from '@nestjs/common';
import { startIssuer } from './issuer-app';
import { IssuerConfigError, loadIssuerEnv } from './issuer-env';
import { IssuerLogger } from './issuer-log';

/**
 * The session issuer's process entry (DATA-01 PR A): `node dist/issuer/main.js`, from the same image as the API and the worker. It is not a Nest
 * application. It loads its own settings, wires the issuer core to its HTTP server and the issuer login's pool, and nothing else: in particular not the
 * API's pool or configuration (a test pins the list of files it may load). Its only environment access is the line below.
 *
 * Stopping: SIGTERM stops accepting, lets requests in flight finish for up to DRAIN_GRACE_MS, closes the pool and exits 0. ECS waits 30 s (issuer.tf stopTimeout),
 * so a hard exit follows at HARD_EXIT_MS if anything hangs.
 */
const DRAIN_GRACE_MS = 20_000;
const HARD_EXIT_MS = 28_000;

Logger.overrideLogger(new IssuerLogger());
const logger = new Logger('IssuerProcess');

/** A name or a code, never a message: an error from the network or the database layer can carry an address. */
const describe = (error: unknown): string =>
  error instanceof IssuerConfigError
    ? error.message
    : `${(error as { code?: unknown })?.code ?? (error as Error)?.name ?? 'Error'}`.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64) || 'Error';

async function main(): Promise<void> {
  const config = loadIssuerEnv(process.env);
  const issuer = await startIssuer(config);
  logger.log(`Session issuer listening on port ${issuer.port}`);

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.log(`Session issuer stopping (${signal})`);
    setTimeout(() => process.exit(1), HARD_EXIT_MS).unref();
    issuer.stop(DRAIN_GRACE_MS).then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error(`Session issuer stop failed: ${describe(error)}`);
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (error: unknown) => {
    logger.fatal(`Session issuer failed: ${event} (${describe(error)})`);
    process.exit(1);
  });
}

main().catch((error: unknown) => {
  // A start-up refusal names the setting that is wrong (issuer-env.ts), never a value.
  process.stderr.write(`session issuer failed to start: ${describe(error)}\n`);
  process.exit(1);
});

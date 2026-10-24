import type { Server } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Nest's own `close()` runs `onModuleDestroy` BEFORE it closes the HTTP server, and the database pool is ended in `onModuleDestroy`, so a request still running when the
 * signal arrived lost its pool under it. This stops in the other order: wait a short while (the load balancer takes a moment to stop sending to a task it is draining),
 * stop accepting, let requests in flight finish up to a cap, and only then close the app (which ends the pool). A deadline below ECS's stop timeout (30 s, api-compute.tf)
 * ends the process with exit 1 if the close itself hangs, instead of waiting for SIGKILL. api-compute.guard.test.mjs requires pause + drain + margin to stay under it.
 */
export const SHUTDOWN_PAUSE_MS = 5_000;
export const SHUTDOWN_DRAIN_MS = 20_000;
export const SHUTDOWN_DEADLINE_MS = SHUTDOWN_PAUSE_MS + SHUTDOWN_DRAIN_MS + 4_000;

export interface SignalTarget {
  once(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
}

export interface GracefulShutdownOptions {
  pauseMs?: number;
  drainMs?: number;
  deadlineMs?: number;
  target?: SignalTarget;
  exit?: (code: number) => void;
  /** One JSON line each; fixed fields only, never a request or an error message. */
  write?: (line: string) => void;
}

export function installGracefulShutdown(app: Pick<NestExpressApplication, 'close'>, server: Server, options: GracefulShutdownOptions = {}): void {
  const pauseMs = options.pauseMs ?? SHUTDOWN_PAUSE_MS;
  const drainMs = options.drainMs ?? SHUTDOWN_DRAIN_MS;
  const deadlineMs = options.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
  const target = options.target ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const say = (event: string, reason?: string) => {
    try {
      write(JSON.stringify({ time: Date.now(), level: event === 'shutdown-forced' ? 'error' : 'info', service: 'api', event, ...(reason ? { reason } : {}) }));
    } catch {
      // nothing left to report to
    }
  };

  let started = false;
  const shutdown = async (signal: 'SIGTERM' | 'SIGINT') => {
    if (started) return;
    started = true;
    say('shutdown-requested', signal);
    const deadline = setTimeout(() => {
      say('shutdown-forced', signal);
      exit(1);
    }, deadlineMs);
    deadline.unref();
    try {
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
      const cut = await drain(server, drainMs);
      if (cut) say('shutdown-drain-cut');
      await app.close();
      clearTimeout(deadline);
      exit(0);
    } catch {
      say('shutdown-forced', signal);
      exit(1);
    }
  };
  target.once('SIGTERM', () => void shutdown('SIGTERM'));
  target.once('SIGINT', () => void shutdown('SIGINT'));
}

/** Stops accepting, lets requests in flight finish, and after `graceMs` cuts what is left. Resolves true when it had to cut something. */
function drain(server: Server, graceMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let cut = false;
    const timer = setTimeout(() => {
      cut = true;
      server.closeAllConnections();
    }, graceMs);
    if (!server.listening) {
      clearTimeout(timer);
      resolve(false);
      return;
    }
    server.close(() => {
      clearTimeout(timer);
      resolve(cut);
    });
    server.closeIdleConnections();
  });
}

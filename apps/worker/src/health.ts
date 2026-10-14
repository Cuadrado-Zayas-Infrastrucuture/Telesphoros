import { createServer, type Server } from 'node:http';
import type { Runner } from './runner';

/**
 * `GET /livez`: 200 while the claim loop has gone round recently (it goes round at least once per poll interval, and a stuck database call shows here).
 * `GET /readyz`: 200 until a stop signal arrives. The body is a few counts, never a job, an organization or a payload. Bound to loopback by default: the
 * container's own health check reaches it, nothing else does.
 */
export function startHealthServer(runner: Runner, options: { host: string; port: number; staleAfterMs: number }): Promise<Server> {
  const server = createServer((req, res) => {
    const alive = runner.lastLoopAt > 0 && Date.now() - runner.lastLoopAt < options.staleAfterMs;
    const body = (ok: boolean) => JSON.stringify({ status: ok ? 'ok' : 'unavailable', running: runner.activeCount, stopping: runner.isStopping });
    let ok: boolean | undefined;
    if (req.method === 'GET' && req.url === '/livez') ok = alive;
    else if (req.method === 'GET' && req.url === '/readyz') ok = alive && !runner.isStopping;
    if (ok === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body(ok));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolve(server));
  });
}

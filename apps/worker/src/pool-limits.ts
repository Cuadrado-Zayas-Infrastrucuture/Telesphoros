/**
 * The limits on the worker's database pool. The worker runs batch queries (claim, relay, schedule, stats, the upload sweep), so its statement limit is longer
 * than the API's 5 s (database.ts); the other three match the API and the issuer. Without them a database that stops answering would hold a claim, a ticker or a
 * shutdown for ever.
 *
 * `statement_timeout` and `idle_in_transaction_session_timeout` are enforced by PostgreSQL. `query_timeout` is the client's own limit, a little longer, so a
 * query on a connection the server can no longer reach (a half-open socket, which the server-side limit cannot cancel) still ends.
 */
export const WORKER_POOL_LIMITS = {
  connectionTimeoutMillis: 2_000,
  statement_timeout: 10_000,
  query_timeout: 12_000,
  idle_in_transaction_session_timeout: 10_000,
} as const;

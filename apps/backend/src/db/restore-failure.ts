/**
 * What the operator is told when the restore fails. The command's own text is not passed through: PostgreSQL's errors from loading data quote
 * the offending key (`DETAIL: Key (tenant_id, label)=(...) already exists.`) and the COPY context quotes the row, and this text goes to the
 * terminal, to the drill's or job's log and into the restore report. The server's own log has the full message, which is the place for it.
 *
 * Only these are kept: the exit code, the name of the table whose data was being loaded, and, for a failure while creating objects, the first
 * error line (schema text: the `Command was:`, `DETAIL:` and `CONTEXT:` lines are dropped). Errors that did not come from `pg_restore`
 * (the verification step's own) are client messages without the DETAIL text and keep the old 300-character bound.
 */
const FAILED = /^pg_restore exited with code (\d+):/;
/** `pg_restore: from TOC entry 3290; 0 17234 TABLE DATA patients telesphoros_owner`: the entry that was loading a table's rows when it failed. */
const DATA_ENTRY = /^pg_restore: from TOC entry \d+; \d+ \d+ TABLE DATA (\S+)/m;
const COPY_FAILED = /^pg_restore: error: COPY failed for table "([^"]+)"/m;
const ERROR_LINE = /^pg_restore: error: .*$/m;
const MAX_LINE = 200;

export function describeRestoreFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const failed = FAILED.exec(message);
  if (!failed) return message.slice(0, 300);
  const prefix = `pg_restore exited with code ${failed[1]}`;
  const stderr = message.slice(failed[0].length).trimStart(); // `pg_restore exited with code 1: pg_restore: error: ...`: the first line starts after a space
  const copy = COPY_FAILED.exec(stderr);
  const entry = DATA_ENTRY.exec(stderr);
  if (copy !== null || entry !== null) {
    const table = copy?.[1] ?? entry?.[1];
    return `${prefix}: failed while loading data${table ? ` for table "${table}"` : ''}; the database's message is withheld because it can quote row values (the target server's log has it)`;
  }
  const line = ERROR_LINE.exec(stderr)?.[0];
  return line ? `${prefix}: ${line.slice('pg_restore: error: '.length, MAX_LINE)}` : `${prefix} (no error line was reported)`;
}

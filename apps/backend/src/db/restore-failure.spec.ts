import { describeRestoreFailure } from './restore-failure';

const failure = (stderr: string, code = 1) => new Error(`pg_restore exited with code ${code}: ${stderr}`);
const VALUES = ['tenant-leakmark', 'SYN-LEAKMARK-4242', '27dd3760'];
const noValues = (text: string) => VALUES.every((v) => !text.includes(v));

const COPY_FAILURE = `pg_restore: error: COPY failed for table "patients": ERROR:  duplicate key value violates unique constraint "patients_label_uq"
DETAIL:  Key (tenant_id, label)=(tenant-leakmark, SYN-LEAKMARK-4242) already exists.
CONTEXT:  PL/pgSQL function public.leakprobe_refuse() line 2 at RAISE
COPY patients, line 1: "1\t27dd3760-aebe-48ad-b364-ea6af77c716e\ttenant-leakmark\tSYN-LEAKMARK-4242\t2026-10-23 11:24:29.720035-..."`;

describe('describeRestoreFailure', () => {
  it('names the table of a failed data load and withholds the database message (the key and the row)', () => {
    const text = describeRestoreFailure(failure(COPY_FAILURE));
    expect(text).toBe(
      `pg_restore exited with code 1: failed while loading data for table "patients"; the database's message is withheld because it can quote row values (the target server's log has it)`,
    );
    expect(noValues(text)).toBe(true);
  });

  it('treats a TABLE DATA entry that fails with a query error (INSERT form) the same way, naming the table from the entry', () => {
    const text = describeRestoreFailure(
      failure(`pg_restore: while PROCESSING TOC:
pg_restore: from TOC entry 3290; 0 17234 TABLE DATA patients telesphoros_owner
pg_restore: error: could not execute query: ERROR:  invalid input syntax for type uuid: "tenant-leakmark"
Command was: INSERT INTO public.patients VALUES ('tenant-leakmark', 'SYN-LEAKMARK-4242');`),
    );
    expect(text).toContain('failed while loading data for table "patients"');
    expect(noValues(text)).toBe(true);
    expect(text).not.toMatch(/Command was|INSERT|invalid input/);
  });

  it('keeps only the first error line of a failure while creating objects', () => {
    const text = describeRestoreFailure(
      failure(`pg_restore: while PROCESSING TOC:
pg_restore: from TOC entry 217; 1259 16397 TABLE patients postgres
pg_restore: error: could not execute query: ERROR:  relation "patients" already exists
Command was: CREATE TABLE public.patients (
    id uuid NOT NULL
);`),
    );
    expect(text).toBe('pg_restore exited with code 1: could not execute query: ERROR:  relation "patients" already exists');
  });

  it('bounds a very long first line', () => {
    const text = describeRestoreFailure(failure(`pg_restore: error: ${'x'.repeat(5000)}`));
    expect(text.length).toBeLessThan(260);
  });

  it('keeps the first line of a failure before any entry is processed (file problems), and says so when there is none', () => {
    expect(describeRestoreFailure(failure('pg_restore: error: could not open input file "/tmp/x.dump": No such file or directory'))).toBe(
      'pg_restore exited with code 1: could not open input file "/tmp/x.dump": No such file or directory',
    );
    expect(describeRestoreFailure(failure('', 2))).toBe('pg_restore exited with code 2 (no error line was reported)');
  });

  it('leaves errors that did not come from pg_restore as they were, bounded to 300 characters', () => {
    expect(describeRestoreFailure(new Error('the restored copy has no tenant row'))).toBe('the restored copy has no tenant row');
    expect(describeRestoreFailure(new Error('y'.repeat(900)))).toHaveLength(300);
    expect(describeRestoreFailure('not an error object')).toBe('not an error object');
  });
});
